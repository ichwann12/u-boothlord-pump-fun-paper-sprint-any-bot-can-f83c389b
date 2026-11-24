// Pump.fun Paper Sprint — fresh-launch flipper (agent-fun/replay/v2).
//
// Strategy, in one paragraph: every coin is judged in its first seconds of
// life and never again. A coin becomes a buy only while it is at most
// MAX_AGE_SLOTS old, once its curve already holds MIN_RQ_SOL of real SOL,
// and only if it passes a light rug filter: the creator's own buy in the
// create slot is at most MAX_DEV_BUY_SOL, the creator has not sold, and no
// more than MAX_OPEN_BUYERS distinct non-creator wallets have bought yet (a
// launch bundled by many wallets in its first slots is usually the creator's
// cluster waiting to dump). The buy is min(1% of real reserves, STAKE_SOL),
// so each position is tiny. It is sold whole on the first of: +TP% over cost,
// -SL% under cost, MAX_HOLD_SLOTS held, or the creator selling while held.
//
// Why this shape: on a 6-hour window most pump.fun coins bleed to zero and a
// few run hard in their first minute. Buying later means buying the top, so
// this bot buys at the launch and flips within seconds. Stakes are tiny and
// one-shot per coin, so a bad window costs little (small drawdown), while a
// window with a few runners still catches them. Dev-window PnL is a single
// sample, not a promise for the fresh final window — the final 6 hours are
// different coins on a different day.
//
// Determinism: no clock, no randomness, no network. All state lives in
// insertion-ordered Maps fed by the batch stream, and every iteration follows
// that order, so two runs on the same data emit byte-identical action logs.

import { LAMPORTS_PER_SOL, runBot, type Batch, type BotState, type OrderInput, type Pubkey } from './vendor/makefun-bot.ts';

const LAMPORTS = 1_000_000_000; // lamports per SOL, as a float for price math
const CURVE_FEE = 0.0125; // protocol 95 bps + creator 30 bps fallback

// --- tunables -------------------------------------------------------------
const STAKE_SOL = 0.05; // SOL to aim for per coin (the 1%-of-reserve cap usually binds first)
const MIN_BUY_SOL = 0.012; // never send a buy smaller than this (round trips must clear 0.01 SOL)
const BUY_SLIP_BPS = 10_000; // buys go out wide open: launch prices jump in the 2-slot latency
const SELL_SLIP_BPS = 10_000; // sells always go out wide open
const MAX_AGE_SLOTS = 10; // oldest age (slots since CreateEvent) at which a first buy may be decided
const MIN_RQ_SOL = 0.3; // real SOL reserves at decision time: at least this
const MAX_RQ_SOL = 30; // ... and at most this
const MAX_DEV_BUY_SOL = 1.0; // creator's own buys in the create slot: at most this
const MAX_OPEN_BUYERS = 3; // distinct non-creator buyers seen: at most this (anti-bundle)
const TAKE_PROFIT = 0.15; // sell when value >= cost * (1 + TAKE_PROFIT)
const STOP_LOSS = 0.08; // sell when value < cost * (1 - STOP_LOSS)
const MAX_HOLD_SLOTS = 20; // sell after this many slots held, whatever the price

// --- per-coin launch record -------------------------------------------------
interface Launch {
  created: number; // slot of the CreateEvent
  creator: Pubkey;
  devBuy: number; // SOL the creator bought in the create slot
  devSold: boolean; // the creator has sold any amount
  buyers: Set<Pubkey>; // distinct non-creator buyers seen
  decided: boolean; // bought, filtered out, or aged out — never considered again
}

interface Held {
  opened: number; // slot the position was opened (first buy decided)
}

const launches = new Map<Pubkey, Launch>();
const held = new Map<Pubkey, Held>();

/** Close value of a position in SOL: what selling all its tokens returns now. */
function closeValue(tokens: bigint, vq: bigint, vt: bigint, txSol: number): number {
  const n = Number(tokens);
  if (n <= 0 || vt === 0n) return 0;
  const gross = (n * Number(vq)) / (Number(vt) + n) / LAMPORTS;
  return gross * (1 - CURVE_FEE) - txSol;
}

await runBot({
  onBatch(state: BotState, batch: Batch): OrderInput[] {
    const now = batch.slot;
    const txSol = Number(state.txFeeLamports()) / LAMPORTS;
    const cap = state.hello.caps.max_orders_per_batch;

    // Fold this batch's events into the launch records. Only coins touched
    // this batch can change state, so entries only look at those.
    const touched = new Set<Pubkey>();
    for (const e of batch.events) {
      if (e.event === 'CreateEvent') {
        launches.set(e.mint, {
          created: e.slot,
          creator: e.creator,
          devBuy: 0,
          devSold: false,
          buyers: new Set(),
          decided: false,
        });
        touched.add(e.mint);
      } else if (e.event === 'TradeEvent') {
        const l = launches.get(e.mint);
        if (l === undefined) continue;
        touched.add(e.mint);
        const sol = Number(e.sol_amount) / LAMPORTS;
        if (e.is_buy) {
          if (e.user === l.creator) {
            if (e.slot === l.created) l.devBuy += sol;
          } else {
            l.buyers.add(e.user);
          }
        } else if (e.user === l.creator) {
          l.devSold = true;
        }
      } else {
        // CompleteEvent: the curve's tradable life is over.
        const l = launches.get(e.mint);
        if (l !== undefined) l.decided = true;
      }
    }

    const orders: OrderInput[] = [];
    const pendingByMint = new Map<Pubkey, number>();
    for (const po of state.pending.values()) {
      pendingByMint.set(po.order.mint, (pendingByMint.get(po.order.mint) ?? 0) + 1);
    }

    // --- exits first: every held position is checked against its exits. ---
    for (const [mint, h] of held) {
      const pos = state.positions.get(mint);
      const curve = state.curves.get(mint);
      if (pos === undefined) {
        // Position gone (sold, completed, or flattened): forget it unless an
        // order on it is still in flight.
        if (!pendingByMint.has(mint)) held.delete(mint);
        continue;
      }
      if (curve === undefined || curve.complete) continue;
      const value = closeValue(
        BigInt(pos.token_amount),
        curve.virtual_quote_reserves,
        curve.virtual_token_reserves,
        txSol,
      );
      const cost = Number(pos.cost_lamports) / LAMPORTS;
      const launch = launches.get(mint);
      let exit = false;
      if (value >= cost * (1 + TAKE_PROFIT)) exit = true;
      if (!exit && value < cost * (1 - STOP_LOSS)) exit = true;
      if (!exit && now - h.opened > MAX_HOLD_SLOTS) exit = true;
      if (!exit && launch !== undefined && launch.devSold) exit = true;
      if (!exit) continue;
      // Don't stack a second sell while one is already in flight.
      let sellPending = false;
      for (const po of state.pending.values()) {
        if (po.order.mint === mint && po.order.side === 'sell') sellPending = true;
      }
      if (sellPending) continue;
      if (orders.length >= cap) break;
      orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: SELL_SLIP_BPS });
    }

    // --- entries: launches touched this batch, in batch order. ---
    let free = Number(state.freeCashLamports()) / LAMPORTS;
    let slotsLeft = state.hello.caps.max_open_positions - state.committedPositionCount();
    for (const mint of touched) {
      if (orders.length >= cap) break;
      const launch = launches.get(mint);
      if (launch === undefined || launch.decided) continue;
      const age = now - launch.created;
      if (age > MAX_AGE_SLOTS) {
        // Too old to judge as a launch any more: decide never.
        launch.decided = true;
        launches.delete(mint);
        continue;
      }
      if (slotsLeft <= 0) break;
      if (held.has(mint) || pendingByMint.has(mint)) continue;
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) {
        launch.decided = true;
        continue;
      }
      // Rug filter.
      if (launch.devSold) {
        launch.decided = true;
        continue;
      }
      if (launch.devBuy > MAX_DEV_BUY_SOL) {
        launch.decided = true;
        continue;
      }
      if (launch.buyers.size > MAX_OPEN_BUYERS) {
        launch.decided = true;
        continue;
      }
      const rqSol = Number(curve.real_quote_reserves) / LAMPORTS;
      if (rqSol < MIN_RQ_SOL || rqSol > MAX_RQ_SOL) continue;
      const capSol = Math.floor(Number(state.maxBuyLamports(mint))) / LAMPORTS;
      let amount = Math.min(capSol, STAKE_SOL);
      if (amount > free - txSol) amount = free - txSol;
      if (amount < MIN_BUY_SOL) continue;
      const lamports = BigInt(Math.floor(amount * LAMPORTS));
      orders.push({ side: 'buy', mint, quote_lamports: lamports, max_slippage_bps: BUY_SLIP_BPS });
      free -= amount + txSol;
      slotsLeft -= 1;
      launch.decided = true;
      held.set(mint, { opened: now });
    }

    return orders;
  },
});
