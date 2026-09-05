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
  log.info(`${venues.length} distinct venue(s):`);
  for (const v of venues.slice(0, 6)) log.dim(`  ${v.venue}  ${v.tokens} token(s), ${v.events} event(s)`);

  const priv = venues.filter((v) => v.tokens < ENTRY.minVenueTokens);
  log.info(`${priv.length} venue(s) serve fewer than ${ENTRY.minVenueTokens} tokens`);

  const affected = db
    .prepare(
      `SELECT DISTINCT t.symbol, e.token FROM events e
       LEFT JOIN tokens t ON t.chain_id = e.chain_id AND t.address = e.token
       WHERE e.venue IN (SELECT venue FROM events WHERE venue IS NOT NULL
                         GROUP BY venue HAVING COUNT(DISTINCT token) < ?)`
    )
    .all(ENTRY.minVenueTokens);
  for (const a of affected) log.dim(`  ${a.symbol || a.token}`);

  // Void rather than delete. A copy opened on a private venue was never a real
  // opportunity, so it should not appear as a loss any more than as a win.
  const voided = db
    .prepare(
      `UPDATE positions
       SET status = 'skipped', skip_reason = 'private_venue',
           pnl_usd = NULL, pnl_pct = NULL, exit_reason = NULL
       WHERE open_event IN (
         SELECT id FROM events WHERE venue IN (
           SELECT venue FROM events WHERE venue IS NOT NULL
           GROUP BY venue HAVING COUNT(DISTINCT token) < ?))
         AND IFNULL(skip_reason, '') <> 'private_venue'`
    )
    .run(ENTRY.minVenueTokens);
  log.ok(`voided ${voided.changes} position(s)`);

  db.close();
}

main().catch((e) => {
  log.err(e.stack || e.message);
  process.exit(1);
});
