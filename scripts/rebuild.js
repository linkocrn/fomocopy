'use strict';

// Rebuilds positions that were voided by a skip reason we have since retracted.
//
// Voiding overwrote status and PnL but left the fills alone, and fills are the
// source of truth: each one records the fraction sold, the price and the PnL.
// So a voided position can be reconstructed exactly rather than guessed at.
//
//   node scripts/rebuild.js private_venue --apply

require('dotenv').config();

const { open } = require('../src/db');
const { logger } = require('../src/util/log');

const log = logger('rebuild');

function main() {
  const reason = process.argv[2];
  const apply = process.argv.includes('--apply');
  if (!reason) {
    log.error('usage: node scripts/rebuild.js <skip_reason> [--apply]');
    process.exit(1);
  }

  const db = open();
  const rows = db.prepare('SELECT * FROM positions WHERE skip_reason = ?').all(reason);
  log.info(`${rows.length} position(s) marked '${reason}'${apply ? '' : ' (dry run, pass --apply to write)'}`);

  const fillsFor = db.prepare('SELECT * FROM fills WHERE position_id = ? ORDER BY ts, id');
  const toOpen = db.prepare(
    "UPDATE positions SET status = 'open', skip_reason = NULL, qty = ?, exit_price = NULL, exit_ts = NULL, exit_reason = NULL, pnl_usd = NULL, pnl_pct = NULL WHERE id = ?"
  );
  const toClosed = db.prepare(
    "UPDATE positions SET status = 'closed', skip_reason = NULL, qty = 0, exit_price = ?, exit_ts = ?, exit_reason = ?, pnl_usd = ?, pnl_pct = ? WHERE id = ?"
  );
  const toPending = db.prepare(
    "UPDATE positions SET status = 'pending', skip_reason = NULL, qty = 1.0, exit_price = NULL, exit_ts = NULL, exit_reason = NULL, pnl_usd = NULL, pnl_pct = NULL WHERE id = ?"
  );

  let opened = 0;
  let closed = 0;
  let pending = 0;

  const run = db.transaction(() => {
    for (const p of rows) {
      const fills = fillsFor.all(p.id);
      // No entry fill means the position never activated.
      if (!fills.length) {
        pending++;
        if (apply) toPending.run(p.id);
        continue;
      }

      const exits = fills.filter((f) => f.fraction > 0);
      const sold = exits.reduce((sum, f) => sum + f.fraction, 0);

      if (sold >= 1 - 1e-6) {
        const last = exits[exits.length - 1];
        const pnl = fills.reduce((sum, f) => sum + (f.pnl_usd || 0), 0);
        const invested = sold * p.size_usd;
        closed++;
        if (apply) toClosed.run(last.price, last.ts, last.reason, pnl, invested ? (pnl / invested) * 100 : 0, p.id);
      } else {
        opened++;
        if (apply) toOpen.run(1 - sold, p.id);
      }
    }
  });
  run();

  log.ok(`${apply ? 'restored' : 'would restore'} ${closed} closed, ${opened} open, ${pending} pending`);
  db.close();
}

main();
