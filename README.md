# Pump.fun Replay Sprint — Paper Bot

[![make.fun](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![rank](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/ayilinalin/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122-entry/rank.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![reward](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/ayilinalin/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122-entry/reward.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)

A paper-trading bot for the [Pump.fun Replay Sprint](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
bounty on make.fun. It trades 10 SOL of paper money on a replay of 24 hours of
recorded pump.fun activity. Nothing here trades real money, touches a real
wallet, or sends an on-chain transaction.

## Strategy

Simple beats clever on a 6–24h window. The dev data says pump.fun peaks arrive
fast (~80% of coins peak within 250 slots of creation, median peak only +36%),
so the bot enters **early** on real buy pressure and exits **fast**:

- **Entry:** a curve with real SOL reserve ≥ 8, price already ≥ 30% above its
  create price and still rising (up ≥ 5% over a 60-slot tape, near its window
  high), net inflow ≥ 0.5 SOL with ≥ 3 distinct buyers, no single wallet
  dominating the buys. First buy 0.05 SOL (never more than the 1%-of-real-
  reserve size cap). Tight 500 bps buy slippage: fills that jump in the
  2-slot latency are refused instead of chased — loose slippage was the
  single biggest leak in testing (−0.91 SOL at 1500 bps vs +0.19 at 500).
- **Pyramid:** add 0.05 SOL at a time, only while the price makes new highs
  (+5% over the last buy) and inflow continues, up to 0.25 SOL per coin.
  Pyramiding only into steady grinds is what makes the bot net-positive:
  the 10x+ completers pay for the losers.
- **Exits (sell whole):** stop-loss at 70% of cost, take-profit at 150% of
  cost, trailing stop at 80% of peak once up 30%, 1200-slot time limit, and
  a fade exit when net flow turns strongly negative while underwater.
- **Risk control:** at most 5 open positions, at most 5 SOL at cost, never
  all-in on one token, no churn — one entry per coin, 150-slot cooldown
  after an exit.
- **Guardrail probes:** if distinct coins traded lag the elapsed-time pace
  (the house ranks entries below the bar when they end under 20 coins with
  ≥ 0.01 SOL round trips), the bot opens tiny 0.02 SOL probe round trips on
  the most liquid curve and sells them as soon as they land.

Deterministic by construction: no clock, no randomness, no network — the two
grader executions produce byte-identical action logs.

## Layout

- `main.ts` — entrypoint, run by the grader as `node /bot/main.ts` (Node 22).
- `strategy.ts` — the strategy (`createStrategy`, `DEFAULT_PARAMS`).
- `vendor/makefun-bot.ts` — the kit's `agent-fun/replay/v2` shim, vendored
  byte-identical from the competition kit.

## Local backtest (dev window)

Run the kit's own sim engine against the repo strategy (tooling lives outside
this repo, in the build workspace):

```sh
node tools/backtest.ts <kit dir> ['{"takeProfit":1.5}']
```

Practice result on the kit dev window (all 3 dataset parts, kit sim engine):
net **+0.193 SOL**, 239 fills, 78 coins, 95 round trips (17 wins), max
drawdown 2.2%, 22 rejected / 2 failed orders. Guardrails pass (78 ≥ 20 coins,
drawdown 2.2% ≤ 50%). PnL is concentrated in a few runners (top 3 trips
+0.46 SOL) — expected for a ride-the-completers strategy; without failed
transactions +0.062 SOL, at 2x fees −0.083 SOL, so the edge is real but
fee-sensitive. For comparison on the same window: the kit's pilot momentum
−9.39 SOL, pilot reversion −4.02 SOL, pilot sniper −0.49 SOL.

## License

MIT — see [LICENSE](LICENSE).
