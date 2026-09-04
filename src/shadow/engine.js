'use strict';

const { logger } = require('../util/log');
const { ENTRY, MARK_OFFSETS_MS, POLICIES } = require('../../config/policy');
const { fetchPrice } = require('../price/dexscreener');
const { onLeaderSell, onPriceTick, reduce } = require('./policies');

const log = logger('shadow');
const FINAL_OFFSET = Math.max(...MARK_OFFSETS_MS);

class Engine {
  constructor({ db, st, chains, rpcs, notify }) {
    this.db = db;
    this.st = st;
    this.chains = new Map(chains.map((c) => [c.id, c]));
    this.rpcs = rpcs; // Map chainId -> Rpc
    this.notify = notify || (() => {});
  }

  chain(id) {
    return this.chains.get(id);
  }

  // Resolve decimals and symbol once per token, then cache in SQLite.
  async tokenMeta(chainId, token) {
    const cached = this.st.getToken.get(chainId, token);
    if (cached) return cached;
    const rpc = this.rpcs.get(chainId);
    const [decimals, symbol] = await Promise.all([rpc.decimals(token), rpc.symbol(token)]);
    const row = { chain_id: chainId, address: token, symbol, decimals: decimals ?? 18 };
    this.st.putToken.run(chainId, token, row.symbol, row.decimals);
    return row;
  }

  // A leader's sell tells us far more if we know what share of their bag it
  // was. Their balance right after the sell gives us that exactly.
  async leaderFraction(chainId, token, leaderAddr, amountRaw, block) {
    try {
      const after = await this.rpcs.get(chainId).balanceOf(token, leaderAddr, block);
      const sold = BigInt(amountRaw);
      const total = sold + after;
      if (total === 0n) return 1;
      return Number((sold * 10000n) / total) / 10000;
    } catch {
      return null;
    }
  }

  // `shadow: false` records the event without opening positions, and `price:
  // false` skips the price lookup. Backfill uses both: DexScreener only serves
  // current prices, so pricing a week-old trade with today's number would
  // quietly poison the PnL.
  async handleTrade(trade, { shadow = true, price: wantPrice = true } = {}) {
    const chain = this.chain(trade.chain_id);
    const meta = await this.tokenMeta(trade.chain_id, trade.token);
    const amount = Number(BigInt(trade.amount_raw)) / 10 ** meta.decimals;

    const quote = wantPrice ? await fetchPrice(chain, trade.token) : null;
    const price = quote?.price ?? null;

    const leaderFrac =
      trade.side === 'sell'
        ? await this.leaderFraction(trade.chain_id, trade.token, trade.leader_addr, trade.amount_raw, trade.block)
        : null;

    const ts = (await this.rpcs.get(trade.chain_id).blockTimestamp(trade.block)) || Date.now();

    const row = {
      ...trade,
      ts,
      amount,
      leader_frac: leaderFrac,
      price_usd: price,
      size_usd: price ? amount * price : null,
      liquidity_usd: quote?.liquidity ?? null,
      fdv_usd: quote?.fdv ?? null,
    };
    delete row.leader_addr;

    const res = this.st.insertEvent.run(row);
    if (res.changes === 0) return; // already seen, e.g. replayed after reconnect
    const eventId = res.lastInsertRowid;

    const sym = meta.symbol || trade.token.slice(0, 8);
    const size = row.size_usd ? `$${Math.round(row.size_usd).toLocaleString()}` : 'size unknown';
    const fracTxt = leaderFrac != null ? ` (${Math.round(leaderFrac * 100)}% of bag)` : '';
    log.info(`${chain.slug} ${trade.side.toUpperCase().padEnd(4)} ${trade.leader} ${sym} ${size}${fracTxt}`);

    if (!shadow) return;
    this.notify(
      [
        `<b>${trade.side.toUpperCase()}</b>  ${trade.leader}`,
        `<b>${sym}</b> ${size}${fracTxt}`,
        `${chain.name}${row.liquidity_usd ? ` · liq $${Math.round(row.liquidity_usd).toLocaleString()}` : ''}`,
        `<a href="https://dexscreener.com/${chain.dexscreener}/${trade.token}">chart</a> · ` +
          `<a href="${chain.explorer}/tx/${trade.tx_hash}">tx</a>`,
      ].join('\n')
    );

    if (trade.side === 'buy') this.openShadowPositions(eventId, row, quote);
    else this.applyLeaderSell(row, price);
  }

  // One pending position per policy. Entry price is filled in later, at
  // ENTRY.entryDelayMs, so our fill reflects the price after their impact.
  openShadowPositions(eventId, row, quote) {
    let skip = null;
    if (!quote?.price) skip = 'no_price';
    else if ((quote.liquidity ?? 0) < ENTRY.minLiquidityUsd) skip = 'low_liquidity';
    else if ((quote.fdv ?? 0) > ENTRY.maxFdvUsd) skip = 'fdv_too_high';

    for (const policy of Object.keys(POLICIES)) {
      this.st.insertPosition.run({
        policy,
        chain_id: row.chain_id,
        token: row.token,
        leader: row.leader,
        open_event: eventId,
        opened_ts: row.ts,
        leader_price: row.price_usd,
        size_usd: ENTRY.sizeUsd,
        status: skip ? 'skipped' : 'pending',
        skip_reason: skip,
      });
    }
    if (skip) log.dim(`  skipped (${skip})`);
  }

  // A leader sell only touches positions opened by that same leader in that
  // same token. Cross-leader exits are a separate question and the event log
  // has everything needed to answer it later.
  applyLeaderSell(row, price) {
    const open = this.st.openFor.all(row.chain_id, row.token, row.leader);
    if (!open.length) return;
    const ctx = { st: this.st };
    for (const position of open) {
      onLeaderSell(ctx, position, { price, leaderFrac: row.leader_frac, ts: row.ts });
    }
    log.dim(`  applied to ${open.length} shadow position(s)`);
  }

  // Called on a timer. Activates pending entries, takes due marks, runs
  // trailing stops and force-closes anything past the final mark.
  async tick() {
    const now = Date.now();
    await this.activatePending(now);
    await this.markOpen(now);
  }

  async activatePending(now) {
    const due = this.st.pendingEntries.all(now - ENTRY.entryDelayMs);
    if (!due.length) return;

    // Several policies share one token, so price once and reuse.
    const wanted = [...new Set(due.map((p) => `${p.chain_id}:${p.token}`))];
    const prices = new Map();
    for (const key of wanted) {
      const [id, token] = [Number(key.split(':')[0]), key.split(':')[1]];
      prices.set(key, await fetchPrice(this.chain(id), token));
    }

    for (const position of due) {
      const quote = prices.get(`${position.chain_id}:${position.token}`);
      if (!quote?.price) {
        this.st.skip.run('no_entry_price', position.id);
        continue;
      }
      this.st.activate.run(quote.price, now, position.id);
      this.st.addFill.run(position.id, now, 0, quote.price, 'entry', 0);
    }

    const drift = due
      .filter((p) => p.leader_price)
      .map((p) => {
        const q = prices.get(`${p.chain_id}:${p.token}`);
        return q?.price ? (q.price / p.leader_price - 1) * 100 : null;
      })
      .filter((x) => x != null);

    if (drift.length) {
      const avg = drift.reduce((a, b) => a + b, 0) / drift.length;
      log.dim(`entered ${due.length} position(s), avg drift vs leader fill ${avg >= 0 ? '+' : ''}${avg.toFixed(2)}%`);
    }
  }

  async markOpen(now) {
    const open = this.st.openPositions.all();
    if (!open.length) return;

    // Only price a token if something actually depends on it this tick: a mark
    // has come due, a trailing stop is live, or the horizon has passed. A
    // position whose next mark is five hours out costs nothing until then.
    const work = new Map();
    for (const position of open) {
      const age = now - (position.entry_ts || position.opened_ts);
      const taken = new Set(this.st.marksFor.all(position.id).map((m) => m.offset_ms));
      const due = MARK_OFFSETS_MS.filter((o) => age >= o && !taken.has(o));
      if (!due.length && !position.trail_armed && age < FINAL_OFFSET) continue;

      const key = `${position.chain_id}:${position.token}`;
      if (!work.has(key)) work.set(key, []);
      work.get(key).push({ position, age, due });
    }
    if (!work.size) return;

    const ctx = { st: this.st };
    for (const [key, items] of work) {
      const chainId = Number(key.split(':')[0]);
      const token = key.slice(key.indexOf(':') + 1);
      const quote = await fetchPrice(this.chain(chainId), token);
      if (!quote?.price) continue;

      for (const { position, age, due } of items) {
        for (const offset of due) {
          const pct = position.entry_price ? (quote.price / position.entry_price - 1) * 100 : null;
          this.st.putMark.run(position.id, offset, now, quote.price, pct);
        }

        onPriceTick(ctx, position, quote.price, now);

        // Everything is bounded by the final mark so the report always closes.
        if (position.status === 'open' && age >= FINAL_OFFSET) {
          reduce(ctx, position, position.qty, quote.price, 'horizon_reached', now);
        }
      }
    }
  }
}

module.exports = { Engine };
