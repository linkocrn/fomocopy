'use strict';

const WebSocket = require('ws');
const { logger } = require('../util/log');
const { Rpc, toHex } = require('./rpc');
const { decode, FILTERS } = require('./decode');

// One watcher per chain. Holds a WebSocket with two log subscriptions and
// replays any blocks missed while disconnected, so a dropped socket costs
// duplicated work rather than lost trades.
class Watcher {
  constructor(chain, { onTrade, cursor }) {
    this.chain = chain;
    this.log = logger(chain.slug);
    this.rpc = new Rpc(chain.wss());
    this.onTrade = onTrade;
    this.cursor = cursor; // { get(), set(block) }
    this.ws = null;
    this.retry = 0;
    this.stopped = false;
    this.subs = new Map();
    this.lastBlock = 0;
  }

  async start() {
    const tip = await this.rpc.blockNumber();
    const from = this.cursor.get();
    if (from && tip > from) {
      this.log.info(`replaying ${tip - from} missed blocks (${from} -> ${tip})`);
      await this.backfill(from + 1, tip);
    }
    this.lastBlock = tip;
    this.cursor.set(tip);
    this.connect();
  }

  stop() {
    this.stopped = true;
    if (this.ws) this.ws.close();
  }

  connect() {
    if (this.stopped) return;
    const ws = new WebSocket(this.chain.wss());
    this.ws = ws;
    this.subs.clear();

    ws.on('open', () => {
      this.retry = 0;
      this.log.ok('connected');
      let id = 1;
      for (const [side, filter] of Object.entries(FILTERS)) {
        this.subs.set(id, side);
        ws.send(JSON.stringify({ jsonrpc: '2.0', id: id++, method: 'eth_subscribe', params: ['logs', filter] }));
      }
    });

    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }

      if (msg.id && this.subs.has(msg.id)) {
        if (msg.error) this.log.error(`subscribe ${this.subs.get(msg.id)} failed:`, JSON.stringify(msg.error));
        else this.log.info(`watching ${this.subs.get(msg.id)}s (sub ${String(msg.result).slice(0, 12)})`);
        return;
      }

      if (msg.method !== 'eth_subscription') return;
      const log = msg.params?.result;
      if (!log || log.removed) return;

      const trade = decode(log, this.chain.id);
      if (!trade) return;
      if (trade.block > this.lastBlock) {
        this.lastBlock = trade.block;
        this.cursor.set(trade.block);
      }
      Promise.resolve(this.onTrade(trade)).catch((e) => this.log.error('handler:', e.message));
    });

    ws.on('close', () => this.reconnect('closed'));
    ws.on('error', (e) => this.reconnect(e.message));
  }

  reconnect(why) {
    if (this.stopped || this.reconnecting) return;
    this.reconnecting = true;
    const wait = Math.min(30_000, 1000 * 2 ** this.retry++);
    this.log.warn(`${why}; reconnecting in ${wait / 1000}s`);
    setTimeout(async () => {
      this.reconnecting = false;
      try {
        const tip = await this.rpc.blockNumber();
        if (this.lastBlock && tip > this.lastBlock) await this.backfill(this.lastBlock + 1, tip);
        this.lastBlock = tip;
        this.cursor.set(tip);
      } catch (e) {
        this.log.error('gap fill failed:', e.message);
      }
      this.connect();
    }, wait);
  }

  // Same two filters over a historical range, chunked to the provider's limit.
  async backfill(fromBlock, toBlock, onTrade = this.onTrade) {
    let found = 0;
    for (let start = fromBlock; start <= toBlock; start += this.chain.maxLogRange) {
      const end = Math.min(start + this.chain.maxLogRange - 1, toBlock);
      for (const filter of Object.values(FILTERS)) {
        const logs = await this.rpc.getLogs({ ...filter, fromBlock: toHex(start), toBlock: toHex(end) });
        for (const log of logs) {
          const trade = decode(log, this.chain.id);
          if (!trade) continue;
          found++;
          await onTrade(trade);
        }
      }
    }
    if (found) this.log.info(`backfill found ${found} trades`);
    return found;
  }
}

module.exports = { Watcher };
