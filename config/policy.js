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

  // Refuse tokens whose float sits in a venue nobody else trades through.
  //
  // Almost all FOMO flow is supplied by three shared venues holding 107, 40 and
  // 26 tokens each. PONSVIL and AARTC were supplied by a contract serving that
  // one token and nothing else, and both went to zero liquidity with every
  // leader still holding the exact bag they bought. Holding pair age constant,
  // of 51 tokens first bought inside 15 minutes of the pair existing, the 49 on
  // a shared venue are all still alive and the 2 on a private one are the only
  // rugs. Whoever controls a single-token venue controls the exit.
  minVenueTokens: 2,
};

// A position we could no longer sell out of, at any price.
//
// PONSVIL and AARTC both went from a healthy pool to nothing while thirteen and
// eleven leaders respectively sat holding every token they had bought. There is
// no sell to close against and no bid to close into, so without this the copies
// stay open at -99.98% until the horizon, or forever if the token stops being
// quoted at all. Recording them as the total losses they already are is the
// honest reading.
const DEAD = {
  // Our exit is a $100 sale. Below this there is nothing to sell into, and a
  // reading of exactly zero is the usual case anyway.
  minLiquidityUsd: 1_000,

  // One bad DexScreener response should not bury a live position, so a token
  // has to read dead this many consecutive times before we act.
  confirmations: 2,
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

module.exports = { ENTRY, DEAD, MARK_OFFSETS_MS, POLICIES };
