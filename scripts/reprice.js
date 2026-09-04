'use strict';

// Recovers the dollar value of trades we recorded without one.
//
// Backfilled events were left unpriced on purpose, because the only price
// source at the time was DexScreener and it serves today's number. The
// settlement leg has no such problem: it is written into the transaction, so a
// nine-hour-old trade prices exactly as well as a fresh one. This walks the
// unpriced events and fills them in from chain.
//
// Pass --all to also re-price events that currently hold a DexScreener estimate
// and --apply to write. Without --apply it only reports.

require('dotenv').config();

const { open, statements } = require('../src/db');
const { enabledChains } = require('../config/chains');
const { Rpc } = require('../src/chain/rpc');
const { settlement } = require('../src/chain/settle');
const { logger } = require('../src/util/log');

const log = logger('reprice');

async function main() {
  const apply = process.argv.includes('--apply');
  const all = process.argv.includes('--all');

  const db = open();
  statements(db);
  const chains = new Map(enabledChains().map((c) => [c.id, c]));
  const rpcs = new Map([...chains].map(([id, c]) => [id, new Rpc(c.wss())]));

  const rows = db
    .prepare(
      `SELECT e.id, e.chain_id, e.tx_hash, e.token, e.amount, e.side, e.leader,
              e.price_usd, e.size_usd, e.price_source, t.symbol
       FROM events e
       LEFT JOIN tokens t ON t.chain_id = e.chain_id AND t.address = e.token
       WHERE e.amount > 0
         AND (${all ? "e.price_source IS NULL OR e.price_source <> 'exec'" : 'e.price_usd IS NULL'})
       ORDER BY e.ts`
    )
    .all();

  log.info(`${rows.length} event(s) to price${apply ? '' : ' (dry run, pass --apply to write)'}`);

  const update = db.prepare(
    `UPDATE events SET price_usd = ?, size_usd = ?, price_source = 'exec' WHERE id = ?`
  );

  let priced = 0;
  let missing = 0;
  let totalUsd = 0;

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
      missing++;
      continue;
    }

    const price = settled.usd / row.amount;
    priced++;
    totalUsd += settled.usd;

    if (apply) update.run(price, settled.usd, row.id);
    else if (priced <= 12) {
      const was = row.price_usd ? `was $${row.price_usd}` : 'was unpriced';
      log.dim(
        `  ${chain.slug} ${row.side} ${(row.symbol || '?').padEnd(11)} $${settled.usd.toFixed(2).padStart(10)} @ ${price.toPrecision(4)}  (${was})`
      );
    }
  }

  log.ok(
    `${apply ? 'priced' : 'would price'} ${priced} event(s) worth $${Math.round(totalUsd).toLocaleString()}` +
      (missing ? `, ${missing} with no settlement leg` : '')
  );

  // A position stores the leader's fill at the time it was opened, and the
  // entry-cost report is our fill measured against it. Leaving that as the old
  // estimate while the event it came from is now exact would compare two
  // different sources. Voided positions keep their bad numbers, since the point
  // of voiding them was that nothing about them is trustworthy.
  const sync = db.prepare(
    `UPDATE positions
     SET leader_price = (SELECT price_usd FROM events WHERE events.id = positions.open_event)
     WHERE IFNULL(skip_reason, '') <> 'bad_price'
       AND open_event IN (SELECT id FROM events WHERE price_source = 'exec')
       AND leader_price IS NOT (SELECT price_usd FROM events WHERE events.id = positions.open_event)`
  );
  const synced = apply ? sync.run().changes : 0;
  if (apply && synced) log.ok(`realigned leader fill on ${synced} position(s)`);

  db.close();
}

main().catch((e) => {
  log.err(e.stack || e.message);
  process.exit(1);
});
