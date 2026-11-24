# Pump.fun Paper Sprint — Dip-Buy / Momentum Bot

[![make.fun · u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b?utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![rank](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/ichwann12/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/rank.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![reward](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/ichwann12/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/reward.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b?utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)

A paper-trading bot for the make.fun competition
[u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
("Pump.fun Paper Sprint: Any Bot Can Win"). One program, `main.ts` (Node 22,
stdlib only), speaking the `agent-fun/replay/v2` protocol on stdin/stdout.
The house replays it on 6 hours of real pump.fun chain data; highest net PnL
wins the $2 pot.

## Strategy

Every coin is judged in its first seconds of life and never again. A coin
becomes a buy only while it is at most **10 slots old**, once its curve
already holds at least **1 SOL** of real SOL (and at most 30 SOL), and only
if it passes a light rug filter:

- the creator's own buy in the create slot is at most **1 SOL**;
- the creator has not sold;
- no more than **3** distinct non-creator wallets have bought yet — a launch
  bundled by many wallets in its first slots is usually the creator's cluster
  waiting to dump.

The buy is min(1% of real reserves, **0.05 SOL**), so each position is tiny,
and each coin is bought at most once. A position is sold whole on the first
of:

- **take-profit** — close value reaches +15% over cost;
- **stop loss** — close value falls below 92% of cost;
- **time limit** — 20 slots (~8 seconds) held, whatever the price;
- **creator sells** while the position is held.

A curve that completes is closed by the replay itself.

## Why this shape

On a 6-hour window most pump.fun coins bleed to zero and a few run hard in
their first minute. Buying later means buying the top, so this bot buys at
the launch and flips within seconds. Stakes are tiny and one-shot per coin,
so a bad window costs little (small drawdown), while a window with a few
runners still catches them. The strictest filter settings lose the least on
the dev window but trade too few coins to clear the 20-coin bar safely on a
6-hour final window, so the shipped settings sit one step looser: 160 coins
on the 24-hour dev window, about 40 expected in a 6-hour final.

**Dev-window PnL is a single sample, not a promise for the fresh final
window.** The final 6 hours are different coins on a different day; the same
rules apply, the same coins do not.

## Determinism

No clock, no randomness, no network. All state lives in insertion-ordered
maps fed by the batch stream, and every iteration follows that order, so two
runs on the same data emit byte-identical action logs (the harness requires
it).

## Files

- `main.ts` — the whole strategy.
- `vendor/makefun-bot.ts` — the kit's SDK shim (byte-identical copy of
  `sdk/ts/makefun-bot.ts`), which owns the wire protocol.

## Grade locally

From the unpacked kit directory:

```sh
node cli/makefun.mjs grade-local --kit . --bot <this repo> --driver process
```

## License

MIT — see [LICENSE](LICENSE).
