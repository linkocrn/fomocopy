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
// Returns null when the receipt cannot be read, so callers can tell "no money
// moved" apart from "we do not know". Otherwise:
//
//   { usd, asset }  the vault-routed stable leg, or null if the swap paid
//                   through some other route
//   { paid }        whether any stablecoin moved at all in the transaction
//   { venue }       whoever supplied the token to the vault, or received it
//                   back on a sell. Nearly all FOMO flow comes from a handful
//                   of shared venues holding a hundred-odd tokens each; a
//                   contract that only ever serves one token is a different
//                   animal, and worth being able to see.
//
// `paid: false` is the interesting one. Tokens reaching a leader with nothing
// going the other way are not a purchase, they are supply being handed out, and
// treating that as a buy would put a project's own distribution list at the top
// of the scoreboard.
async function settlement(rpc, chain, txHash, tradedToken, side) {
  const assets = chain.settlement;
  if (!assets || !txHash) return null;

  const receipt = await rpc.call('eth_getTransactionReceipt', [txHash]);
  if (!receipt?.logs) return null;

  let best = null;
  let paid = false;
  // The token can hop through a router on its way to the vault, so the leg
  // touching the vault is sometimes just the router. The far end of the chain
  // is the side actually holding the float: where a buy's tokens came from, or
  // where a sell's tokens ended up.
  let firstFrom = null;
  let lastTo = null;

  for (const log of receipt.logs) {
    if (log.topics?.[0] !== TRANSFER_TOPIC || log.topics.length !== 3) continue;

    const address = log.address.toLowerCase();
    if (address === tradedToken) {
      if (!firstFrom) firstFrom = topicToAddress(log.topics[1]);
      lastTo = topicToAddress(log.topics[2]);
      continue;
    }
    const asset = assets[address];
    if (!asset) continue;

    const usd = Number(hexToBigInt(log.data.slice(0, 66))) / 10 ** asset.decimals;
    if (usd > 0) paid = true;

    if (topicToAddress(log.topics[1]) !== FOMO_VAULT && topicToAddress(log.topics[2]) !== FOMO_VAULT) {
      continue;
    }

    // The stable enters and leaves the vault in equal amounts, so either leg
    // works. Taking the larger keeps us on the gross trade value if FOMO ever
    // starts skimming a fee on the way through.
    if (usd > 0 && (!best || usd > best.usd)) best = { usd, asset: asset.symbol };
  }

  const venue = side === 'sell' ? lastTo : firstFrom;
  return { usd: best?.usd ?? null, asset: best?.asset ?? null, paid, venue };
}

module.exports = { settlement };
