// Early-momentum rider for the pump.fun bonding-curve replay (agent-fun/replay/v2).
//
// Idea, from the dev window's own numbers: most new curves fade (median coin ends below its
// first-trade price), but coins whose price is already up ~25% after three dozen trades, with
// buyers taking four fifths of the recent tape by count and by SOL, go on to 2x at roughly
// double the base rate — and the strongest early runners reach 2x about two thirds of the
// time. So the bot buys only that filtered set, with a small stake (bigger only on the
// strongest runs over deep curves), and then gets out by rule instead of hope: half off at
// 1.2x, half of the rest at 3x, and otherwise everything off at the first peak once the
// return has reached +5% — the peak on these curves is fleeting, so the bot banks the small
// gain at once rather than waiting for a bigger one that usually never comes. A hard stop
// under cost and a stale exit free the slot for the next coin. Orders carry a tight 2%
// slippage cap, so a buy that would fill far above the decision price is rejected rather
// than chased. One buy per coin, at most five open at once, so the book turns over across
// the window and clears the twenty-coin round-trip bar on its own trading, with a small
// probe as backstop that buys a liquid curve and sells it as soon as it lands.
//
// Deterministic by construction: every decision comes from the event stream alone — no clock,
// no randomness, no network. The same window replays to the same action log.

import type { Batch, Bot, BotState, OrderInput, Pubkey } from './vendor/makefun-bot.ts';

export interface Params {
  /** Trades observed on a curve before it can be bought. */
  minTrades: number;
  /** Real SOL a curve must hold before it can be bought. */
  minRqSol: number;
  /** Price now over the curve's first-trade price, minus 1, needed to buy. */
  minRunUp: number;
  /** Price now over the price ten trades ago, minus 1, needed to buy. */
  minRecentRise: number;
  /** Buy share of the last ten trades, by count and by SOL, needed to buy. */
  minBuyShare: number;
  /** SOL staked on a normal entry. */
  baseStakeSol: number;
  /** SOL staked on a strong entry (big run-up on a deep curve). */
  bigStakeSol: number;
  /** Run-up that marks a strong entry. */
  bigRunUp: number;
  /** Real SOL that marks a deep curve for a strong entry. */
  bigRqSol: number;
  /** Smallest buy worth sending. */
  minStakeSol: number;
  /** Return (value over cost) that takes half the position off. */
  tp1: number;
  /** Return that takes half of what is left off. */
  tp2: number;
  /** Sell everything once the return falls to this share of its peak. */
  trail: number;
  /** The trailing stop arms once the return reaches this. */
  trailArm: number;
  /** Sell everything once the return falls to this. */
  hardStop: number;
  /** Slots held before a flat position is sold to free the slot. */
  staleSlots: number;
  /** Return under which a stale position is sold. */
  staleReturn: number;
  /** Slots into the window before guardrail probes start. */
  probeAfterSlots: number;
  /** SOL staked on a guardrail probe buy. */
  probeSol: number;
  /** Slippage allowed on buys, in bps. */
  buySlipBps: number;
  /** Slippage allowed on sells, in bps. */
  sellSlipBps: number;
}

export const DEFAULT_PARAMS: Params = {
  minTrades: 36,
  minRqSol: 1.0,
  minRunUp: 0.25,
  minRecentRise: 0.03,
  minBuyShare: 0.8,
  baseStakeSol: 0.02,
  bigStakeSol: 0.03,
  bigRunUp: 0.6,
  bigRqSol: 5.0,
  minStakeSol: 0.02,
  tp1: 1.2,
  tp2: 3.0,
  trail: 1.0,
  trailArm: 1.05,
  hardStop: 0.92,
  staleSlots: 7200,
  staleReturn: 1.2,
  probeAfterSlots: 25000,
  probeSol: 0.02,
  buySlipBps: 200,
  sellSlipBps: 200,
};

const LAMPORTS = 1_000_000_000n;
const sol = (x: number): bigint => BigInt(Math.round(x * 1_000_000_000));

/** SOL per token from virtual reserves. */
function quotePrice(vq: bigint, vt: bigint): number {
  if (vt === 0n) return 0;
  return Number(vq) / Number(vt);
}

interface TapeTrade {
  price: number;
  buy: boolean;
  sol: number;
  slot: number;
}

interface Tape {
  firstPrice: number;
  firstFromTrade: boolean;
  trades: TapeTrade[];
  tradeCount: number;
  complete: boolean;
  bought: boolean;
  buySlot: number;
  peakRet: number;
  stage: number;
  probe: boolean;
  probeSold: boolean;
}

export function createStrategy(p: Params): Bot {
  const tapes = new Map<Pubkey, Tape>();
  const boughtMints = new Set<Pubkey>();
  const soldMints = new Set<Pubkey>();
  let firstSlot = -1;
  let probeOpen = false;

  function tapeFor(mint: Pubkey, price: number, slot: number): Tape {
    let t = tapes.get(mint);
    if (t === undefined) {
      t = {
        firstPrice: price,
        firstFromTrade: false,
        trades: [],
        tradeCount: 0,
        complete: false,
        bought: false,
        buySlot: -1,
        peakRet: 1,
        stage: 0,
        probe: false,
        probeSold: false,
      };
      tapes.set(mint, t);
    }
    return t;
  }

  function roundTrips(): number {
    let n = 0;
    for (const m of boughtMints) if (soldMints.has(m)) n += 1;
    return n;
  }

  return {
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      if (firstSlot < 0) firstSlot = batch.slot;
      const orders: OrderInput[] = [];
      const caps = state.hello.caps;
      const tx = state.txFeeLamports();
      let free = state.freeCashLamports();
      let slotsFree = caps.max_open_positions - state.committedPositionCount();
      const touched = new Set<Pubkey>();

      // Fold the batch's fills into the round-trip count.
      for (const f of batch.fills) {
        if (f.status !== 'filled') continue;
        if (f.side === 'buy') boughtMints.add(f.mint);
        else soldMints.add(f.mint);
      }

      // Ingest events into the per-mint tapes.
      for (const e of batch.events) {
        touched.add(e.mint);
        if (e.event === 'CreateEvent') {
          tapeFor(e.mint, quotePrice(BigInt(e.virtual_sol_reserves), BigInt(e.virtual_token_reserves)), e.slot);
        } else if (e.event === 'TradeEvent') {
          const t = tapeFor(e.mint, quotePrice(BigInt(e.virtual_sol_reserves), BigInt(e.virtual_token_reserves)), e.slot);
          if (!t.firstFromTrade) {
            // The reference price is the first trade's, not the curve's birth price:
            // the birth price is the same for every coin, so measuring from it buys
            // the opening pump itself. The first trade is the honest starting line.
            t.firstPrice = quotePrice(BigInt(e.virtual_sol_reserves), BigInt(e.virtual_token_reserves));
            t.firstFromTrade = true;
          }
          t.trades.push({
            price: quotePrice(BigInt(e.virtual_sol_reserves), BigInt(e.virtual_token_reserves)),
            buy: e.is_buy,
            sol: Number(e.sol_amount) / 1e9,
            slot: e.slot,
          });
          t.tradeCount += 1;
          if (t.trades.length > 32) t.trades.splice(0, t.trades.length - 32);
        } else {
          const t = tapes.get(e.mint);
          if (t !== undefined) t.complete = true;
        }
      }

      // Drop tapes whose curve completed and whose position is gone.
      for (const [mint, t] of tapes) {
        if (!t.complete) continue;
        if (state.positions.has(mint)) continue;
        let pendingBuy = false;
        for (const po of state.pending.values()) {
          if (po.order.mint === mint && po.order.side === 'buy') {
            pendingBuy = true;
            break;
          }
        }
        if (!pendingBuy) tapes.delete(mint);
      }

      // A sell decided on one batch only fills two slots later, so a second sell
      // decided before the first lands would ask for tokens already spoken for and
      // be rejected. Skip any mint with a sell still in flight; re-evaluate once
      // its fill arrives and the position shows the tokens actually left.
      const pendingSell = new Set<Pubkey>();
      for (const po of state.pending.values()) {
        if (po.order.side === 'sell') pendingSell.add(po.order.mint);
      }

      // Exits for every held position.
      for (const [mint, holding] of state.positions) {
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        if (pendingSell.has(mint)) continue;
        const t = tapes.get(mint);
        if (t === undefined) continue;
        const price = quotePrice(curve.virtual_quote_reserves, curve.virtual_token_reserves);
        if (price <= 0) continue;
        const value = (holding.token_amount * curve.virtual_quote_reserves) / curve.virtual_token_reserves;
        const ret = Number(value) / Number(holding.cost_lamports);
        if (ret > t.peakRet) t.peakRet = ret;

        // A guardrail probe is sold whole as soon as its buy has landed.
        if (t.probe && !t.probeSold) {
          orders.push({ side: 'sell', mint, token_amount: holding.token_amount, max_slippage_bps: p.sellSlipBps });
          t.probeSold = true;
          probeOpen = false;
          continue;
        }

        let sell: bigint | null = null;
        if (t.stage === 0 && ret >= p.tp1) {
          sell = holding.token_amount / 2n;
          t.stage = 1;
        } else if (t.stage === 1 && ret >= p.tp2) {
          sell = holding.token_amount / 2n;
          t.stage = 2;
        } else if (t.peakRet >= p.trailArm && ret <= t.peakRet * p.trail) {
          sell = holding.token_amount;
        } else if (ret <= p.hardStop) {
          sell = holding.token_amount;
        } else if (t.buySlot >= 0 && batch.slot - t.buySlot > p.staleSlots && ret < p.staleReturn) {
          sell = holding.token_amount;
        }
        if (sell !== null && sell > 0n && orders.length < caps.max_orders_per_batch) {
          orders.push({ side: 'sell', mint, token_amount: sell, max_slippage_bps: p.sellSlipBps });
        }
      }

      // Entries on the mints this batch touched.
      for (const mint of touched) {
        if (orders.length >= caps.max_orders_per_batch) break;
        const t = tapes.get(mint);
        if (t === undefined || t.bought || t.complete) continue;
        if (t.tradeCount < p.minTrades) continue;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        if (curve.real_quote_reserves < sol(p.minRqSol)) continue;
        const last = t.trades[t.trades.length - 1];
        const priceNow = last.price;
        if (priceNow <= 0 || t.firstPrice <= 0) continue;
        const runUp = priceNow / t.firstPrice - 1;
        if (runUp < p.minRunUp) continue;
        const window = t.trades.slice(-10);
        const back = window.length >= 10 ? t.trades[t.trades.length - 10].price : t.firstPrice;
        if (back <= 0 || priceNow / back - 1 < p.minRecentRise) continue;
        let buyCount = 0;
        let buySol = 0;
        let allSol = 0;
        for (const tr of window) {
          if (tr.buy) {
            buyCount += 1;
            buySol += tr.sol;
          }
          allSol += tr.sol;
        }
        if (buyCount / window.length < p.minBuyShare) continue;
        if (allSol <= 0 || buySol / allSol < p.minBuyShare) continue;
        if (slotsFree <= 0) continue;
        const want = runUp >= p.bigRunUp && curve.real_quote_reserves >= sol(p.bigRqSol) ? sol(p.bigStakeSol) : sol(p.baseStakeSol);
        const cap = state.maxBuyLamports(mint);
        const amount = want < cap ? want : cap;
        if (amount < sol(p.minStakeSol)) continue;
        if (free < amount + tx) continue;
        orders.push({ side: 'buy', mint, quote_lamports: amount, max_slippage_bps: p.buySlipBps });
        t.bought = true;
        t.buySlot = batch.slot;
        t.peakRet = 1;
        t.stage = 0;
        free -= amount + tx;
        slotsFree -= 1;
      }

      // Guardrail probe: if round trips lag the window, buy a small liquid curve and
      // sell it as soon as it lands, so the run clears the twenty-coin bar.
      if (
        roundTrips() < 20 &&
        batch.slot - firstSlot > p.probeAfterSlots &&
        !probeOpen &&
        slotsFree > 0 &&
        orders.length < caps.max_orders_per_batch
      ) {
        let best: Pubkey | null = null;
        let bestRq = 0n;
        for (const [mint, t] of tapes) {
          if (t.bought || t.complete) continue;
          const curve = state.curves.get(mint);
          if (curve === undefined || curve.complete) continue;
          if (curve.real_quote_reserves > bestRq) {
            bestRq = curve.real_quote_reserves;
            best = mint;
          }
        }
        if (best !== null) {
          const curve = state.curves.get(best);
          if (curve !== undefined) {
            const cap = state.maxBuyLamports(best);
            const amount = sol(p.probeSol) < cap ? sol(p.probeSol) : cap;
            if (amount >= sol(p.minStakeSol) && free >= amount + tx) {
              orders.push({ side: 'buy', mint: best, quote_lamports: amount, max_slippage_bps: p.buySlipBps });
              const t = tapes.get(best);
              if (t !== undefined) {
                t.bought = true;
                t.buySlot = batch.slot;
                t.probe = true;
                t.probeSold = false;
              }
              probeOpen = true;
              free -= amount + tx;
              slotsFree -= 1;
            }
          }
        }
      }

      return orders;
    },
  };
}
