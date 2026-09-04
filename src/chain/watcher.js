'use strict';

const WebSocket = require('ws');
const { logger } = require('../util/log');
const { Rpc, toHex } = require('./rpc');
const { decode, FILTERS } = require('./decode');

// The socket is a latency optimisation, not a guarantee, so the tip is polled
// on this interval regardless of how healthy the connection looks.
//
// Kept under ENTRY.maxTradeAgeMs on purpose. A trade the socket drops is only
// worth recovering if it is still fresh enough to shadow honestly; at a
// two-minute interval every recovered trade arrived stale and was thrown away,
// which quietly biased the sample against whatever the socket tends to miss.
const SWEEP_MS = 30_000;

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
    this.live = new Set(); // sides with a confirmed subscription
    this.lastBlock = 0;
    this.lastSweep = 0;
    this.connectedAt = 0;
    this.timer = null;
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
    this.timer = setInterval(() => this.sweep(), SWEEP_MS);
  }

  stop() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    if (this.ws) this.ws.close();
  }

  // Both subscriptions confirmed and a socket that is actually open.
  get healthy() {
    return this.ws?.readyState === WebSocket.OPEN && this.live.size === Object.keys(FILTERS).length;
  }

  // A socket still opening or still waiting on its subscribe replies is not
  // unhealthy yet, and tearing it down would loop forever on a slow provider.
  get settling() {
    return this.ws?.readyState === WebSocket.CONNECTING || Date.now() - this.connectedAt < 15_000;
  }

  // A provider can accept a connection and then refuse or silently drop the
  // subscriptions on it, which leaves a socket that is open, emits no 'close',
  // and delivers nothing. Polling the tip makes completeness independent of the
  // socket's cooperation; the worst case degrades latency to SWEEP_MS instead
  // of losing the trade.
  async sweep() {
    if (this.stopped || this.sweeping) return;
    this.sweeping = true;
    try {
      const tip = await this.rpc.blockNumber();
      if (this.lastBlock && tip > this.lastBlock) {
        const found = await this.backfill(this.lastBlock + 1, tip);
        this.lastBlock = tip;
        this.cursor.set(tip);
        // Worth surfacing either way. Recovering trades from a healthy socket
        // means the subscription is lossy, which is only visible if we say so.
        if (found) {
          this.log.warn(
            `sweep recovered ${found} trade(s) the socket ${this.healthy ? 'did not deliver' : 'missed while down'}`
          );
        }
      }
      this.lastSweep = Date.now();
      if (!this.healthy && !this.settling && !this.reconnecting) this.reconnect('subscriptions not live');
    } catch (e) {
      this.log.warn(`sweep failed: ${e.message}`);
    } finally {
      this.sweeping = false;
    }
  }

  connect() {
    if (this.stopped) return;
    const ws = new WebSocket(this.chain.wss());
    this.ws = ws;
    this.subs.clear();
    this.live.clear();

    ws.on('open', () => {
      this.retry = 0;
      this.connectedAt = Date.now();
      this.log.ok('connected');
      let id = 1;
      for (const [side, filter] of Object.entries(FILTERS)) {
        this.subs.set(id, side);
        ws.send(JSON.stringify({ jsonrpc: '2.0', id: id++, method: 'eth_subscribe', params: ['logs', filter] }));
      }
    });

    ws.on('message', (raw) => {
      if (this.ws !== ws) return; // a superseded socket still draining
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }

      if (msg.id && this.subs.has(msg.id)) {
        const side = this.subs.get(msg.id);
        if (msg.error) {
          // Without this the socket stays open, no 'close' fires, and the
          // watcher sits deaf forever. Treat it as a dead connection.
          this.log.error(`subscribe ${side} failed:`, JSON.stringify(msg.error));
          this.reconnect(`subscribe ${side} failed`);
          ws.close();
        } else {
          this.live.add(side);
          this.log.info(`watching ${side}s (sub ${String(msg.result).slice(0, 12)})`);
        }
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

    ws.on('close', () => {
      if (this.ws === ws) this.reconnect('closed');
    });
    ws.on('error', (e) => {
      if (this.ws === ws) this.reconnect(e.message);
    });
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
