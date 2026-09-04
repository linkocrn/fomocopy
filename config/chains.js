'use strict';

// FOMO settles every trade through one contract, and it is the same address on
// every EVM chain it supports. A token Transfer between a leader wallet and this
// address is the definition of a FOMO trade, which is what lets us ignore
// airdrops, spam and the leader's unrelated on-chain activity.
//
// Measured against live chain data: present on 97% of Base leader swaps and 72%
// of Robinhood Chain ones. The remainder route through venue contracts directly.
const FOMO_VAULT = '0xb92fe925dc43a0ecde6c8b1a2709c170ec4fff4f';

const CHAINS = {
  4663: {
    id: 4663,
    name: 'Robinhood Chain',
    slug: 'robinhood',
    // DexScreener's chainId string for this network.
    dexscreener: 'robinhood',
    wss: () => process.env.RH_WSS,
    wnative: '0x0bd7d308f8e1639fab988df18a8011f41eacad73',
    nativeSymbol: 'ETH',
    explorer: 'https://robinhoodchain.blockscout.com',
    // Provider cap on a single eth_getLogs range.
    maxLogRange: 9000,
  },
  8453: {
    id: 8453,
    name: 'Base',
    slug: 'base',
    dexscreener: 'base',
    wss: () => process.env.BASE_WSS,
    wnative: '0x4200000000000000000000000000000000000006',
    nativeSymbol: 'ETH',
    explorer: 'https://basescan.org',
    maxLogRange: 9000,
  },
};

function enabledChains() {
  const want = (process.env.CHAINS || '4663,8453').split(',').map((s) => Number(s.trim()));
  return want.map((id) => {
    const c = CHAINS[id];
    if (!c) throw new Error(`Unknown chain id ${id}`);
    if (!c.wss()) throw new Error(`No WSS endpoint configured for ${c.name} (chain ${id})`);
    return c;
  });
}

module.exports = { CHAINS, FOMO_VAULT, enabledChains };
