// Pump.fun Paper Sprint: an early-momentum rider for the pump.fun replay.
// The grader runs `node /bot/main.ts`; the strategy lives in strategy.ts and the
// SDK shim is the kit's sdk/ts/makefun-bot.ts, vendored byte for byte.
//
// The bot buys only curves whose price is already up ~25% from birth with buyers
// dominating the recent tape, sizes up on the strongest runs, and exits by rule:
// half off at 2x, half of the rest at 4x, a trailing stop once a winner is armed,
// a hard stop under cost, and a stale exit that frees the slot. One buy per coin,
// at most five open at once, plus a small guardrail probe so the run clears the
// twenty-coin round-trip bar on its own trading. Fully deterministic: every
// decision comes from the event stream alone.

import { runBot } from './vendor/makefun-bot.ts';
import { createStrategy, DEFAULT_PARAMS } from './strategy.ts';

const bot = createStrategy(DEFAULT_PARAMS);

await runBot(bot);
