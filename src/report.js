'use strict';

// Shared report queries. `scripts/report.js` renders these to a terminal and the
// Telegram bot renders the same data to chat, so the two can never drift apart.

const { CHAINS } = require('../config/chains');
const { POLICIES, ENTRY } = require('../config/policy');

function median(xs) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function overview(db) {
  const t = db.prepare('SELECT COUNT(*) n, MIN(ts) a, MAX(ts) b FROM events').get();
  if (!t.n) return { events: 0 };
  const hours = (t.b - t.a) / 3_600_000;
  const chains = db
    .prepare(
      `SELECT chain_id,
              SUM(side = 'buy')  buys,
              SUM(side = 'sell') sells,
              COUNT(DISTINCT token)  tokens,
              COUNT(DISTINCT leader) leaders
       FROM events GROUP BY chain_id`
    )
    .all()
    .map((r) => ({ ...r, name: CHAINS[r.chain_id]?.name || String(r.chain_id) }));
  return { events: t.n, hours, perHour: t.n / Math.max(hours, 0.01), chains };
}

function leaders(db, limit = 12) {
  return db
    .prepare(
      `SELECT leader, COUNT(*) n, SUM(side = 'buy') buys, SUM(side = 'sell') sells,
              COUNT(DISTINCT token) tokens
       FROM events GROUP BY leader ORDER BY n DESC LIMIT ?`
    )
    .all(limit);
}

// Tokens several leaders bought independently. The strongest signal in the
// dataset, and the case the one-leader-per-position rule currently ignores.
function clusters(db, limit = 8) {
  return db
    .prepare(
      `SELECT e.token, e.chain_id, COUNT(DISTINCT e.leader) n,
              GROUP_CONCAT(DISTINCT e.leader) who,
              (SELECT symbol FROM tokens t WHERE t.chain_id = e.chain_id AND t.address = e.token) symbol
       FROM events e WHERE e.side = 'buy'
       GROUP BY e.chain_id, e.token HAVING n > 1 ORDER BY n DESC LIMIT ?`
    )
    .all(limit);
}

// How far price moved between the leader's fill and ours. The tax on copying.
function entryCost(db) {
  const d = db
    .prepare(
      `SELECT (entry_price / leader_price - 1) * 100 v FROM positions
       WHERE policy = 'hold_24h' AND entry_price IS NOT NULL AND leader_price > 0`
    )
    .all()
    .map((r) => r.v);
  if (!d.length) return null;
  return {
    n: d.length,
    mean: d.reduce((a, b) => a + b, 0) / d.length,
    median: median(d),
    worst: Math.max(...d),
    delaySec: ENTRY.entryDelayMs / 1000,
  };
}

function scoreboard(db) {
  const rows = [];
  for (const policy of Object.keys(POLICIES)) {
    const closed = db
      .prepare("SELECT pnl_usd, pnl_pct FROM positions WHERE policy = ? AND status = 'closed'")
      .all(policy);
    const open = db.prepare("SELECT COUNT(*) n FROM positions WHERE policy = ? AND status = 'open'").get(policy).n;
    if (!closed.length) {
      rows.push({ policy, closed: 0, open, total: null, avg: null, med: null, winPct: null });
      continue;
    }
    const pnls = closed.map((c) => c.pnl_usd || 0);
    const pcts = closed.map((c) => c.pnl_pct || 0);
    rows.push({
      policy,
      closed: closed.length,
      open,
      total: pnls.reduce((a, b) => a + b, 0),
      avg: pcts.reduce((a, b) => a + b, 0) / pcts.length,
      med: median(pcts),
      winPct: (pnls.filter((p) => p > 0).length / closed.length) * 100,
    });
  }
  const scored = rows.filter((r) => r.total != null);
  const best = scored.length ? scored.reduce((a, b) => (b.total > a.total ? b : a)) : null;
  const baseline = rows.find((r) => r.policy === 'hold_24h');
  return { rows, best, baseline, sizeUsd: ENTRY.sizeUsd };
}

function perLeader(db, policy) {
  return db
    .prepare(
      `SELECT leader, COUNT(*) n, SUM(pnl_usd) total, AVG(pnl_pct) avg
       FROM positions WHERE policy = ? AND status = 'closed'
       GROUP BY leader ORDER BY total DESC`
    )
    .all(policy);
}

// Mark-to-market on still-open copies. Uses the latest stored mark, so a
// runner that has not closed yet still shows up. This is not the score.
function perLeaderOpen(db, policy) {
  return db
    .prepare(
      `SELECT p.leader,
              COUNT(*) n,
              SUM(
                CASE WHEN p.entry_price > 0 AND m.price IS NOT NULL
                  THEN p.size_usd * p.qty * (m.price / p.entry_price - 1)
                END
              ) total,
              AVG(
                CASE WHEN p.entry_price > 0 AND m.price IS NOT NULL
                  THEN (m.price / p.entry_price - 1) * 100
                END
              ) avg
       FROM positions p
       LEFT JOIN marks m
         ON m.position_id = p.id
        AND m.offset_ms = (SELECT MAX(offset_ms) FROM marks WHERE position_id = p.id)
       WHERE p.policy = ? AND p.status = 'open'
       GROUP BY p.leader
       ORDER BY (total IS NULL), total DESC`
    )
    .all(policy);
}

function exitReasons(db, policy) {
  return db
    .prepare(
      `SELECT exit_reason, COUNT(*) n, SUM(pnl_usd) total
       FROM positions WHERE policy = ? AND status = 'closed'
       GROUP BY exit_reason ORDER BY n DESC`
    )
    .all(policy);
}

function skips(db) {
  return db
    .prepare(
      `SELECT skip_reason, COUNT(*) n FROM positions
       WHERE status = 'skipped' AND policy = 'hold_24h'
       GROUP BY skip_reason ORDER BY n DESC`
    )
    .all();
}

function openPositions(db, policy = 'hold_24h', limit = 20) {
  return db
    .prepare(
      `SELECT p.*, (SELECT symbol FROM tokens t WHERE t.chain_id = p.chain_id AND t.address = p.token) symbol,
              (SELECT price FROM marks m WHERE m.position_id = p.id ORDER BY offset_ms DESC LIMIT 1) last_price
       FROM positions p WHERE p.policy = ? AND p.status = 'open'
       ORDER BY p.opened_ts DESC LIMIT ?`
    )
    .all(policy, limit);
}

module.exports = {
  overview,
  leaders,
  clusters,
  entryCost,
  scoreboard,
  perLeader,
  perLeaderOpen,
  exitReasons,
  skips,
  openPositions,
  median,
};
