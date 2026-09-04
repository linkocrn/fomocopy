'use strict';

// Telegram-flavoured rendering of the shared report data. Wide tables get
// wrapped in <pre> so the monospace font keeps the columns lined up on mobile.

const R = require('../report');
const { POLICIES } = require('../../config/policy');
const { LEADERS, icon } = require('../../config/leaders');

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
    out.push('<i>Positive means we bought their pump. This is the tax on copying.</i>');
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

module.exports = { overview, leaders, who, clusters, scoreboard, positions, perLeader, policies, usd, pct, esc };
