'use strict';

const { FOMO_VAULT } = require('../../config/chains');
const { hexToBigInt, topicToAddress } = require('./rpc');
const { TRANSFER_TOPIC } = require('./decode');

// The dollar value of a trade, read out of the leader's own transaction.
//
// A FOMO swap moves the token one way and a stablecoin the other, and the
// stable leg passes through the settlement vault. That amount is what the
// leader actually paid or received, which makes it strictly better than a price
// lookup: no pool to choose, no spread between venues, and, unlike DexScreener,
// it is still correct when we read the transaction hours later. Measured across
// 45 sampled trades on both chains it was present on every one, and on a trade
// we could cross-check it landed within 1.3% of spot.
//
// Returns null when nothing recognisable settles, so callers fall back rather
// than invent a number.
async function settlement(rpc, chain, txHash, tradedToken) {
  const assets = chain.settlement;
  if (!assets || !txHash) return null;

  const receipt = await rpc.call('eth_getTransactionReceipt', [txHash]);
  if (!receipt?.logs) return null;

  let best = null;
  for (const log of receipt.logs) {
    if (log.topics?.[0] !== TRANSFER_TOPIC || log.topics.length !== 3) continue;

    const address = log.address.toLowerCase();
    if (address === tradedToken) continue;
    const asset = assets[address];
    if (!asset) continue;

    if (topicToAddress(log.topics[1]) !== FOMO_VAULT && topicToAddress(log.topics[2]) !== FOMO_VAULT) {
      continue;
    }

    // The stable enters and leaves the vault in equal amounts, so either leg
    // works. Taking the larger keeps us on the gross trade value if FOMO ever
    // starts skimming a fee on the way through.
    const usd = Number(hexToBigInt(log.data.slice(0, 66))) / 10 ** asset.decimals;
    if (usd > 0 && (!best || usd > best.usd)) best = { usd, asset: asset.symbol };
  }

  return best;
}

module.exports = { settlement };
