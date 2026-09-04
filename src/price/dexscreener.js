'use strict';

const { logger } = require('../util/log');

const log = logger('price');
const BASE = 'https://api.dexscreener.com/latest/dex/tokens';

// DexScreener covers Robinhood Chain natively (chainId "robinhood") as well as
// Base, which is why phase 1 needs no on-chain quoter at all. Their public API
// allows 300 requests/minute; we stay far under that with a short cache.
const CACHE_MS = 5_000;
const MIN_GAP_MS = 220;

const cache = new Map();
let queue = Promise.resolve();
let lastCall = 0;

function throttle(fn) {
  queue = queue.then(async () => {
    const wait = MIN_GAP_MS - (Date.now() - lastCall);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastCall = Date.now();
    return fn();
  });
  return queue;
}

// Picks the deepest pair on the right chain. A token can be quoted against
// several bases; the most liquid one is the honest price.
function pick(pairs, dexChain) {
  const onChain = (pairs || []).filter((p) => p.chainId === dexChain);
  if (!onChain.length) return null;
  return onChain.reduce((a, b) => ((b.liquidity?.usd || 0) > (a.liquidity?.usd || 0) ? b : a));
}

async function fetchPrice(chain, token) {
  const key = `${chain.id}:${token}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;

  const value = await throttle(async () => {
    try {
      const res = await fetch(`${BASE}/${token}`, { signal: AbortSignal.timeout(8000) });
      if (!res.ok) {
        log.warn(`${token.slice(0, 10)} HTTP ${res.status}`);
        return null;
      }
      const pair = pick((await res.json()).pairs, chain.dexscreener);
      if (!pair) return null;
      return {
        price: Number(pair.priceUsd) || null,
        liquidity: pair.liquidity?.usd ?? null,
        fdv: pair.fdv ?? null,
        symbol: pair.baseToken?.symbol ?? null,
      };
    } catch (e) {
      log.warn(`${token.slice(0, 10)} ${e.message}`);
      return null;
    }
  });

  cache.set(key, { at: Date.now(), value });
  return value;
}

module.exports = { fetchPrice };
