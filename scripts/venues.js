'use strict';

// Records which venue supplied the token on every historical trade.
//
// This was written to test a theory: that a token whose float sits in a venue
// nobody else trades through is controlled by one party and therefore a rug
// risk. PONSVIL and AARTC both fit and both died. The theory did not survive
// contact with the rest of the data. Of 36 tokens it flags, 33 are healthy,
// including WETH at $29m of liquidity, cbBTC, and the tokenised stocks. Having
// a dedicated pool is what any serious asset looks like.
//
// The venue is still worth recording, it just is not a quality signal.
//
// Pass --apply to write; without it, only reports.

require('dotenv').config();

const { open } = require('../src/db');
const { enabledChains } = require('../config/chains');
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

  db.close();
}

main().catch((e) => {
  log.error(e.stack || e.message);
  process.exit(1);
});
