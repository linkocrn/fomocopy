'use strict';

const { FOMO_VAULT } = require('../../config/chains');
const { BY_EVM, EVM_LEADERS } = require('../../config/leaders');
const { hexToBigInt, topicToAddress, addressToTopic } = require('./rpc');

const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

const LEADER_TOPICS = EVM_LEADERS.map((l) => addressToTopic(l.evm));
const VAULT_TOPIC = addressToTopic(FOMO_VAULT);

// Two server-side filters per chain. The RPC provider does the matching, so we
// never see airdrops, spam mints or the leader's unrelated transfers at all.
//
// Measured on live data, only 16% of transactions merely *touching* a leader
// wallet on Robinhood Chain are trades. The other 84% are airdrops and batch
// distributions. Requiring the FOMO vault on the other side removes all of it.
const FILTERS = {
  // Vault sends the token to the leader.
  buy: { topics: [TRANSFER_TOPIC, [VAULT_TOPIC], LEADER_TOPICS] },
  // Leader sends the token to the vault.
  sell: { topics: [TRANSFER_TOPIC, LEADER_TOPICS, [VAULT_TOPIC]] },
};

// A log that matched either filter is already known to be a leader trade; this
// only reads the fields back out.
function decode(log, chainId) {
  if (log.topics?.[0] !== TRANSFER_TOPIC || log.topics.length !== 3) return null;

  const from = topicToAddress(log.topics[1]);
  const to = topicToAddress(log.topics[2]);

  let side;
  let leaderAddr;
  if (from === FOMO_VAULT && BY_EVM.has(to)) {
    side = 'buy';
    leaderAddr = to;
  } else if (to === FOMO_VAULT && BY_EVM.has(from)) {
    side = 'sell';
    leaderAddr = from;
  } else {
    return null;
  }

  return {
    chain_id: chainId,
    block: Number(hexToBigInt(log.blockNumber)),
    log_index: Number(hexToBigInt(log.logIndex)),
    tx_hash: log.transactionHash,
    leader: BY_EVM.get(leaderAddr),
    leader_addr: leaderAddr,
    side,
    token: log.address.toLowerCase(),
    amount_raw: hexToBigInt(log.data.slice(0, 66)).toString(),
  };
}

module.exports = { decode, FILTERS, TRANSFER_TOPIC, LEADER_TOPICS, VAULT_TOPIC };
