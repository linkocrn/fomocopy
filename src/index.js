'use strict';

require('dotenv').config();

const { logger } = require('./util/log');
const { enabledChains } = require('../config/chains');
const { EVM_LEADERS } = require('../config/leaders');
const { open, statements } = require('./db');
const { Rpc } = require('./chain/rpc');
const { Watcher } = require('./chain/watcher');
const { Engine } = require('./shadow/engine');
const { Bot } = require('./telegram/bot');

const log = logger('fomocopy');
const TICK_MS = 15_000;

async function main() {
  const chains = enabledChains();
  const db = open();
  const st = statements(db);
  const startedAt = Date.now();

  const rpcs = new Map(chains.map((c) => [c.id, new Rpc(c.wss())]));

  let bot = null;
  const notify = (text) => bot?.notify(text);
  const engine = new Engine({ db, st, chains, rpcs, notify });

  log.info(`shadow mode | ${EVM_LEADERS.length} EVM leaders | chains: ${chains.map((c) => c.name).join(', ')}`);
  log.info('nothing is executed and no keys are loaded');

  const watchers = chains.map(
    (chain) =>
      new Watcher(chain, {
        onTrade: (trade) => engine.handleTrade(trade),
        cursor: {
          get: () => st.getCursor.get(chain.id)?.block ?? null,
          set: (block) => st.setCursor.run(chain.id, block),
        },
      })
  );

  if (process.env.TELEGRAM_BOT_TOKEN) {
    bot = new Bot({
      token: process.env.TELEGRAM_BOT_TOKEN,
      st,
      db,
      state: { startedAt, chains, watchers },
    });
    await bot.start();
  } else {
    log.dim('telegram disabled (no TELEGRAM_BOT_TOKEN)');
  }

  for (const w of watchers) await w.start();

  const timer = setInterval(() => {
    engine.tick().catch((e) => log.error('tick:', e.message));
  }, TICK_MS);

  const shutdown = () => {
    log.info('shutting down');
    clearInterval(timer);
    for (const w of watchers) w.stop();
    bot?.stop();
    db.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((e) => {
  log.error(e.stack || e.message);
  process.exit(1);
});
