'use strict';

// Minimal JSON-RPC over HTTP. The watcher subscribes over WebSocket, but gap
// filling, decimals lookups and balance reads are one-shot calls.
//
// Deliberately no ethers here. Everything this project reads is an ERC20
// Transfer log, which is fixed-layout hex, so a full web3 library would be
// ~10MB of dependency to slice strings.

const hexToBigInt = (h) => BigInt(h && h !== '0x' ? h : '0x0');
const topicToAddress = (t) => '0x' + t.slice(26).toLowerCase();
const addressToTopic = (a) => '0x' + a.slice(2).toLowerCase().padStart(64, '0');
const toHex = (n) => '0x' + Number(n).toString(16);

function httpUrl(wss) {
  return wss.replace(/^ws/, 'http');
}

class Rpc {
  constructor(wssUrl) {
    this.url = httpUrl(wssUrl);
    this.id = 0;
  }

  async call(method, params = []) {
    const res = await fetch(this.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++this.id, method, params }),
    });
    if (!res.ok) throw new Error(`${method}: HTTP ${res.status}`);
    const json = await res.json();
    if (json.error) throw new Error(`${method}: ${JSON.stringify(json.error).slice(0, 200)}`);
    return json.result;
  }

  async batch(requests) {
    if (!requests.length) return [];
    const out = [];
    for (let i = 0; i < requests.length; i += 20) {
      const slice = requests.slice(i, i + 20).map((r, k) => ({ jsonrpc: '2.0', id: i + k, ...r }));
      const res = await fetch(this.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(slice),
      });
      const json = await res.json();
      if (!Array.isArray(json)) throw new Error(`batch: ${JSON.stringify(json).slice(0, 200)}`);
      out.push(...json.sort((a, b) => a.id - b.id));
    }
    return out;
  }

  async blockNumber() {
    return Number(hexToBigInt(await this.call('eth_blockNumber')));
  }

  async getLogs(filter) {
    return this.call('eth_getLogs', [filter]);
  }

  async blockTimestamp(block) {
    const b = await this.call('eth_getBlockByNumber', [toHex(block), false]);
    return b ? Number(hexToBigInt(b.timestamp)) * 1000 : null;
  }

  // ERC20 decimals(). Returns null for tokens that do not implement it.
  async decimals(token) {
    try {
      const r = await this.call('eth_call', [{ to: token, data: '0x313ce567' }, 'latest']);
      const d = Number(hexToBigInt(r));
      return Number.isFinite(d) && d >= 0 && d <= 36 ? d : null;
    } catch {
      return null;
    }
  }

  // ERC20 symbol(). Handles the standard dynamic-string return only; tokens
  // using bytes32 fall back to a shortened address.
  async symbol(token) {
    try {
      const r = await this.call('eth_call', [{ to: token, data: '0x95d89b41' }, 'latest']);
      if (!r || r.length < 130) return null;
      const len = Number(hexToBigInt('0x' + r.slice(66, 130)));
      if (!len || len > 64) return null;
      return Buffer.from(r.slice(130, 130 + len * 2), 'hex').toString('utf8').replace(/\0/g, '') || null;
    } catch {
      return null;
    }
  }

  // ERC20 balanceOf(owner) at a specific block.
  async balanceOf(token, owner, block = 'latest') {
    const data = '0x70a08231' + owner.slice(2).toLowerCase().padStart(64, '0');
    const at = block === 'latest' ? 'latest' : toHex(block);
    return hexToBigInt(await this.call('eth_call', [{ to: token, data }, at]));
  }
}

module.exports = { Rpc, hexToBigInt, topicToAddress, addressToTopic, toHex, httpUrl };
