'use strict';

require('dotenv').config();

const { open, statements } = require('../src/db');
const { CHAINS } = require('../config/chains');
const { POLICIES, ENTRY } = require('../config/policy');

const db = open();
statements(db);

const usd = (n) => (n == null ? '-' : `${n < 0 ? '-' : ''}$${Math.abs(n).toFixed(2)}`);
const pct = (n) => (n == null ? '-' : `${n >= 0 ? '+' : ''}${n.toFixed(1)}%`);
const bar = (t) => console.log(`\n\x1b[1m${t}\x1b[0m\n${'-'.repeat(t.length)}`);

function median(xs) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// --- Leader activity -------------------------------------------------------
bar('Leader activity');
const totals = db.prepare('SELECT COUNT(*) n, MIN(ts) a, MAX(ts) b FROM events').get();
if (!totals.n) {
  console.log('No events yet. Run `npm run backfill` or leave `npm start` running.');
  process.exit(0);
}
const span = (totals.b - totals.a) / 3_600_000;
console.log(`${totals.n} trades over ${span.toFixed(1)}h (${(totals.n / Math.max(span, 0.01)).toFixed(1)}/hour)`);

for (const row of db
  .prepare(
    `SELECT chain_id,
            SUM(side = 'buy')  buys,
            SUM(side = 'sell') sells,
            COUNT(DISTINCT token)  tokens,
            COUNT(DISTINCT leader) leaders
     FROM events GROUP BY chain_id`
  )
  .all()) {
  const name = CHAINS[row.chain_id]?.name || row.chain_id;
  console.log(`  ${name.padEnd(16)} ${row.buys} buys, ${row.sells} sells, ${row.tokens} tokens, ${row.leaders} active leaders`);
}

bar('Most active leaders');
for (const r of db
  .prepare(
    `SELECT leader, COUNT(*) n, SUM(side = 'buy') buys, SUM(side = 'sell') sells,
            COUNT(DISTINCT token) tokens
     FROM events GROUP BY leader ORDER BY n DESC LIMIT 12`
  )
  .all()) {
  console.log(`  ${r.leader.padEnd(18)} ${String(r.n).padStart(4)} trades  ${String(r.buys).padStart(3)}b/${String(r.sells).padStart(3)}s  ${r.tokens} tokens`);
}

// Tokens several leaders bought independently: the strongest signal in the
// dataset and the case the current one-leader-per-position rule ignores.
const clustered = db
  .prepare(
    `SELECT token, chain_id, COUNT(DISTINCT leader) n, GROUP_CONCAT(DISTINCT leader) who
     FROM events WHERE side = 'buy'
     GROUP BY chain_id, token HAVING n > 1 ORDER BY n DESC LIMIT 8`
  )
  .all();
if (clustered.length) {
  bar('Tokens bought by multiple leaders');
  for (const r of clustered) {
    const sym = db.prepare('SELECT symbol FROM tokens WHERE chain_id = ? AND address = ?').get(r.chain_id, r.token);
    console.log(`  ${(sym?.symbol || r.token.slice(0, 10)).padEnd(12)} ${r.n} leaders: ${r.who}`);
  }
}

// --- Entry cost ------------------------------------------------------------
const drift = db
  .prepare(
    `SELECT (entry_price / leader_price - 1) * 100 d FROM positions
     WHERE policy = 'hold_24h' AND entry_price IS NOT NULL AND leader_price > 0`
  )
  .all()
  .map((r) => r.d);

if (drift.length) {
  bar(`Entry cost (our fill vs leader's, ${ENTRY.entryDelayMs / 1000}s later)`);
  console.log(`  positions: ${drift.length}`);
  console.log(`  mean:      ${pct(drift.reduce((a, b) => a + b, 0) / drift.length)}`);
  console.log(`  median:    ${pct(median(drift))}`);
  console.log(`  worst:     ${pct(Math.max(...drift))}`);
  console.log('  A positive number is how much of their pump we buy. This is the tax on copying.');
}

// --- Policy scoreboard -----------------------------------------------------
bar('Policy scoreboard');
console.log(`  (notional ${usd(ENTRY.sizeUsd)} per copied buy)\n`);
console.log(
  `  ${'policy'.padEnd(15)} ${'closed'.padStart(6)} ${'open'.padStart(5)} ${'win%'.padStart(6)} ${'total'.padStart(10)} ${'avg'.padStart(8)} ${'median'.padStart(8)}`
);

const scored = [];
for (const policy of Object.keys(POLICIES)) {
  const closed = db
    .prepare("SELECT pnl_usd, pnl_pct FROM positions WHERE policy = ? AND status = 'closed'")
    .all(policy);
  const openN = db.prepare("SELECT COUNT(*) n FROM positions WHERE policy = ? AND status = 'open'").get(policy).n;
  if (!closed.length) {
    console.log(`  ${policy.padEnd(15)} ${String(0).padStart(6)} ${String(openN).padStart(5)} ${'-'.padStart(6)} ${'-'.padStart(10)} ${'-'.padStart(8)} ${'-'.padStart(8)}`);
    continue;
  }
  const pnls = closed.map((c) => c.pnl_usd || 0);
  const pcts = closed.map((c) => c.pnl_pct || 0);
  const total = pnls.reduce((a, b) => a + b, 0);
  const wins = pnls.filter((p) => p > 0).length;
  scored.push({ policy, total });
  console.log(
    `  ${policy.padEnd(15)} ${String(closed.length).padStart(6)} ${String(openN).padStart(5)} ${((wins / closed.length) * 100).toFixed(0).padStart(5)}% ${usd(total).padStart(10)} ${pct(pcts.reduce((a, b) => a + b, 0) / pcts.length).padStart(8)} ${pct(median(pcts)).padStart(8)}`
  );
}

if (scored.length) {
  const best = scored.reduce((a, b) => (b.total > a.total ? b : a));
  const base = scored.find((s) => s.policy === 'hold_24h');
  console.log(`\n  Best: ${best.policy} at ${usd(best.total)}`);
  if (base && best.policy !== 'hold_24h') {
    console.log(`  vs hold_24h baseline ${usd(base.total)} -> exit logic is worth ${usd(best.total - base.total)}`);
  } else if (base) {
    console.log('  The baseline wins, which means the exit rules are not adding anything yet.');
  }

  bar(`Per-leader PnL under ${best.policy}`);
  for (const r of db
    .prepare(
      `SELECT leader, COUNT(*) n, SUM(pnl_usd) total, AVG(pnl_pct) avg
       FROM positions WHERE policy = ? AND status = 'closed'
       GROUP BY leader ORDER BY total DESC`
    )
    .all(best.policy)) {
    console.log(`  ${r.leader.padEnd(18)} ${String(r.n).padStart(3)} trades  ${usd(r.total).padStart(10)}  ${pct(r.avg).padStart(8)}`);
  }

  bar('Exit reasons');
  for (const r of db
    .prepare("SELECT exit_reason, COUNT(*) n, SUM(pnl_usd) total FROM positions WHERE policy = ? AND status = 'closed' GROUP BY exit_reason ORDER BY n DESC")
    .all(best.policy)) {
    console.log(`  ${(r.exit_reason || '?').padEnd(22)} ${String(r.n).padStart(4)}  ${usd(r.total)}`);
  }
}

// --- Skips -----------------------------------------------------------------
const skips = db
  .prepare("SELECT skip_reason, COUNT(*) n FROM positions WHERE status = 'skipped' AND policy = 'hold_24h' GROUP BY skip_reason ORDER BY n DESC")
  .all();
if (skips.length) {
  bar('Skipped entries');
  for (const s of skips) console.log(`  ${(s.skip_reason || '?').padEnd(22)} ${s.n}`);
}

db.close();
