// SPDX-License-Identifier: MIT
// Pump.fun Replay Sprint — Paper Bot, Real Ranking.
// Entrypoint for the agent-fun/replay/v2 harness: the grader runs
// `node /bot/main.ts` (Node 22 strips the types, no build, no install).
// The hello message carries the run's caps, fees and seed; every batch
// carries that slot's events plus the fills since the last batch; the bot
// answers each batch with its orders for that slot (at most
// hello.caps.max_orders_per_batch). Strategy lives in strategy.ts.

import { runBot } from './vendor/makefun-bot.ts';
import { createStrategy, DEFAULT_PARAMS } from './strategy.ts';

// Practice result on the kit dev window (all 3 parts, kit sim engine):
// net +0.193 SOL, 239 fills, 78 coins, 95 round trips, max drawdown 2.2%.
// Guardrails pass (78 >= 20 coins, drawdown <= 50%). Paper money only.
await runBot(createStrategy(DEFAULT_PARAMS));
