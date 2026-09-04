# fomocopy

Shadow copy-trading tracker for [fomo.family](https://fomo.family) leader wallets on
**Robinhood Chain (4663)** and **Base (8453)**.

It watches 36 known leader wallets, records every trade they make, and simulates
copying them under five different exit strategies at once. **It executes nothing,
holds no keys, and cannot spend money.** The point is to answer one question with
data before any capital is at risk: *would copying these people actually print?*

Solana is deliberately not implemented yet.

## Why it works the way it does

Three facts about how FOMO operates on-chain drove the design. All three were
measured against live chain data, not assumed.

**FOMO relays every trade.** The leader's EOA never signs anything. Nonces sit at
2 to 6 and native balances at zero even for wallets trading six figures. So
`tx.from`, nonce and native balance are all useless for identifying activity. Only
token flow works.

**One contract settles everything.** `0xb92fe925dc43a0ecde6c8b1a2709c170ec4fff4f`
is on one side of 97% of Base leader swaps and 72% of Robinhood ones, and it is
the same address on both chains. Requiring it as the counterparty is what
separates a trade from noise.

**The noise is overwhelming without that filter.** Only 16% of transactions merely
*touching* a leader wallet on Robinhood Chain are trades. The rest are airdrops
and batch distributions, including one 251-recipient token drop. Watching plain
`Transfer` events would produce roughly five false signals for every real one.

The result is that a leader trade is fully described by a single ERC20 `Transfer`
log, and both filters run **server-side** at the RPC provider:

| direction | filter |
| --- | --- |
| buy | `Transfer(from = FOMO vault, to = any leader)` |
| sell | `Transfer(from = any leader, to = FOMO vault)` |

Nothing else reaches the process. There is no calldata decoding, no receipt
fetching, no swap routing, and no web3 library. Prices come from DexScreener,
which covers Robinhood Chain natively as `chainId: "robinhood"`, so phase 1 needs
no on-chain quoter either.

## Setup

```bash
npm install
cp .env.example .env    # fill in RH_WSS and BASE_WSS
```

The endpoints must support `eth_subscribe`. The public RPCs
(`rpc.mainnet.chain.robinhood.com`, `mainnet.base.org`) do not; a provider
endpoint such as QuickNode does.

```bash
npm run backfill        # record recent history so the report has data today
npm start               # watch live
npm run report          # read the results
```

`npm run backfill [blocks]` records events only. It does not open shadow
positions, because DexScreener serves current prices and pricing a week-old trade
with today's number would look like PnL when it is noise.

### Telegram

Setting `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` sends one message per leader
trade, with the size, what share of their bag a sell was, current liquidity, and
links to the chart and the transaction. Expect roughly five an hour. Leave either
variable blank to turn it off.

There is no bot command surface. This runs for one person, so reporting lives in
`npm run report`.

## The five policies

Every policy sees the same event stream with the same entry rules, so only the
exit differs. Running five costs no more than running one because nothing
executes, which means the choice gets made from data rather than opinion.

| policy | on the leader's sell |
| --- | --- |
| `mirror_all` | close the whole position |
| `mirror_prop` | sell the same fraction of our bag that they sold of theirs |
| `trail_on_sell` | do not sell, arm a 15% trailing stop instead |
| `tranche_trail` | sell half now, trail the remaining half at 20% |
| `hold_24h` | ignore them entirely and close at the 24h mark |

`hold_24h` is the baseline that matters. If the clever policies cannot beat
"buy what they buy and wait a day", the exit logic is not what makes money and
that is worth knowing early.

Sell fractions are exact, not estimated: the leader's token balance immediately
after the sell gives their remaining bag, so `sold / (sold + remaining)` is their
true exit percentage.

## Entry cost

The report's most important number is the **entry cost**: how far the price moved
between the leader's fill and ours. Positions enter at the price
`ENTRY.entryDelayMs` (default 30s) after the leader trades, never at their price.

Buying their pump is the main cost of copy trading, and a simulation that used
their fill price would show profits that do not exist.

## Known simplifications

- A leader's sell only affects positions opened by **that same leader** in that
  same token. When several leaders hold the same token, whose sell should exit
  you is a real design question; the report surfaces those clusters so it can be
  answered from data instead of guessed at.
- Leader trade size is `amount x current price`. FOMO batches several users into
  one transaction, so the WETH legs cannot be cleanly attributed per user and the
  leader's exact fill price is approximate. Our own entry price is exact, which is
  the number the PnL depends on.
- The remaining 3% of Base swaps and 28% of Robinhood swaps that route around the
  FOMO vault are not captured. Widening the filter would reintroduce airdrop noise.
- No slippage or gas is modelled. Both make real results worse than the
  simulation, so treat the output as an optimistic bound.

## Layout

```
config/chains.js     chain params, the FOMO vault address
config/leaders.js    the 36 EVM leaders (Solana column carried, unused)
config/policy.js     entry rules, mark offsets, the five policies
src/chain/decode.js  the two server-side log filters and the log reader
src/chain/watcher.js WebSocket subscriptions, reconnect, gap fill
src/chain/rpc.js     minimal JSON-RPC, no web3 dependency
src/price/           DexScreener client
src/shadow/engine.js event handling, entries, marks
src/shadow/policies.js the exit rules and PnL accounting
scripts/backfill.js  historical events
scripts/report.js    the scoreboard
```
