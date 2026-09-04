'use strict';

require('dotenv').config();

// Records historical leader trades so `npm run report` has something to say on
// day one instead of after a week of watching.
//
// Events only. No shadow positions are opened, because DexScreener serves the
// current price and a week-old trade priced at today's number would look like
// PnL when it is noise.
//
//   node scripts/backfill.js [blocks]

const { logger } = require('../src/util/log');
const { enabledChains } = require('../config/chains');
const { open, statements } = require('../src/db');
const { Rpc } = require('../src/chain/rpc');
const { Watcher } = require('../src/chain/watcher');
const { Engine } = require('../src/shadow/engine');

const log = logger('backfill');

async function main() {
  const blocks = Number(process.argv[2] || 45_000);
  const chains = enabledChains();
  const db = open();
  const st = statements(db);
  const rpcs = new Map(chains.map((c) => [c.id, new Rpc(c.wss())]));
  const engine = new Engine({ db, st, chains, rpcs });

  for (const chain of chains) {
    const rpc = rpcs.get(chain.id);
    const tip = await rpc.blockNumber();
    const from = Math.max(1, tip - blocks);

    const [tNow, tThen] = await Promise.all([rpc.blockTimestamp(tip), rpc.blockTimestamp(from)]);
    const hours = tNow && tThen ? ((tNow - tThen) / 3_600_000).toFixed(1) : '?';
    log.info(`${chain.name}: blocks ${from} -> ${tip} (~${hours}h)`);

    const watcher = new Watcher(chain, { onTrade: () => {}, cursor: { get: () => null, set: () => {} } });
    const found = await watcher.backfill(from, tip, (trade) =>
      engine.handleTrade(trade, { shadow: false, market: false })
    );
    log.ok(`${chain.name}: ${found} trades recorded`);
  }

  db.close();
}

main().catch((e) => {
  log.error(e.stack || e.message);
  process.exit(1);
});
