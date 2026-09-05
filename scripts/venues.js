'use strict';

// Records which venue supplied the token on every historical trade, then voids
// copies opened on a venue nobody else uses.
//
// FOMO's own venues each hold a hundred-odd tokens. PONSVIL and AARTC were each
// supplied by a contract serving that one token, and both ended at zero
// liquidity with every leader still holding the exact bag they bought. Copies
// opened off those are not trades we could have made, so they are not scored.
//
// Pass --apply to write; without it, only reports.

require('dotenv').config();

const { open } = require('../src/db');
const { enabledChains } = require('../config/chains');
const { ENTRY } = require('../config/policy');
const { Rpc } = require('../src/chain/rpc');
const { settlement } = require('../src/chain/settle');
const { logger } = require('../src/util/log');

const log = logger('venues');

async function main() {
  const apply = process.argv.includes('--apply');

  const db = open();
  const chains = new Map(enabledChains().map((c) => [c.id, c]));
  const rpcs = new Map([...chains].map(([id, c]) => [id, new Rpc(c.wss())]));

  const rows = db
    .prepare(`SELECT id, chain_id, tx_hash, token, side FROM events WHERE venue IS NULL ORDER BY ts`)
    .all();
  log.info(`${rows.length} event(s) missing a venue${apply ? '' : ' (dry run, pass --apply to write)'}`);

  const set = db.prepare('UPDATE events SET venue = ? WHERE id = ?');
  let found = 0;
  for (const row of rows) {
    const chain = chains.get(row.chain_id);
    const rpc = rpcs.get(row.chain_id);
    if (!chain || !rpc) continue;

    let settled = null;
    try {
      settled = await settlement(rpc, chain, row.tx_hash, row.token, row.side);
    } catch (e) {
      log.warn(`${row.tx_hash.slice(0, 12)} ${e.message}`);
    }
    if (!settled?.venue) continue;
    found++;
    if (apply) set.run(settled.venue, row.id);
  }
  log.ok(`${apply ? 'recorded' : 'would record'} ${found} venue(s)`);

  if (!apply) return db.close();

  const venues = db
    .prepare(
      `SELECT venue, COUNT(DISTINCT token) tokens, COUNT(*) events
       FROM events WHERE venue IS NOT NULL GROUP BY venue ORDER BY tokens DESC`
    )
    .all();
  log.info(`${venues.length} distinct venue(s), the broadest few:`);
  for (const v of venues.slice(0, 5)) log.dim(`  ${v.venue}  ${v.tokens} token(s), ${v.events} event(s)`);

  // Judged per token, not per event. A token that has ever traded on a shared
  // venue is fine even if a few of its fills routed through somewhere odd; only
  // a token that has never touched anything but a private venue is condemned.
  const PRIVATE = `
    SELECT e.chain_id, e.token FROM events e
    WHERE e.venue IS NOT NULL
    GROUP BY e.chain_id, e.token
    HAVING MAX((SELECT COUNT(DISTINCT token) FROM events v
                WHERE v.venue = e.venue AND v.chain_id = e.chain_id)) < ${ENTRY.minVenueTokens}`;

  const affected = db
    .prepare(
      `SELECT t.symbol, p.token, COUNT(*) events FROM (${PRIVATE}) p
       LEFT JOIN tokens t ON t.chain_id = p.chain_id AND t.address = p.token
       LEFT JOIN events e ON e.chain_id = p.chain_id AND e.token = p.token
       GROUP BY p.token ORDER BY events DESC`
    )
    .all();
  log.info(`${affected.length} token(s) never seen on a shared venue:`);
  for (const a of affected) log.dim(`  ${(a.symbol || a.token).padEnd(14)} ${a.events} event(s)`);

  // Void rather than delete. A copy opened on a private venue was never a real
  // opportunity, so it should not appear as a loss any more than as a win.
  const voided = db
    .prepare(
      `UPDATE positions
       SET status = 'skipped', skip_reason = 'private_venue',
           pnl_usd = NULL, pnl_pct = NULL, exit_reason = NULL
       WHERE (chain_id, token) IN (SELECT chain_id, token FROM (${PRIVATE}))
         AND IFNULL(skip_reason, '') <> 'private_venue'`
    )
    .run();
  log.ok(`voided ${voided.changes} position(s)`);

  db.close();
}

main().catch((e) => {
  log.error(e.stack || e.message);
  process.exit(1);
});
