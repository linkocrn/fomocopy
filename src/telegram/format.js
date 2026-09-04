'use strict';

// Telegram-flavoured rendering of the shared report data. Wide tables get
// wrapped in <pre> so the monospace font keeps the columns lined up on mobile.

const R = require('../report');
const { POLICIES } = require('../../config/policy');
const { CHAINS } = require('../../config/chains');
const { LEADERS, icon } = require('../../config/leaders');
const { money, exact, fomoProfile, fomoToken, twitterProfile } = require('./alerts');

const addressOf = (handle) => LEADERS.find((l) => l.handle === handle)?.evm || null;

// A token line is only useful if you can go look at it, and Telegram will not
// render links inside <pre>. So the numbers stay in a monospace block and the
// links sit on their own line underneath it.
function tokenLinks(chain, token, extra = []) {
  if (!chain) return null;
  const links = [
    `<a href="https://dexscreener.com/${chain.dexscreener}/${token}">chart</a>`,
    `<a href="${fomoToken(chain, token)}">fomo</a>`,
    `<a href="${chain.explorer}/token/${token}">scan</a>`,
    ...extra,
  ];
  return links.join(' · ');
}

const usd = (n) => (n == null ? '-' : `${n < 0 ? '-' : ''}$${Math.abs(n).toFixed(2)}`);
const pct = (n) => (n == null ? '-' : `${n >= 0 ? '+' : ''}${n.toFixed(1)}%`);
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const pre = (s) => `<pre>${esc(s)}</pre>`;

function overview(db) {
  const o = R.overview(db);
  if (!o.events) return 'No trades recorded yet.';
  const lines = [
    `<b>${o.events}</b> trades over <b>${o.hours.toFixed(1)}h</b> (${o.perHour.toFixed(1)}/hour)`,
    '',
  ];
  for (const c of o.chains) {
    lines.push(`<b>${esc(c.name)}</b>`);
    lines.push(`  ${c.buys} buys · ${c.sells} sells · ${c.tokens} tokens · ${c.leaders} leaders`);
  }
  return lines.join('\n');
}

function leaders(db) {
  const rows = R.leaders(db, 15);
  if (!rows.length) return 'No trades recorded yet.';
  const body = rows
    .map((r) => `${icon(r.leader)} ${r.leader.slice(0, 15).padEnd(15)} ${String(r.n).padStart(3)}  ${String(r.buys).padStart(3)}b/${String(r.sells).padStart(3)}s  ${r.tokens}t`)
    .join('\n');
  return `<b>Most active leaders</b>\n${pre(body)}`;
}

// The full emoji legend, for learning the mapping.
function who() {
  const body = LEADERS.map((l) => `${icon(l.handle)} ${l.handle}`).join('\n');
  return `<b>Leader icons</b>\n<i>Derived from the handle, so they never change.</i>\n${pre(body)}`;
}

function clusters(db) {
  const rows = R.clusters(db, 10);
  if (!rows.length) return 'No token has been bought by more than one leader yet.';
  const body = rows
    .map((r) => {
      const icons = r.who.split(',').map((h) => icon(h.trim())).join('');
      return `${(r.symbol || r.token.slice(0, 10)).slice(0, 12).padEnd(12)} ${icons}  ${r.who}`;
    })
    .join('\n');
  return `<b>Tokens bought by multiple leaders</b>\nThe strongest signal in the data.\n${pre(body)}`;
}

function scoreboard(db) {
  const s = R.scoreboard(db);
  const e = R.entryCost(db);
  const out = [`<b>Policy scoreboard</b>`, `<i>$${s.sizeUsd} notional per copied buy</i>`, ''];

  const body = [
    `${'policy'.padEnd(14)}${'cls'.padStart(4)}${'opn'.padStart(4)}${'win'.padStart(5)}${'total'.padStart(10)}`,
    ...s.rows.map(
      (r) =>
        `${r.policy.padEnd(14)}${String(r.closed).padStart(4)}${String(r.open).padStart(4)}` +
        `${(r.winPct == null ? '-' : `${r.winPct.toFixed(0)}%`).padStart(5)}${(r.total == null ? '-' : usd(r.total)).padStart(10)}`
    ),
  ].join('\n');
  out.push(pre(body));

  if (s.best) {
    out.push(`Best: <b>${s.best.policy}</b> at ${usd(s.best.total)}`);
    if (s.baseline?.total != null && s.best.policy !== 'hold_24h') {
      out.push(`Exit logic is worth ${usd(s.best.total - s.baseline.total)} over the hold_24h baseline.`);
    } else if (s.baseline?.total != null) {
      out.push('The baseline wins, so the exit rules are not adding anything yet.');
    }
  } else {
    out.push('<i>No positions have closed yet. The first 24h marks need to land.</i>');
  }

  if (e) {
    out.push('', `<b>Entry cost</b> (our fill ${e.delaySec}s after theirs, n=${e.n})`);
    out.push(`mean ${pct(e.mean)} · median ${pct(e.median)} · worst ${pct(e.worst)}`);
    out.push('<i>Positive means we bought their pump. Negative is the price impact they pay on the whole order and our $100 does not.</i>');
  }
  return out.join('\n');
}

function positions(db) {
  const s = R.scoreboard(db);
  const policy = s.best?.policy || 'hold_24h';
  const rows = R.openPositions(db, policy, 20);
  if (!rows.length) return 'No open shadow positions.';
  const body = rows
    .map((p) => {
      const live = p.last_price && p.entry_price ? (p.last_price / p.entry_price - 1) * 100 : null;
      const age = ((Date.now() - (p.entry_ts || p.opened_ts)) / 3_600_000).toFixed(1);
      return `${icon(p.leader)} ${(p.symbol || p.token.slice(0, 8)).slice(0, 10).padEnd(10)} ${p.leader.slice(0, 12).padEnd(12)} ${age.padStart(5)}h ${(live == null ? '-' : pct(live)).padStart(8)}`;
    })
    .join('\n');
  return `<b>Open positions</b> <i>(${policy})</i>\n${pre(body)}`;
}

function leaderRows(rows) {
  return rows
    .map(
      (r) =>
        `${icon(r.leader)} ${r.leader.slice(0, 15).padEnd(15)} ${String(r.n).padStart(3)}  ${usd(r.total).padStart(10)}  ${pct(r.avg).padStart(7)}`
    )
    .join('\n');
}

function perLeader(db) {
  const s = R.scoreboard(db);
  const closedPolicy = s.best?.policy || 'hold_24h';
  const closed = R.perLeader(db, closedPolicy);
  // Open book is always hold_24h so a runner still in play is visible even
  // when a faster policy already exited and is winning the closed table.
  const open = R.perLeaderOpen(db, 'hold_24h');

  if (!closed.length && !open.length) return 'No shadow positions yet.';

  const out = ['<b>PnL per leader</b>', ''];
  out.push(`<b>Closed</b> <i>(${closedPolicy})</i>`);
  out.push(closed.length ? pre(leaderRows(closed)) : '<i>Nothing closed yet. This is the score.</i>');
  out.push('');
  out.push('<b>Open</b> <i>(hold_24h, live mark)</i>');
  out.push(
    open.length
      ? pre(leaderRows(open))
      : '<i>No open hold_24h positions.</i>'
  );
  out.push('');
  out.push('<i>Open dollars can vanish. Closed is who was actually +EV to copy.</i>');
  return out.join('\n');
}

function oneLeader(db, arg) {
  const handle = R.resolveLeader(db, arg);
  if (!handle) return `No leader called <b>${esc(arg)}</b>. Try /who or /leaders.`;

  const act = R.leaderActivity(db, handle);
  const s = R.scoreboard(db);
  const closedPolicy = s.best?.policy || 'hold_24h';
  const hold = R.leaderPositions(db, handle, 'hold_24h');
  const scored = closedPolicy === 'hold_24h' ? [] : R.leaderPositions(db, handle, closedPolicy).filter((p) => p.status === 'closed');

  const livePnl = (p) => {
    if (p.status === 'closed') return { usd: p.pnl_usd, pct: p.pnl_pct };
    if (p.status === 'open' && p.entry_price && p.last_price) {
      const pctV = (p.last_price / p.entry_price - 1) * 100;
      return { usd: p.size_usd * (p.qty || 0) * (p.last_price / p.entry_price - 1), pct: pctV };
    }
    return { usd: null, pct: null };
  };

  // Several copies of one token read as one holding, not as separate rows, and
  // grouping keeps the links to one set per token instead of one per copy.
  const byToken = (rows) => {
    const map = new Map();
    for (const p of rows) {
      const key = `${p.chain_id}:${p.token}`;
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(p);
    }
    return [...map.values()];
  };

  const block = (group) => {
    const p = group[0];
    const chain = CHAINS[p.chain_id];
    const vals = group.map(livePnl);
    const total = vals.reduce((a, v) => a + (v.usd || 0), 0);
    const pcts = vals.map((v) => v.pct).filter((v) => v != null);
    const avg = pcts.length ? pcts.reduce((a, b) => a + b, 0) / pcts.length : null;
    const age = ((Date.now() - Math.min(...group.map((x) => x.entry_ts || x.opened_ts))) / 3_600_000).toFixed(1);

    const context = [
      `${group.length} ${group.length === 1 ? 'copy' : 'copies'}`,
      `${age}h`,
      money(p.last_liquidity_usd ?? p.entry_liquidity_usd) ? `liq ${money(p.last_liquidity_usd ?? p.entry_liquidity_usd)}` : null,
      money(p.last_mcap_usd ?? p.entry_mcap_usd) ? `mcap ${money(p.last_mcap_usd ?? p.entry_mcap_usd)}` : null,
      [...new Set(group.map((x) => x.exit_reason).filter(Boolean))].join(', ') || null,
    ].filter(Boolean);

    const tx = p.last_tx && chain ? [`<a href="${chain.explorer}/tx/${p.last_tx}">tx</a>`] : [];

    return [
      `<b>${esc(p.symbol || p.token.slice(0, 8))}</b>  ${usd(total)}  ${pct(avg)}`,
      `<i>${esc(context.join(' · '))}</i>`,
      tokenLinks(chain, p.token, tx),
    ]
      .filter(Boolean)
      .join('\n');
  };

  // Biggest mover first: with a dozen tokens the interesting one should not be
  // buried by whichever happened to be bought most recently.
  const section = (rows) =>
    byToken(rows)
      .sort((a, b) => {
        const sum = (g) => g.reduce((acc, p) => acc + (livePnl(p).usd || 0), 0);
        return sum(b) - sum(a);
      })
      .map(block)
      .join('\n\n');

  const open = hold.filter((p) => p.status === 'open');
  const closed = hold.filter((p) => p.status === 'closed');
  const skipped = hold.filter((p) => p.status === 'skipped');

  const addr = addressOf(handle);
  const chains = [...new Set(hold.map((p) => p.chain_id))].map((id) => CHAINS[id]).filter(Boolean);

  const out = [
    `${icon(handle)} <b>${esc(handle)}</b>`,
    `${act.n || 0} trades · ${act.buys || 0}b/${act.sells || 0}s · ${act.tokens || 0} tokens`,
    addr ? `<code>${addr}</code>` : null,
    [
      `<a href="${fomoProfile(handle)}">fomo</a>`,
      `<a href="${twitterProfile(handle)}">twitter</a>`,
      ...chains.map((c) => `<a href="${c.explorer}/address/${addr}">${esc(c.slug)}</a>`),
    ]
      .filter(() => addr)
      .join(' · '),
    '',
  ].filter((l) => l !== null);

  if (open.length) {
    out.push('<b>Open</b> <i>(hold_24h, live mark)</i>', '');
    out.push(section(open));
    out.push('');
  }
  if (closed.length) {
    out.push('<b>Closed</b> <i>(hold_24h)</i>', '');
    out.push(section(closed));
    out.push('');
  }
  if (scored.length) {
    out.push(`<b>Closed</b> <i>(${closedPolicy}, the current score)</i>`, '');
    out.push(section(scored));
    out.push('');
  }
  if (skipped.length) {
    out.push(`<b>Skipped</b> <i>${skipped.length} copies never opened</i>`);
    const why = {};
    for (const p of skipped) why[p.skip_reason || '?'] = (why[p.skip_reason || '?'] || 0) + 1;
    out.push(Object.entries(why).map(([k, n]) => `${esc(k)} × ${n}`).join(' · '));
    out.push('');
  }
  if (!open.length && !closed.length && !scored.length) {
    out.push('<i>No shadow positions. Either they have not bought since we started, or every buy was skipped.</i>');
  }
  out.push('<i>Each copy is one $100 buy. Open dollars can vanish.</i>');
  // Name a coin they actually hold, so the hint is runnable as printed.
  const example = (open[0] || closed[0] || hold[0])?.symbol;
  if (example) out.push(`<code>/pnl ${esc(handle)} ${esc(example)}</code> for that coin's tape.`);
  return out.join('\n');
}

function ageShort(ts) {
  const s = Math.max(0, (Date.now() - ts) / 1000);
  if (s < 60) return `${Math.max(1, Math.round(s))}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 48 * 3600) return `${(s / 3600).toFixed(1)}h`;
  return `${(s / 86400).toFixed(1)}d`;
}

function oneToken(db, handleArg, tokenArg) {
  const handle = R.resolveLeader(db, handleArg);
  if (!handle) return `No leader called <b>${esc(handleArg)}</b>. Try /who or /leaders.`;

  const hits = R.resolveLeaderToken(db, handle, tokenArg);
  if (!hits.length) {
    const known = R.leaderTokens(db, handle)
      .map((t) => t.symbol || t.token.slice(0, 8))
      .slice(0, 12);
    return (
      `${icon(handle)} <b>${esc(handle)}</b> has no tape for <b>${esc(tokenArg)}</b>.` +
      (known.length ? `\nTokens: ${known.map(esc).join(', ')}` : '')
    );
  }

  const out = [`${icon(handle)} <b>${esc(handle)}</b>`];

  for (const hit of hits) {
    const chain = CHAINS[hit.chain_id];
    const sym = hit.symbol || hit.token.slice(0, 8);
    const events = R.leaderTokenEvents(db, handle, hit.chain_id, hit.token);
    const copies = R.leaderPositions(db, handle, 'hold_24h').filter(
      (p) => p.chain_id === hit.chain_id && p.token === hit.token
    );

    out.push('');
    out.push(`<b>${esc(sym)}</b> · ${chain ? esc(chain.name) : hit.chain_id} · ${hit.buys}b/${hit.sells}s`);
    if (events[0]?.side === 'sell') {
      out.push(
        '<i>Tape starts on a sell. The bag was already open (bought before we watched, or a buy that skipped the FOMO vault). This is the exit, not the trade.</i>'
      );
    }
    const tape = events.map((e) => {
      const bits = [ageShort(e.ts).padStart(5), e.side === 'buy' ? 'BUY ' : 'SELL', (exact(e.size_usd) || '?').padStart(8)];
      if (e.leader_frac != null) bits.push(`${(e.leader_frac * 100).toFixed(e.leader_frac < 0.1 ? 1 : 0)}%`);
      if (e.mcap_usd) bits.push(money(e.mcap_usd));
      return bits.join('  ');
    });
    out.push(pre(tape.join('\n')));

    if (copies.length) {
      const copyLines = copies.map((p) => {
        const live =
          p.status === 'closed'
            ? { usd: p.pnl_usd, pct: p.pnl_pct }
            : p.entry_price && p.last_price
              ? {
                  usd: p.size_usd * (p.qty || 0) * (p.last_price / p.entry_price - 1),
                  pct: (p.last_price / p.entry_price - 1) * 100,
                }
              : { usd: null, pct: null };
        const st = p.status === 'open' ? 'opn' : p.status === 'closed' ? 'cls' : 'skp';
        const why = p.exit_reason || p.skip_reason || '';
        return `${st}  ${usd(live.usd).padStart(9)}  ${pct(live.pct).padStart(7)}  ${why}`.trimEnd();
      });
      const copyNote =
        events[0]?.side === 'sell'
          ? '<i>Our $100 copy is only the later add, not the dump above.</i>'
          : '<i>Our $100 copy (hold_24h)</i>';
      out.push(`${copyNote}\n${pre(copyLines.join('\n'))}`);
    }

    const lastTx = [...events].reverse().find((e) => e.tx_hash)?.tx_hash;
    const links = tokenLinks(chain, hit.token, lastTx ? [`<a href="${chain.explorer}/tx/${lastTx}">last tx</a>`] : []);
    if (links) out.push(links);
  }

  return out.join('\n');
}

function policies() {
  const body = Object.entries(POLICIES)
    .map(([name, r]) => `${name.padEnd(15)} ${r.onLeaderSell}${r.trailPct ? ` @${r.trailPct}%` : ''}`)
    .join('\n');
  return (
    '<b>Exit policies</b>\nAll five run on the same event stream at once, so the data picks the winner.\n' +
    pre(body) +
    '\n<i>hold_24h ignores the leader entirely and is the baseline the others must beat.</i>'
  );
}

module.exports = { overview, leaders, who, clusters, scoreboard, positions, perLeader, oneLeader, oneToken, policies, usd, pct, esc };
