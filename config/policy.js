'use strict';

// Entry rules are shared by every policy so the exit comparison is apples to
// apples. Only the exit differs.
const ENTRY = {
  // Notional we pretend to deploy per copied buy.
  sizeUsd: 100,

  // How long after the leader's trade we assume our own fill lands. Our entry
  // price is read at this offset, not at the leader's price, because buying
  // their pump is the main cost of copy trading and hiding it would make the
  // whole exercise pointless.
  entryDelayMs: 30_000,

  // Skip illiquid tokens. Copying a $5k-liquidity token tells us nothing
  // except that slippage is infinite.
  minLiquidityUsd: 20_000,

  // Skip anything already enormous, where a leader buy cannot move it.
  maxFdvUsd: 500_000_000,

  // Cap how many separate buys of the same token by the same leader we stack.
  maxAddsPerPosition: 3,

  // A buy that is a small slice of an already-large bag, when we never copied
  // the original entry, is a top-up to someone else's movie. Copying it as a
  // fresh $100 position pretends we were in the trade. Skip those.
  minNewBagFrac: 0.25,

  // Do not simulate an entry from a trade we are only seeing now because the
  // process was asleep. Gap-filled trades are still recorded, but opening a
  // position from one would price our "30 second" fill minutes or hours after
  // the fact and silently corrupt both the entry-cost stat and the PnL.
  //
  // Has to be tight, not merely generous. A four-minute-old replayed trade
  // produced a fake +62% entry cost during testing. Live subscription trades
  // arrive within a couple of seconds, so this only ever rejects replays.
  maxTradeAgeMs: 60_000,
};

// Marks are taken at these offsets from entry. Trailing policies also use them
// as their evaluation ticks.
const MARK_OFFSETS_MS = [
  5 * 60_000,
  30 * 60_000,
  60 * 60_000,
  6 * 60 * 60_000,
  24 * 60 * 60_000,
];

// Every policy runs against the same event stream at the same time. Nothing is
// executed, so running five costs no more than running one, and after a week
// the numbers pick the winner instead of us guessing.
const POLICIES = {
  // Leader sells any amount, we are fully out.
  mirror_all: { trailPct: null, sellFraction: 1, onLeaderSell: 'close' },

  // Leader sold 40% of their bag, we sell 40% of ours. Mirrors conviction
  // rather than treating every sell as a binary exit.
  mirror_prop: { trailPct: null, sellFraction: 'proportional', onLeaderSell: 'reduce' },

  // Leader's sell arms a trailing stop instead of selling. These traders often
  // exit early on the tokens that run furthest.
  trail_on_sell: { trailPct: 15, sellFraction: 0, onLeaderSell: 'arm_trail' },

  // Take half off the table immediately, trail the rest.
  tranche_trail: { trailPct: 20, sellFraction: 0.5, onLeaderSell: 'reduce_and_trail' },

  // Baseline. Ignores the leader entirely and closes at the last mark. If the
  // clever policies cannot beat this, the exit logic is not what is making
  // money and we should know that.
  hold_24h: { trailPct: null, sellFraction: 0, onLeaderSell: 'ignore' },
};

module.exports = { ENTRY, MARK_OFFSETS_MS, POLICIES };
