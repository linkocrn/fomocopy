'use strict';

const { POLICIES } = require('../../config/policy');

// Accounting convention: a position has a fixed notional (size_usd) bought at
// entry_price. `qty` is the fraction of that notional still held, 1.0 down to 0.
// A fill's `fraction` is always expressed against the original notional, so
// summing fill PnL gives total PnL with no compounding surprises.

function fillPnl(position, fraction, price) {
  if (!position.entry_price || !price) return 0;
  return position.size_usd * fraction * (price / position.entry_price - 1);
}

// Sells part of a position and closes it if nothing meaningful is left.
function reduce(ctx, position, fraction, price, reason, ts) {
  const take = Math.min(fraction, position.qty);
  if (take <= 1e-9) return position.qty;

  ctx.st.addFill.run(position.id, ts, take, price, reason, fillPnl(position, take, price));
  const left = position.qty - take;

  if (left <= 1e-6) {
    closeOut(ctx, position, price, reason, ts);
    return 0;
  }
  ctx.st.reduce.run(left, position.id);
  position.qty = left;
  return left;
}

// Finalises a position by rolling up every fill recorded against it.
function closeOut(ctx, position, price, reason, ts) {
  const fills = ctx.st.fillsFor.all(position.id);
  const pnl = fills.reduce((sum, f) => sum + (f.pnl_usd || 0), 0);
  const invested = fills.reduce((sum, f) => sum + f.fraction, 0) * position.size_usd;
  ctx.st.close.run(price, ts, reason, pnl, invested ? (pnl / invested) * 100 : 0, position.id);
  position.status = 'closed';
  position.qty = 0;
}

// The leader sold. Each policy interprets that differently; this is the whole
// point of running them side by side.
function onLeaderSell(ctx, position, { price, leaderFrac, ts }) {
  const rules = POLICIES[position.policy];
  if (!rules || !price) return;

  switch (rules.onLeaderSell) {
    case 'ignore':
      return;

    case 'close':
      reduce(ctx, position, position.qty, price, 'leader_sold', ts);
      return;

    case 'reduce': {
      // Mirror their conviction: they took 40% off, so do we.
      const frac = leaderFrac == null ? position.qty : position.qty * leaderFrac;
      reduce(ctx, position, frac, price, 'leader_sold_partial', ts);
      return;
    }

    case 'arm_trail':
      if (!position.trail_armed) {
        ctx.st.armTrail.run(price, position.id);
        position.trail_armed = 1;
        position.trail_peak = price;
      }
      return;

    case 'reduce_and_trail': {
      const left = reduce(ctx, position, position.qty * rules.sellFraction, price, 'leader_sold_tranche', ts);
      if (left > 0 && !position.trail_armed) {
        ctx.st.armTrail.run(price, position.id);
        position.trail_armed = 1;
        position.trail_peak = price;
      }
      return;
    }

    default:
      return;
  }
}

// Called on every mark tick for open positions. Only does anything once a
// trailing stop has been armed.
function onPriceTick(ctx, position, price, ts) {
  const rules = POLICIES[position.policy];
  if (!rules?.trailPct || !position.trail_armed || !price) return;

  const peak = position.trail_peak || price;
  if (price > peak) {
    ctx.st.setPeak.run(price, position.id);
    position.trail_peak = price;
    return;
  }
  if (price <= peak * (1 - rules.trailPct / 100)) {
    reduce(ctx, position, position.qty, price, 'trail_stop', ts);
  }
}

module.exports = { onLeaderSell, onPriceTick, reduce, closeOut, fillPnl };
