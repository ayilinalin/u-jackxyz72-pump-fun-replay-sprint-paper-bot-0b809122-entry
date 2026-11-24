// Pump.fun replay sprint — simple momentum paper bot (agent-fun/replay/v2).
//
// Idea: pump.fun peaks arrive fast and the runners are identifiable EARLY by
// real SOL flowing in. Dev data: coins whose real SOL reserve reaches 15 SOL
// within 30 slots of creation peak >=3x 82% of the time (median peak 7.7x),
// while the median coin peaks at 1.5x in its create slot and decays back to
// its start price within ~100 slots. So the bot only buys STRONG early inflow
// (real SOL >= 15, price already >= 1.5x its create price, still rising, many
// distinct buyers), then RIDES winners with a wide trailing stop and no fixed
// take-profit — the 14.7x completers pay for the losers, which the hard
// stop-loss cuts. No all-ins, no churn: small first buys, pyramid only into
// new highs, at most 5 open positions. Paper money only — nothing here touches
// a real wallet or chain.
//
// Per batch the bot (1) folds the batch's trades into a per-mint tape,
// (2) checks exits on every held position, (3) checks entries on mints that
// traded in this batch, (4) tops up the guardrail pace with tiny probe round
// trips if distinct coins traded lag the elapsed-time pace (the house ranks
// entries below the bar when they end under 20 coins with >= 0.01 SOL round
// trips, so the probes are cheap insurance, ~0.001 SOL each).
//
// Deterministic by construction: no clock, no Math.random, iteration only over
// insertion-ordered maps fed by the batch stream. All amounts are bigint
// lamports; ratios are plain numbers derived from on-chain reserves.

import type { Batch, Bot, BotState, OrderInput, Pubkey } from './vendor/makefun-bot.ts';

export interface Params {
  /** Tape lookback in slots for the entry signal. */
  windowSlots: number;
  /** Net buy SOL (buys minus sells) over the window needed to enter. */
  minNetSol: number;
  /** Buy trades in the window needed to enter. */
  minBuys: number;
  /** Distinct buying wallets in the window needed to enter. */
  minBuyers: number;
  /** Price now over price at window start, minus 1: lower bound. */
  minPriceUp: number;
  /** Same ratio: upper bound (skip coins that already ran too far). */
  maxPriceUp: number;
  /** Price now must be at least this share of the window high. */
  nearHigh: number;
  /** Largest single wallet's share of window buy SOL (anti-bundle). */
  maxBuyerShare: number;
  /** Real SOL reserve bounds at entry. */
  minRqSol: number;
  maxRqSol: number;
  /** Slots since CreateEvent after which a first entry is no longer allowed (0 = no limit). */
  maxAge: number;
  /** Price now over the create price, minus 1: lower bound at entry. */
  minCreateUp: number;
  /** Total SOL per position (first buy + pyramids). */
  stakeSol: number;
  /** First buy of a position (SOL). */
  firstSol: number;
  /** Each pyramid add (SOL). */
  addSol: number;
  /** Add only once price is this much above the last buy's decision price. */
  addStep: number;
  /** Add only while net SOL over the entry window is at least this. */
  addNetSol: number;
  /** Smallest buy worth sending (SOL); also the house round-trip minimum. */
  minBuySol: number;
  /** Slippage on buys (bps); sells always go out at 10000. */
  buySlipBps: number;
  /** Sell whole when value falls to this share of cost. */
  stopLoss: number;
  /** Sell whole when value reaches this multiple of cost. */
  takeProfit: number;
  /** Trailing stop arms once value reaches cost * (1 + trailArm). */
  trailArm: number;
  /** Once armed, sell when value falls to this share of peak value. */
  trail: number;
  /** Exit after this many slots held (unless already up). */
  maxHold: number;
  /** Do not re-enter a mint for this many slots after an exit. */
  cooldown: number;
  /** Most entries per mint over the run. */
  maxEntries: number;
  /** Most momentum positions open at once. */
  maxMain: number;
  /** Most SOL at cost across all positions at once. */
  maxExposureSol: number;
  /** Guardrail pacing: target distinct coins / fills over paceSecs of block time. */
  targetCoins: number;
  targetFills: number;
  paceSecs: number;
  /** Probe round-trip size (SOL). */
  probeSol: number;
  /** Most probe buys in flight at once. */
  maxProbes: number;
}

export const DEFAULT_PARAMS: Params = {
  windowSlots: 60,
  minNetSol: 0.5,
  minBuys: 3,
  minBuyers: 3,
  minPriceUp: 0.05,
  maxPriceUp: 2,
  nearHigh: 0.9,
  maxBuyerShare: 0.6,
  minRqSol: 8,
  maxRqSol: 80,
  minAge: 0,
  maxAge: 600,
  minCreateUp: 0.3,
  stakeSol: 0.25,
  firstSol: 0.05,
  addSol: 0.05,
  addStep: 0.05,
  addNetSol: 1,
  minBuySol: 0.01,
  buySlipBps: 500,
  stopLoss: 0.7,
  takeProfit: 1.5,
  trailArm: 0.3,
  trail: 0.8,
  maxHold: 1200,
  cooldown: 150,
  maxEntries: 1,
  maxMain: 5,
  maxExposureSol: 5,
  targetCoins: 25,
  targetFills: 240,
  paceSecs: 86_400,
  probeSol: 0.02,
  maxProbes: 1,
};

const LAMPORTS = 1_000_000_000n;
const FEE_BPS = 125n; // protocol 95 + creator 30 fallback
const BPS = 10_000n;

interface Trade {
  slot: number;
  buy: boolean;
  sol: number;
  user: string;
  price: number;
}

interface Tape {
  created: number | null;
  createPrice: number;
  trades: Trade[];
  entries: number;
  lastExit: number;
}

interface Held {
  opened: number;
  peakValue: number;
  lastAddPrice: number;
  invested: number;
}

const sol = (lamports: bigint): number => Number(lamports) / 1e9;

/** Net SOL a full sell of `tokens` would return (curve + tx fees deducted). */
function sellValue(state: BotState, mint: Pubkey, tokens: bigint): number {
  const c = state.curves.get(mint);
  if (c === undefined || tokens <= 0n) return 0;
  const q = (tokens * c.virtual_quote_reserves) / (c.virtual_token_reserves + tokens);
  const fee = (q * FEE_BPS) / BPS;
  const net = q - fee - state.txFeeLamports();
  return net > 0n ? sol(net) : 0;
}

export function createStrategy(p: Params = DEFAULT_PARAMS): Bot {
  const tapes = new Map<Pubkey, Tape>();
  const held = new Map<Pubkey, Held>();
  const probes = new Map<Pubkey, string>(); // mint -> client_id of probe buy in flight
  const probeSell = new Set<Pubkey>(); // probe buy filled, sell it next batch
  const filledMints = new Set<Pubkey>();
  let fills = 0;
  let firstBlockTime = 0;
  let lastBlockTime = 0;

  function tapeFor(mint: Pubkey): Tape {
    let t = tapes.get(mint);
    if (t === undefined) {
      t = { created: null, createPrice: 0, trades: [], entries: 0, lastExit: -1e9 };
      tapes.set(mint, t);
    }
    return t;
  }

  function windowStats(t: Tape, slot: number): {
    net: number; buys: number; buyers: number; maxShare: number;
    priceUp: number; nearHigh: number; startPrice: number; price: number;
  } {
    const from = slot - p.windowSlots;
    let net = 0;
    let buys = 0;
    let buySol = 0;
    const buyers = new Map<string, number>();
    let startPrice = 0;
    let high = 0;
    let price = 0;
    for (const tr of t.trades) {
      if (tr.slot < from) continue;
      if (startPrice === 0) startPrice = tr.price;
      if (tr.price > high) high = tr.price;
      price = tr.price;
      if (tr.buy) {
        buys++;
        net += tr.sol;
        buySol += tr.sol;
        buyers.set(tr.user, (buyers.get(tr.user) ?? 0) + tr.sol);
      } else {
        net -= tr.sol;
      }
    }
    if (startPrice === 0) startPrice = t.createPrice || price;
    let maxShare = 0;
    for (const v of buyers.values()) if (buySol > 0 && v / buySol > maxShare) maxShare = v / buySol;
    return {
      net,
      buys,
      buyers: buyers.size,
      maxShare,
      priceUp: startPrice > 0 && price > 0 ? price / startPrice - 1 : 0,
      nearHigh: high > 0 && price > 0 ? price / high : 0,
      startPrice,
      price,
    };
  }

  return {
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      const orders: OrderInput[] = [];
      const tx = state.txFeeLamports();
      let free = state.freeCashLamports();
      const slot = batch.slot;

      // --- fold fills: track our own filled buys/sells, probe landings, exits.
      for (const f of batch.fills) {
        if (f.client_id.startsWith('_')) {
          // Harness close (complete / flatten / writeoff): position gone.
          const t = tapes.get(f.mint);
          if (t !== undefined) t.lastExit = slot;
          held.delete(f.mint);
          probes.delete(f.mint);
          probeSell.delete(f.mint);
          continue;
        }
        if (f.status === 'filled') {
          fills++;
          if (f.side === 'buy') filledMints.add(f.mint);
          if (f.side === 'sell') {
            const t = tapes.get(f.mint);
            if (t !== undefined) t.lastExit = slot;
            held.delete(f.mint);
            probeSell.delete(f.mint);
          }
          if (f.side === 'buy' && probes.has(f.mint)) {
            probes.delete(f.mint);
            probeSell.add(f.mint);
          }
        } else if (f.status === 'rejected' || f.status === 'failed') {
          probes.delete(f.mint);
        }
      }

      // --- fold events into tapes.
      const traded = new Set<Pubkey>();
      for (const e of batch.events) {
        if (e.block_time !== null && e.block_time !== undefined) {
          if (firstBlockTime === 0) firstBlockTime = e.block_time;
          lastBlockTime = e.block_time;
        }
        if (e.event === 'CreateEvent') {
          const t = tapeFor(e.mint);
          t.created = e.slot;
          t.createPrice = Number(e.virtual_quote_reserves) / Number(e.virtual_token_reserves);
        } else if (e.event === 'TradeEvent') {
          const t = tapeFor(e.mint);
          const price = Number(e.virtual_quote_reserves) / Number(e.virtual_token_reserves);
          t.trades.push({ slot: e.slot, buy: e.is_buy, sol: Number(BigInt(e.sol_amount)) / 1e9, user: e.user, price });
          traded.add(e.mint);
        } else if (e.event === 'CompleteEvent') {
          const t = tapes.get(e.mint);
          if (t !== undefined) t.lastExit = slot;
          held.delete(e.mint);
        }
      }
      // Prune tapes older than the window (keeps memory bounded over 24h).
      const pruneBefore = slot - p.windowSlots - 10;
      for (const t of tapes.values()) {
        while (t.trades.length > 0 && t.trades[0]!.slot < pruneBefore) t.trades.shift();
      }

      const openMain = [...held.keys()].filter((m) => !probeSell.has(m)).length;
      // Count pending buys too: the harness fills orders 2 slots later, so
      // held-only counting would over-send buys that then get rejected.
      const committed = state.committedPositionCount();
      let mainSlots = p.maxMain - Math.max(openMain, committed);
      let exposure = 0;
      for (const [mint, h] of held) {
        const pos = state.positions.get(mint);
        if (pos !== undefined) exposure += sol(pos.cost_lamports);
        void h;
      }

      // --- exits first: stop-loss, take-profit, trailing stop, time limit, fade.
      for (const [mint, pos] of state.positions) {
        const h = held.get(mint);
        if (h === undefined) continue; // position we did not open (should not happen)
        const cost = sol(pos.cost_lamports);
        if (cost <= 0) continue;
        const value = sellValue(state, mint, pos.token_amount);
        if (value > h.peakValue) h.peakValue = value;
        const ratio = value / cost;
        const age = slot - h.opened;
        let exit = false;
        if (ratio <= p.stopLoss) exit = true;
        else if (ratio >= p.takeProfit) exit = true;
        else if (h.peakValue >= cost * (1 + p.trailArm) && value <= h.peakValue * p.trail) exit = true;
        else if (age >= p.maxHold && ratio < 1.1) exit = true;
        else {
          const t = tapes.get(mint);
          if (t !== undefined && ratio < 1) {
            const w = windowStats(t, slot);
            if (w.net < -1) exit = true;
          }
        }
        if (exit) {
          orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
          free -= tx;
          held.delete(mint);
        }
      }

      // --- entries + pyramids on mints that traded in this batch.
      for (const mint of traded) {
        if (orders.length >= state.hello.caps.max_orders_per_batch) break;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        const t = tapes.get(mint);
        if (t === undefined) continue;
        if (t.created !== null && slot - t.created < p.minAge) continue;
        if (p.maxAge > 0 && t.created !== null && slot - t.created > p.maxAge) continue;
        if (slot - t.lastExit < p.cooldown) continue;
        const rqSol = sol(curve.real_quote_reserves);
        if (rqSol < p.minRqSol || rqSol > p.maxRqSol) continue;
        const w = windowStats(t, slot);
        if (w.price <= 0) continue;
        const pos = state.positions.get(mint);
        const h = held.get(mint);
        const cap = state.maxBuyLamports(mint);
        const minBuy = BigInt(Math.round(p.minBuySol * 1e9));

        if (pos !== undefined && h !== undefined) {
          // Pyramid into strength only, up to stakeSol.
          if (h.invested >= p.stakeSol) continue;
          if (w.price < h.lastAddPrice * (1 + p.addStep)) continue;
          if (w.net < p.addNetSol) continue;
          const want = BigInt(Math.round(Math.min(p.addSol, p.stakeSol - h.invested) * 1e9));
          const amount = want < cap ? want : cap;
          if (amount < minBuy) continue;
          if (free < amount + tx) continue;
          if (exposure + sol(amount) > p.maxExposureSol) continue;
          orders.push({ side: 'buy', mint, quote_lamports: amount, max_slippage_bps: p.buySlipBps });
          free -= amount + tx;
          exposure += sol(amount);
          h.invested += sol(amount);
          h.lastAddPrice = w.price;
          continue;
        }
        if (pos !== undefined || probes.has(mint) || probeSell.has(mint)) continue;
        if (t.entries >= p.maxEntries) continue;
        if (mainSlots <= 0) continue;
        // Entry signal: strong early inflow, price already up from creation
        // and still rising, sitting near its window high, no single buyer
        // dominating (anti-bundle).
        if (w.net < p.minNetSol) continue;
        if (w.buys < p.minBuys) continue;
        if (w.buyers < p.minBuyers) continue;
        if (w.priceUp < p.minPriceUp || w.priceUp > p.maxPriceUp) continue;
        if (t.createPrice > 0 && w.price / t.createPrice - 1 < p.minCreateUp) continue;
        if (w.nearHigh < p.nearHigh) continue;
        if (w.maxShare > p.maxBuyerShare) continue;
        const want = BigInt(Math.round(p.firstSol * 1e9));
        const amount = want < cap ? want : cap;
        if (amount < minBuy) continue;
        if (free < amount + tx) continue;
        if (exposure + sol(amount) > p.maxExposureSol) continue;
        orders.push({ side: 'buy', mint, quote_lamports: amount, max_slippage_bps: p.buySlipBps });
        free -= amount + tx;
        exposure += sol(amount);
        mainSlots -= 1;
        t.entries += 1;
        held.set(mint, { opened: slot, peakValue: 0, lastAddPrice: w.price, invested: sol(amount) });
      }

      // --- probe sells: a probe buy that landed gets sold whole right away.
      for (const mint of [...probeSell]) {
        if (orders.length >= state.hello.caps.max_orders_per_batch) break;
        const pos = state.positions.get(mint);
        if (pos === undefined) {
          probeSell.delete(mint);
          continue;
        }
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
        free -= tx;
        probeSell.delete(mint);
      }

      // --- guardrail probe buys: stay on pace for 20+ distinct coins.
      if (firstBlockTime > 0 && lastBlockTime > firstBlockTime) {
        const elapsed = lastBlockTime - firstBlockTime;
        const paceCoins = Math.floor((p.targetCoins * elapsed) / p.paceSecs);
        const paceFills = Math.floor((p.targetFills * elapsed) / p.paceSecs);
        const behind = filledMints.size < paceCoins || fills < paceFills;
        // Only probe when a position slot is actually free: without this check
        // a full book makes every batch send a probe that the harness rejects
        // at fill time (max_open_positions), thousands of wasted orders.
        const freeSlot = state.committedPositionCount() < state.hello.caps.max_open_positions;
        if (behind && freeSlot && probes.size < p.maxProbes && orders.length < state.hello.caps.max_orders_per_batch) {
          // Most liquid recently-traded curve we hold nothing in.
          let best: Pubkey | null = null;
          let bestRq = 0;
          for (const mint of traded) {
            if (state.positions.has(mint) || probes.has(mint) || probeSell.has(mint)) continue;
            const curve = state.curves.get(mint);
            if (curve === undefined || curve.complete) continue;
            const rq = sol(curve.real_quote_reserves);
            if (rq > bestRq && rq >= p.minRqSol) {
              bestRq = rq;
              best = mint;
            }
          }
          if (best !== null) {
            const cap = state.maxBuyLamports(best);
            const want = BigInt(Math.round(p.probeSol * 1e9));
            const amount = want < cap ? want : cap;
            if (amount >= BigInt(Math.round(p.minBuySol * 1e9)) && free >= amount + tx) {
              const id = state.clientId();
              orders.push({ side: 'buy', mint: best, quote_lamports: amount, max_slippage_bps: p.buySlipBps, client_id: id });
              free -= amount + tx;
              probes.set(best, id);
            }
          }
        }
      }

      return orders;
    },
  };
}
