'use strict';

// Leaders scale in and out rather than trading once. slingoor unloaded MEME in
// fourteen separate transactions about fifteen seconds apart, which as raw
// alerts is fourteen near-identical Telegram messages.
//
// So the first trade of a burst goes out immediately, because that is the one
// worth reacting to, and everything after it is accumulated into a single
// rollup sent once the burst goes quiet.

const { icon } = require('../../config/leaders');

const BURST_QUIET_MS = 90_000;

// Compact form for context numbers like market cap and liquidity, where the
// magnitude is the point.
const money = (n) => {
  if (n == null) return null;
  const a = Math.abs(n);
  if (a >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
  if (a >= 1e3) return `$${Math.round(n / 1e3)}K`;
  return `$${Math.round(n)}`;
};

// Exact form for trade size, where rounding $10,500 to $11K loses the thing you
// are actually looking at.
const exact = (n) => (n == null ? null : `$${Math.round(n).toLocaleString('en-US')}`);

const fomoProfile = (handle) => `https://fomo.family/profile/${handle}`;

function makeAlerter(send) {
  const bursts = new Map();

  function single(t) {
    const bits = [];
    if (t.mcap) bits.push(`mcap ${money(t.mcap)}`);
    if (t.liquidity) bits.push(`liq ${money(t.liquidity)}`);

    return [
      `${icon(t.leader)} <b>${t.side.toUpperCase()}</b>  ${t.leader}`,
      `<b>${t.symbol}</b>  ${t.sizeUsd ? `<b>${exact(t.sizeUsd)}</b>` : 'size unknown'}` +
        (t.fracOfBag != null ? `  ·  ${(t.fracOfBag * 100).toFixed(t.fracOfBag < 0.1 ? 1 : 0)}% of bag` : ''),
      bits.length ? `${t.chain.name}  ·  ${bits.join('  ·  ')}` : t.chain.name,
      `<a href="https://dexscreener.com/${t.chain.dexscreener}/${t.token}">chart</a>` +
        ` · <a href="${t.chain.explorer}/tx/${t.txHash}">tx</a>` +
        ` · <a href="${t.chain.explorer}/address/${t.leaderAddr}">wallet</a>` +
        ` · <a href="${fomoProfile(t.leader)}">fomo</a>`,
    ].join('\n');
  }

  function rollup(b) {
    return [
      `${icon(b.leader)} <b>${b.side.toUpperCase()}</b>  ${b.leader} kept going`,
      `<b>${b.symbol}</b>  ${b.extras} more ${b.side}${b.extras === 1 ? '' : 's'}` +
        (b.totalUsd ? `  ·  <b>${exact(b.totalUsd)}</b> across ${b.extras + 1}` : ''),
      b.lastMcap ? `${b.chain.name}  ·  mcap now ${money(b.lastMcap)}` : b.chain.name,
      `<a href="https://dexscreener.com/${b.chain.dexscreener}/${b.token}">chart</a>` +
        ` · <a href="${fomoProfile(b.leader)}">fomo</a>`,
    ].join('\n');
  }

  function flush(key) {
    const b = bursts.get(key);
    bursts.delete(key);
    if (b && b.extras > 0) send(rollup(b));
  }

  return function alert(t) {
    const key = `${t.chain.id}:${t.leader}:${t.token}:${t.side}`;
    const existing = bursts.get(key);

    if (!existing) {
      send(single(t));
      bursts.set(key, {
        ...t,
        extras: 0,
        totalUsd: t.sizeUsd || 0,
        lastMcap: t.mcap,
        timer: setTimeout(() => flush(key), BURST_QUIET_MS),
      });
      return;
    }

    existing.extras += 1;
    existing.totalUsd += t.sizeUsd || 0;
    existing.lastMcap = t.mcap ?? existing.lastMcap;
    clearTimeout(existing.timer);
    existing.timer = setTimeout(() => flush(key), BURST_QUIET_MS);
  };
}

module.exports = { makeAlerter, money, exact, fomoProfile, BURST_QUIET_MS };
