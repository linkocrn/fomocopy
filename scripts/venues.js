'use strict';

// Records which venue supplied the token on every historical trade, then voids
// copies opened while the supply could still have been in one pair of hands.
//
// The venue alone is not a quality signal, and an earlier version of this
// script wrongly assumed it was: of the 36 tokens it condemned, 33 were fine,
// among them WETH at $29m of liquidity, cbBTC and the tokenised stocks. Having
// a dedicated pool is what a real asset looks like.
//
// What does separate them is the pool's age alongside it. See
// ENTRY.minVenueTokens for the reasoning and the numbers.
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

  const solo = venues.filter((v) => v.tokens === 1).length;
  log.info(`${solo} venue(s) serve exactly one token, which on its own means nothing`);

  // Judged per token: its own pool, and young when the leaders first arrived.
  const SUSPECT = `
    SELECT e.chain_id, e.token FROM events e
    WHERE e.venue IS NOT NULL
    GROUP BY e.chain_id, e.token
    HAVING MAX((SELECT COUNT(DISTINCT token) FROM events v
                WHERE v.venue = e.venue AND v.chain_id = e.chain_id)) < ${ENTRY.minVenueTokens}
       AND MIN(e.ts) - (SELECT pair_created_at FROM events x
                        WHERE x.chain_id = e.chain_id AND x.token = e.token
                          AND x.pair_created_at IS NOT NULL LIMIT 1) < ${ENTRY.minOwnPoolAgeMs}`;

  const hits = db
    .prepare(
      `SELECT t.symbol, s.token,
              (SELECT COUNT(*) FROM events e WHERE e.token = s.token) events,
              (SELECT COUNT(DISTINCT leader) FROM events e WHERE e.token = s.token) leaders
       FROM (${SUSPECT}) s
       LEFT JOIN tokens t ON t.chain_id = s.chain_id AND t.address = s.token
       ORDER BY leaders DESC`
    )
    .all();
  log.info(`${hits.length} token(s) whose supply was still controllable when leaders bought:`);
  for (const h of hits) log.dim(`  ${(h.symbol || h.token).padEnd(14)} ${h.leaders} leader(s), ${h.events} event(s)`);

  // Void rather than delete. These were never opportunities we had, so they
  // belong in the scoreboard neither as a loss nor as a win.
  const voided = db
    .prepare(
      `UPDATE positions
       SET status = 'skipped', skip_reason = 'controlled_supply',
           pnl_usd = NULL, pnl_pct = NULL, exit_reason = NULL
       WHERE (chain_id, token) IN (SELECT chain_id, token FROM (${SUSPECT}))
         AND IFNULL(skip_reason, '') <> 'controlled_supply'`
    )
    .run();
  log.ok(`voided ${voided.changes} position(s)`);

  db.close();
}

main().catch((e) => {
  log.error(e.stack || e.message);
  process.exit(1);
});
