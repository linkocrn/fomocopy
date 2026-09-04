'use strict';

require('dotenv').config();

// Terminal rendering of the shared report queries. The Telegram bot renders the
// same data from src/report.js, so the two views cannot drift apart.

const { open } = require('../src/db');
const R = require('../src/report');

const db = open();

const usd = (n) => (n == null ? '-' : `${n < 0 ? '-' : ''}$${Math.abs(n).toFixed(2)}`);
const pct = (n) => (n == null ? '-' : `${n >= 0 ? '+' : ''}${n.toFixed(1)}%`);
const bar = (t) => console.log(`\n\x1b[1m${t}\x1b[0m\n${'-'.repeat(t.length)}`);

const o = R.overview(db);
bar('Leader activity');
if (!o.events) {
  console.log('No events yet. Run `npm run backfill` or leave `npm start` running.');
  process.exit(0);
}
console.log(`${o.events} trades over ${o.hours.toFixed(1)}h (${o.perHour.toFixed(1)}/hour)`);
for (const c of o.chains) {
  console.log(`  ${c.name.padEnd(16)} ${c.buys} buys, ${c.sells} sells, ${c.tokens} tokens, ${c.leaders} active leaders`);
}

bar('Most active leaders');
for (const r of R.leaders(db, 12)) {
  console.log(`  ${r.leader.padEnd(18)} ${String(r.n).padStart(4)} trades  ${String(r.buys).padStart(3)}b/${String(r.sells).padStart(3)}s  ${r.tokens} tokens`);
}

const clusters = R.clusters(db, 8);
if (clusters.length) {
  bar('Tokens bought by multiple leaders');
  for (const r of clusters) {
    console.log(`  ${(r.symbol || r.token.slice(0, 10)).padEnd(12)} ${r.n} leaders: ${r.who}`);
  }
}

const e = R.entryCost(db);
if (e) {
  bar(`Entry cost (our fill vs leader's, ${e.delaySec}s later)`);
  console.log(`  positions: ${e.n}`);
  console.log(`  mean:      ${pct(e.mean)}`);
  console.log(`  median:    ${pct(e.median)}`);
  console.log(`  worst:     ${pct(e.worst)}`);
  console.log('  A positive number is how much of their pump we buy. This is the tax on copying.');
}

const s = R.scoreboard(db);
bar('Policy scoreboard');
console.log(`  (notional ${usd(s.sizeUsd)} per copied buy)\n`);
console.log(`  ${'policy'.padEnd(15)} ${'closed'.padStart(6)} ${'open'.padStart(5)} ${'win%'.padStart(6)} ${'total'.padStart(10)} ${'avg'.padStart(8)} ${'median'.padStart(8)}`);
for (const r of s.rows) {
  console.log(
    `  ${r.policy.padEnd(15)} ${String(r.closed).padStart(6)} ${String(r.open).padStart(5)} ` +
      `${(r.winPct == null ? '-' : `${r.winPct.toFixed(0)}%`).padStart(6)} ${(r.total == null ? '-' : usd(r.total)).padStart(10)} ` +
      `${pct(r.avg).padStart(8)} ${pct(r.med).padStart(8)}`
  );
}

if (s.best) {
  console.log(`\n  Best: ${s.best.policy} at ${usd(s.best.total)}`);
  if (s.baseline?.total != null && s.best.policy !== 'hold_24h') {
    console.log(`  vs hold_24h baseline ${usd(s.baseline.total)} -> exit logic is worth ${usd(s.best.total - s.baseline.total)}`);
  } else if (s.baseline?.total != null) {
    console.log('  The baseline wins, which means the exit rules are not adding anything yet.');
  }

  bar(`Per-leader PnL under ${s.best.policy}`);
  for (const r of R.perLeader(db, s.best.policy)) {
    console.log(`  ${r.leader.padEnd(18)} ${String(r.n).padStart(3)} trades  ${usd(r.total).padStart(10)}  ${pct(r.avg).padStart(8)}`);
  }

  bar('Exit reasons');
  for (const r of R.exitReasons(db, s.best.policy)) {
    console.log(`  ${(r.exit_reason || '?').padEnd(22)} ${String(r.n).padStart(4)}  ${usd(r.total)}`);
  }
}

const skips = R.skips(db);
if (skips.length) {
  bar('Skipped entries');
  for (const sk of skips) console.log(`  ${(sk.skip_reason || '?').padEnd(22)} ${sk.n}`);
}

db.close();
