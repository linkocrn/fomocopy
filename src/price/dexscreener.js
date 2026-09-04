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

// Deepest pair where this token is the base. A token can also be the quote on
// a deeper pool (Rabbit/WYFI had $1.1M liq vs Rabbit/USDG at $50k). Using that
// pool's priceUsd prices the *other* asset, which is how a $4M coin showed as
// a $2B buy.
function pick(pairs, dexChain, token) {
  const want = token.toLowerCase();
  const onChain = (pairs || []).filter((p) => p.chainId === dexChain);
  if (!onChain.length) return null;
  const asBase = onChain.filter((p) => p.baseToken?.address?.toLowerCase() === want);
  const pool = (asBase.length ? asBase : onChain).reduce((a, b) =>
    (b.liquidity?.usd || 0) > (a.liquidity?.usd || 0) ? b : a
  );
  const isBase = pool.baseToken?.address?.toLowerCase() === want;
  return { pool, isBase };
}

function quoteFrom(pool, isBase) {
  let price = Number(pool.priceUsd) || null;
  if (!isBase && price && Number(pool.priceNative)) {
    price = price / Number(pool.priceNative);
  }
  return {
    price,
    liquidity: pool.liquidity?.usd ?? null,
    fdv: pool.fdv ?? null,
    mcap: pool.marketCap ?? pool.fdv ?? null,
    symbol: (isBase ? pool.baseToken?.symbol : pool.quoteToken?.symbol) ?? null,
    pairCreatedAt: pool.pairCreatedAt || null,
    pairAddress: pool.pairAddress || null,
    dexId: pool.dexId || null,
    volH1: pool.volume?.h1 ?? null,
    volH24: pool.volume?.h24 ?? null,
    changeM5: pool.priceChange?.m5 ?? null,
    changeH1: pool.priceChange?.h1 ?? null,
    buysH1: pool.txns?.h1?.buys ?? null,
    sellsH1: pool.txns?.h1?.sells ?? null,
  };
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
      const picked = pick((await res.json()).pairs, chain.dexscreener, token);
      if (!picked) return null;
      return quoteFrom(picked.pool, picked.isBase);
    } catch (e) {
      log.warn(`${token.slice(0, 10)} ${e.message}`);
      return null;
    }
  });

  cache.set(key, { at: Date.now(), value });
  return value;
}

module.exports = { fetchPrice };
