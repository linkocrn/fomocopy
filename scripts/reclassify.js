'use strict';

// Separates real trades from free token movements in history.
//
// A FOMO swap always moves a stablecoin. When a transaction moves tokens into a
// leader's wallet through the vault and no stablecoin moves at all, nobody
// bought anything: the supply was handed over. We recorded those as buys, sized
// them off a DexScreener quote, and let them count towards a leader's activity.
// Roughly one event in eight turned out to be one of these, and they cluster
// hard on a handful of wallets, so the leaders receiving the most of them were
// being credited with trades they never made.
//
// Walks every event, sets kind, and voids any copy opened from a non-trade.
// Pass --apply to write; without it, only reports.

require('dotenv').config();

const { open } = require('../src/db');
const { enabledChains } = require('../config/chains');
const { Rpc } = require('../src/chain/rpc');
const { settlement } = require('../src/chain/settle');
const { logger } = require('../src/util/log');

const log = logger('reclassify');

async function main() {
  const apply = process.argv.includes('--apply');

  const db = open();
  const chains = new Map(enabledChains().map((c) => [c.id, c]));
  const rpcs = new Map([...chains].map(([id, c]) => [id, new Rpc(c.wss())]));

  // An event priced from its own settlement leg is a trade by construction, so
  // only the rest needs a receipt fetched.
  const rows = db
    .prepare(
      `SELECT e.id, e.chain_id, e.tx_hash, e.token, e.leader, e.side, e.size_usd, t.symbol
       FROM events e
       LEFT JOIN tokens t ON t.chain_id = e.chain_id AND t.address = e.token
       WHERE IFNULL(e.price_source, '') <> 'exec' AND e.kind = 'trade'
       ORDER BY e.ts`
    )
    .all();

  log.info(`${rows.length} event(s) to check${apply ? '' : ' (dry run, pass --apply to write)'}`);

  const mark = db.prepare("UPDATE events SET kind = 'transfer' WHERE id = ?");
  const byLeader = new Map();
  const free = [];
  let unreadable = 0;

  for (const row of rows) {
    const chain = chains.get(row.chain_id);
    const rpc = rpcs.get(row.chain_id);
    if (!chain || !rpc) continue;

    let settled = null;
    try {
      settled = await settlement(rpc, chain, row.tx_hash, row.token);
    } catch (e) {
      log.warn(`${row.tx_hash.slice(0, 12)} ${e.message}`);
    }
    if (!settled) {
      unreadable++;
      continue;
    }
    if (settled.paid) continue;

    free.push(row.id);
    const b = byLeader.get(row.leader) || { n: 0, usd: 0 };
    b.n++;
    b.usd += row.size_usd || 0;
    byLeader.set(row.leader, b);
    if (apply) mark.run(row.id);
  }

  for (const [leader, b] of [...byLeader].sort((a, b) => b[1].n - a[1].n)) {
    log.dim(`  ${leader.padEnd(18)} ${String(b.n).padStart(4)} free  (credited $${Math.round(b.usd).toLocaleString()})`);
  }
  log.ok(
    `${apply ? 'marked' : 'would mark'} ${free.length} event(s) as transfers` +
      (unreadable ? `, ${unreadable} receipt(s) unreadable` : '')
  );

  // Copies opened off a non-trade were never valid. Void rather than delete, so
  // the reason stays visible next to every other skip.
  if (free.length) {
    const q = free.map(() => '?').join(',');
    const affected = db
      .prepare(
        `SELECT status, COUNT(*) n FROM positions
         WHERE open_event IN (${q}) AND IFNULL(skip_reason, '') <> 'not_a_trade'
         GROUP BY status`
      )
      .all(...free);
    for (const a of affected) log.dim(`  ${a.n} ${a.status} position(s) to void`);

    if (apply) {
      const voided = db
        .prepare(
          `UPDATE positions
           SET status = 'skipped', skip_reason = 'not_a_trade', pnl_usd = NULL, pnl_pct = NULL
           WHERE open_event IN (${q}) AND IFNULL(skip_reason, '') <> 'not_a_trade'`
        )
        .run(...free);
      if (voided.changes) log.ok(`voided ${voided.changes} position(s)`);
    }
  }

  db.close();
}

main().catch((e) => {
  log.err(e.stack || e.message);
  process.exit(1);
});
