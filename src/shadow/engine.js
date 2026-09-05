'use strict';

const { logger } = require('../util/log');
const { ENTRY, DEAD, MARK_OFFSETS_MS, POLICIES } = require('../../config/policy');
const { fetchPrice } = require('../price/dexscreener');
const { settlement } = require('../chain/settle');
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
    // chainId:token -> consecutive reads showing no tradeable liquidity.
    this.deadReads = new Map();
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

  // What share of the leader's bag this trade is. Sells: sold / (sold + left).
  // Buys: bought / balance after, so a first entry is ~1 and an add is smaller.
  async leaderFraction(chainId, token, leaderAddr, amountRaw, block, side) {
    try {
      const after = await this.rpcs.get(chainId).balanceOf(token, leaderAddr, block);
      const qty = BigInt(amountRaw);
      if (side === 'buy') {
        if (after === 0n) return 1;
        return Number((qty * 10000n) / after) / 10000;
      }
      const total = qty + after;
      if (total === 0n) return 1;
      return Number((qty * 10000n) / total) / 10000;
    } catch {
      return null;
    }
  }

  // `shadow: false` records the event without opening positions. `market:
  // false` skips the DexScreener lookup, which backfill does because liquidity,
  // market cap and pair age are all as-of-now readings and stamping today's
  // values onto a week-old trade would quietly poison the data.
  //
  // The price itself is exempt from that: it comes out of the transaction, so
  // it is as correct for an old trade as a new one and is always read.
  async handleTrade(trade, { shadow = true, market = true } = {}) {
    const chain = this.chain(trade.chain_id);
    const rpc = this.rpcs.get(trade.chain_id);
    const meta = await this.tokenMeta(trade.chain_id, trade.token);
    const amount = Number(BigInt(trade.amount_raw)) / 10 ** meta.decimals;

    const quote = market ? await fetchPrice(chain, trade.token) : null;

    const settled = await settlement(rpc, chain, trade.tx_hash, trade.token, trade.side).catch(() => null);
    const execPrice = settled?.usd && amount > 0 ? settled.usd / amount : null;
    const price = execPrice ?? quote?.price ?? null;

    // Tokens moved through the vault with no stablecoin anywhere in the
    // transaction. Someone sent them, the leader did not buy them. Recorded so
    // the history stays honest, but it is not a trade and nothing downstream
    // should treat it as one.
    const kind = settled && !settled.paid ? 'transfer' : 'trade';

    const leaderFrac = await this.leaderFraction(
      trade.chain_id,
      trade.token,
      trade.leader_addr,
      trade.amount_raw,
      trade.block,
      trade.side
    );

    const ts = (await this.rpcs.get(trade.chain_id).blockTimestamp(trade.block)) || Date.now();

    const row = {
      ...trade,
      ts,
      seen_ts: Date.now(),
      amount,
      leader_frac: leaderFrac,
      kind,
      venue: settled?.venue ?? null,
      price_usd: price,
      price_source: execPrice ? 'exec' : quote?.price ? 'dexscreener' : null,
      // The settled amount is the trade, full stop. Only the estimated path
      // needs guarding: a size bigger than the whole coin is a quote read off
      // the wrong side of a pair, not a trade.
      size_usd: (() => {
        if (execPrice) return settled.usd;
        if (!quote?.price) return null;
        const size = amount * quote.price;
        if (quote.mcap && size > quote.mcap * 5) return null;
        return size;
      })(),
      liquidity_usd: quote?.liquidity ?? null,
      fdv_usd: quote?.fdv ?? null,
      mcap_usd: quote?.mcap ?? null,
      pair_created_at: quote?.pairCreatedAt ?? null,
      pair_address: quote?.pairAddress ?? null,
      dex_id: quote?.dexId ?? null,
      vol_h1: quote?.volH1 ?? null,
      vol_h24: quote?.volH24 ?? null,
      change_m5: quote?.changeM5 ?? null,
      change_h1: quote?.changeH1 ?? null,
      buys_h1: quote?.buysH1 ?? null,
      sells_h1: quote?.sellsH1 ?? null,
    };
    delete row.leader_addr;

    const res = this.st.insertEvent.run(row);
    if (res.changes === 0) return; // already seen, e.g. replayed after reconnect
    const eventId = res.lastInsertRowid;

    const sym = meta.symbol || trade.token.slice(0, 8);
    const size = row.size_usd ? `$${Math.round(row.size_usd).toLocaleString()}` : 'size unknown';
    const fracTxt = leaderFrac != null ? ` (${Math.round(leaderFrac * 100)}% of bag)` : '';

    if (kind === 'transfer') {
      const dir = trade.side === 'buy' ? 'received' : 'sent';
      log.info(`${chain.slug} ${dir} ${trade.leader} ${sym} ${amount.toLocaleString()} (no payment, not a trade)`);
      return;
    }

    log.info(`${chain.slug} ${trade.side.toUpperCase().padEnd(4)} ${trade.leader} ${sym} ${size}${fracTxt}`);

    if (!shadow) return;

    // Muting stops alerts and stops opening new positions, but a muted
    // leader's sells still close positions we already opened from them.
    // Otherwise muting would strand live positions with no exit.
    const muted = !!this.st.isMuted.get(trade.leader);

    if (!muted) {
      this.notify({
        chain,
        leader: trade.leader,
        leaderAddr: trade.leader_addr,
        side: trade.side,
        symbol: sym,
        token: trade.token,
        txHash: trade.tx_hash,
        sizeUsd: row.size_usd,
        fracOfBag: leaderFrac,
        mcap: row.mcap_usd,
        liquidity: row.liquidity_usd,
        pairCreatedAt: quote?.pairCreatedAt ?? null,
      });
    }

    // Our exit is a $100 sale, theirs may be a $25k dump. Their fill includes
    // slippage we would never pay, so mark the exit at the market price when we
    // have one and only fall back to their fill.
    if (trade.side === 'sell') this.applyLeaderSell(row, quote?.price ?? execPrice);
    else if (!muted) this.openShadowPositions(eventId, row, quote);
  }

  // One pending position per policy. Entry price is filled in later, at
  // ENTRY.entryDelayMs, so our fill reflects the price after their impact.
  openShadowPositions(eventId, row, quote) {
    const age = Date.now() - row.ts;

    const alreadyIn = this.st.liveFor.all(row.chain_id, row.token, row.leader).length > 0;

    let skip = null;
    if (age > ENTRY.maxTradeAgeMs) skip = 'stale_replay';
    else if (this.privateVenue(row)) skip = 'private_venue';
    else if (!quote?.price) skip = 'no_price';
    else if ((quote.liquidity ?? 0) < ENTRY.minLiquidityUsd) skip = 'low_liquidity';
    else if ((quote.fdv ?? 0) > ENTRY.maxFdvUsd) skip = 'fdv_too_high';
    else if (
      !alreadyIn &&
      row.leader_frac != null &&
      row.leader_frac < ENTRY.minNewBagFrac
    ) {
      skip = 'mid_bag';
    }

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

  // Counted across the whole history rather than this token alone, so a shared
  // venue is recognised on the first brand-new token it lists. An unknown venue
  // reads as private until a second token appears on it, which is the safe way
  // round: the cost is a skipped copy, not a hundred percent loss.
  privateVenue(row) {
    if (!row.venue) return false;
    const { n } = this.st.venueTokens.get(row.venue, row.chain_id);
    return n < ENTRY.minVenueTokens;
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
      this.st.activate.run(quote.price, now, quote.liquidity ?? null, quote.mcap ?? null, position.id);
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
      const marks = this.st.marksFor.all(position.id);
      const taken = new Set(marks.map((m) => m.offset_ms));
      const due = MARK_OFFSETS_MS.filter((o) => age >= o && !taken.has(o));

      // The last mark came back with the pool drained. Watch it every tick from
      // here so the confirming read arrives in seconds rather than at whatever
      // mark offset happens to be next, which can be hours away.
      const last = marks.reduce((a, b) => (a && a.offset_ms > b.offset_ms ? a : b), null);
      const draining = last?.liquidity_usd != null && last.liquidity_usd < DEAD.minLiquidityUsd;

      if (!due.length && !position.trail_armed && !draining && age < FINAL_OFFSET) continue;

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

      if (this.closeIfDead(key, items, quote, now)) continue;

      for (const { position, age, due } of items) {
        for (const offset of due) {
          const pct = position.entry_price ? (quote.price / position.entry_price - 1) * 100 : null;
          this.st.putMark.run(position.id, offset, now, quote.price, pct, quote.liquidity ?? null, quote.mcap ?? null);
        }

        onPriceTick(ctx, position, quote.price, now);

        // Everything is bounded by the final mark so the report always closes.
        if (position.status === 'open' && age >= FINAL_OFFSET) {
          reduce(ctx, position, position.qty, quote.price, 'horizon_reached', now);
        }
      }
    }
  }

  // The pool drained. Close at the last quoted price rather than waiting out
  // the horizon on a position that has already reached its final value.
  //
  // The price is kept rather than forced to zero because it is what the token
  // is nominally worth, and pretending we know better invents a number. It is
  // near enough to a total loss either way.
  closeIfDead(key, items, quote, now) {
    const liquidity = quote.liquidity ?? null;
    if (liquidity == null || liquidity >= DEAD.minLiquidityUsd) {
      this.deadReads.delete(key);
      return false;
    }

    const reads = (this.deadReads.get(key) || 0) + 1;
    this.deadReads.set(key, reads);
    if (reads < DEAD.confirmations) return false;

    const ctx = { st: this.st };
    let closed = 0;
    for (const { position } of items) {
      if (position.status !== 'open') continue;
      reduce(ctx, position, position.qty, quote.price, 'liquidity_gone', now);
      closed++;
    }
    this.deadReads.delete(key);

    if (closed) {
      const chainId = Number(key.split(':')[0]);
      const token = key.slice(key.indexOf(':') + 1);
      const symbol = this.st.getToken.get(chainId, token)?.symbol || token.slice(0, 8);
      log.warn(`${symbol} liquidity gone ($${Math.round(liquidity)}), closed ${closed} position(s) as a total loss`);
    }
    return true;
  }
}

module.exports = { Engine };
