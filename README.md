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
npm run dev             # same, but restarts itself whenever a file changes
npm run report          # read the results
```

`npm run dev` uses Node's built-in `--watch`, so editing any source file
restarts the process without touching the terminal. A restart costs about a
second and the watcher gap-fills whatever blocks it missed, so nothing is lost.
Use plain `npm start` on a server, where you do not want a stray file write to
bounce the process.

`npm run backfill [blocks]` records events only. It does not open shadow
positions, because DexScreener serves current prices and pricing a week-old trade
with today's number would look like PnL when it is noise.

### Telegram

Set `TELEGRAM_BOT_TOKEN` and send the bot `/start`. The first chat to message it
becomes the owner and is remembered in the database, so there is no chat id to
look up. Every other chat is ignored.

Alerts carry the exact dollar size, what share of their bag a sell was, market
cap, liquidity, and links to the chart, the transaction, the wallet and the
trader's FOMO profile.

Each leader gets a distinct emoji derived from their handle, so they are
recognisable at a glance in a fast scrolling feed where reading names is slower
than seeing a shape. Forty handles into eighty slots collides almost every time,
so the assignment probes forward from the hash to guarantee all forty are
distinct while staying deterministic. `/who` prints the legend.

Leaders scale in and out rather than trading once. `slingoor` unloaded MEME in
fourteen separate transactions about fifteen seconds apart, which as raw alerts
would be fourteen near-identical messages. So the first trade of a burst goes
out immediately, because that is the one worth reacting to, and everything after
it is accumulated into a single rollup sent once the burst goes quiet.

Commands:

| command | |
| --- | --- |
| `/status` | what is running, uptime, block heights |
| `/report` | policy scoreboard and entry cost |
| `/leaders` | who is trading the most |
| `/who` | the emoji legend for every leader |
| `/pnl` | profit and loss per leader |
| `/positions` | open shadow positions with live PnL |
| `/clusters` | tokens several leaders bought |
| `/policies` | what the five exit strategies do |
| `/mute <handle>` | stop alerting and stop copying them |
| `/unmute <handle>`, `/muted` | reverse it, list them |
| `/focus <handle>` | also alert on the quiet bot |
| `/unfocus <handle>`, `/focused` | drop them, list them |
| `/pause`, `/resume` | all alerts |

Muting stops alerts and stops opening new positions from that leader, but their
sells still close positions already opened from them. Otherwise muting would
strand live positions with no exit. Their trades stay in the event log either
way, because the raw history should be complete regardless of what we were
listening to.

Telegram will not split one bot's notifications across chats, so a second bot
token (`TELEGRAM_FOCUS_BOT_TOKEN`) runs in the same process and only fires for
leaders you `/focus`. The main bot still gets everyone. Send the quiet bot
`/start` once so it is allowed to write to you.

`npm run report` renders the same data to a terminal from the same queries in
`src/report.js`, so the two views cannot drift apart.

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

The leader's side of that comparison is their real fill, taken from the
stablecoin leg of their own transaction (see Pricing). That is an average over
their whole order and includes the impact of pushing the book. Ours is a $100
print that moves nothing. So the number runs in both directions: positive is the
part of their pump we still buy, negative is the slippage they paid and we did
not. Early data shows a mean of about -4%, meaning size is a real disadvantage
for the leader and a quiet edge for the copier.

## Pricing

Trade value is read from the transaction, not from a price feed. Every FOMO swap
moves a stablecoin through the settlement vault, USDG on Robinhood Chain and USDC
on Base, and that amount is what the leader actually paid or received. It needs
no pool selection, so it cannot be thrown off by a token that is the quote side
of its deepest pair, and it stays correct for a trade read hours later, which is
what lets `npm run reprice` value backfilled history.

It was present on 45 of 45 sampled trades. Where a spot quote existed to compare
against, the two sat a median 7.3% apart, with sells consistently settling below
spot by the leader's own slippage.

DexScreener still supplies what only it can: liquidity, market cap, pair age, and
the price our own hypothetical fill pays 30s later. `events.price_source` records
which path produced each row, so an estimate is never mistaken for a measurement.

## Known simplifications

- A leader's sell only affects positions opened by **that same leader** in that
  same token. When several leaders hold the same token, whose sell should exit
  you is a real design question; the report surfaces those clusters so it can be
  answered from data instead of guessed at.
- Leader trade size is read from the settlement leg and is exact. Our own entry
  price is a spot quote, and that is the number the PnL depends on.
- The remaining 3% of Base swaps and 28% of Robinhood swaps that route around the
  FOMO vault are not captured. Widening the filter would reintroduce airdrop noise.
- No slippage or gas is modelled. Both make real results worse than the
  simulation, so treat the output as an optimistic bound.
- Stopping and restarting is safe: the watcher replays every block it missed, so
  no trade is lost from the event log. Those replayed trades do **not** open
  shadow positions though, because pricing a "30 second" fill an hour after the
  fact would corrupt the entry-cost stat. They show up as `stale_replay` in the
  skipped list. A replayed *sell* still closes positions opened before the gap,
  at the current price rather than the price when they actually sold, so long
  downtime makes those particular exits pessimistic.

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
src/report.js        shared report queries
src/telegram/        command surface and alert formatting
scripts/backfill.js  historical events
scripts/report.js    the scoreboard, rendered to a terminal
```
