'use strict';

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const DATA_DIR = path.join(__dirname, '..', 'data');

function open() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const db = new Database(path.join(DATA_DIR, 'fomocopy.db'));
  db.pragma('journal_mode = WAL');
  migrate(db);
  return db;
}

function migrate(db) {
  db.exec(`
    -- Every FOMO trade we observed a leader make. This table is the raw
    -- record and never depends on policy; policies are derived from it.
    CREATE TABLE IF NOT EXISTS events (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      chain_id      INTEGER NOT NULL,
      block         INTEGER NOT NULL,
      log_index     INTEGER NOT NULL,
      tx_hash       TEXT    NOT NULL,
      ts            INTEGER NOT NULL,           -- ms, block timestamp
      leader        TEXT    NOT NULL,
      side          TEXT    NOT NULL,           -- buy | sell
      token         TEXT    NOT NULL,
      amount_raw    TEXT    NOT NULL,           -- uint256 as decimal string
      amount        REAL,                       -- decimal-adjusted
      leader_frac   REAL,                       -- for sells: share of their bag
      price_usd     REAL,                       -- token price when we saw it
      size_usd      REAL,
      liquidity_usd REAL,
      fdv_usd       REAL,
      mcap_usd      REAL,
      UNIQUE (chain_id, tx_hash, log_index)
    );
    CREATE INDEX IF NOT EXISTS idx_events_token ON events (chain_id, token, ts);
    CREATE INDEX IF NOT EXISTS idx_events_leader ON events (leader, ts);

    -- Token metadata cache so we resolve decimals and symbol once.
    CREATE TABLE IF NOT EXISTS tokens (
      chain_id  INTEGER NOT NULL,
      address   TEXT    NOT NULL,
      symbol    TEXT,
      decimals  INTEGER,
      PRIMARY KEY (chain_id, address)
    );

    -- One row per (policy, copied buy). Five policies means five rows per
    -- leader buy, all scored against the same event stream.
    CREATE TABLE IF NOT EXISTS positions (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      policy        TEXT    NOT NULL,
      chain_id      INTEGER NOT NULL,
      token         TEXT    NOT NULL,
      leader        TEXT    NOT NULL,
      open_event    INTEGER NOT NULL REFERENCES events (id),
      opened_ts     INTEGER NOT NULL,
      leader_price  REAL,                       -- price at the leader's trade
      entry_price   REAL,                       -- price at entry_delay, our fill
      entry_ts      INTEGER,
      size_usd      REAL    NOT NULL,
      qty           REAL,                       -- notional units still held, 1.0 = full
      status        TEXT    NOT NULL,           -- pending | open | closed | skipped
      skip_reason   TEXT,
      trail_armed   INTEGER NOT NULL DEFAULT 0,
      trail_peak    REAL,
      exit_price    REAL,
      exit_ts       INTEGER,
      exit_reason   TEXT,
      pnl_usd       REAL,
      pnl_pct       REAL,
      UNIQUE (policy, open_event)
    );
    CREATE INDEX IF NOT EXISTS idx_pos_status ON positions (status, policy);
    CREATE INDEX IF NOT EXISTS idx_pos_token ON positions (chain_id, token, status);

    -- Partial exits, so a proportional policy leaves an audit trail.
    CREATE TABLE IF NOT EXISTS fills (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      position_id INTEGER NOT NULL REFERENCES positions (id),
      ts          INTEGER NOT NULL,
      fraction    REAL    NOT NULL,
      price       REAL    NOT NULL,
      reason      TEXT    NOT NULL,
      pnl_usd     REAL
    );
    CREATE INDEX IF NOT EXISTS idx_fills_pos ON fills (position_id);

    -- Price marks at fixed offsets from entry, plus trailing-stop ticks.
    CREATE TABLE IF NOT EXISTS marks (
      position_id INTEGER NOT NULL REFERENCES positions (id),
      offset_ms   INTEGER NOT NULL,
      ts          INTEGER NOT NULL,
      price       REAL,
      pnl_pct     REAL,
      PRIMARY KEY (position_id, offset_ms)
    );

    -- Last block we fully processed per chain, so a restart backfills the gap.
    CREATE TABLE IF NOT EXISTS cursors (
      chain_id INTEGER PRIMARY KEY,
      block    INTEGER NOT NULL
    );

    -- Runtime state the Telegram bot owns: the owner chat id it bound to and
    -- whether alerts are paused. Kept in the db so a restart remembers.
    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT
    );

    -- Muting a leader stops their alerts and stops opening shadow positions
    -- from their trades. Events are still recorded either way, because the raw
    -- history should stay complete no matter what we were listening to.
    CREATE TABLE IF NOT EXISTS muted (
      leader TEXT PRIMARY KEY,
      since  INTEGER NOT NULL
    );
  `);

  addColumns(db, 'events', {
    mcap_usd: 'REAL',
    // When we received the log, vs the block timestamp. The gap is the real
    // copy delay. Cannot be reconstructed later.
    seen_ts: 'INTEGER',
    pair_created_at: 'INTEGER',
    pair_address: 'TEXT',
    dex_id: 'TEXT',
    vol_h1: 'REAL',
    vol_h24: 'REAL',
    change_m5: 'REAL',
    change_h1: 'REAL',
    buys_h1: 'INTEGER',
    sells_h1: 'INTEGER',
    // 'exec' means price_usd and size_usd came out of the leader's own
    // settlement leg and are exact. 'dexscreener' means they are a spot quote,
    // so treat them as an estimate. NULL means we never managed to price it.
    price_source: 'TEXT',
    // 'trade' if a stablecoin moved in the transaction, 'transfer' if the
    // tokens arrived or left for free. Transfers stay in this table as history
    // but are excluded from every report by the `trades` view below.
    kind: "TEXT NOT NULL DEFAULT 'trade'",
    // Who supplied the token on a buy, or received it on a sell. Recorded
    // because it is cheap and occasionally informative. It is not a quality
    // signal: WETH, cbBTC and the tokenised stocks each have their own
    // dedicated venue, exactly like the two tokens that rugged.
    venue: 'TEXT',
  });
  addColumns(db, 'positions', {
    entry_liquidity_usd: 'REAL',
    entry_mcap_usd: 'REAL',
  });
  addColumns(db, 'marks', {
    liquidity_usd: 'REAL',
    mcap_usd: 'REAL',
  });

  // What every report reads. Recreated on each open so it picks up columns
  // added above.
  db.exec(`
    DROP VIEW IF EXISTS trades;
    CREATE VIEW trades AS SELECT * FROM events WHERE kind = 'trade';
  `);
}

// CREATE TABLE IF NOT EXISTS does nothing to a table that already exists, so
// new columns need an explicit ALTER against databases created before them.
function addColumns(db, table, columns) {
  const have = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name));
  for (const [name, type] of Object.entries(columns)) {
    if (!have.has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);
  }
}

function statements(db) {
  return {
    insertEvent: db.prepare(`
      INSERT OR IGNORE INTO events
        (chain_id, block, log_index, tx_hash, ts, leader, side, token,
         amount_raw, amount, leader_frac, price_usd, size_usd, liquidity_usd, fdv_usd, mcap_usd,
         seen_ts, pair_created_at, pair_address, dex_id,
         vol_h1, vol_h24, change_m5, change_h1, buys_h1, sells_h1, price_source, kind, venue)
      VALUES
        (@chain_id, @block, @log_index, @tx_hash, @ts, @leader, @side, @token,
         @amount_raw, @amount, @leader_frac, @price_usd, @size_usd, @liquidity_usd, @fdv_usd, @mcap_usd,
         @seen_ts, @pair_created_at, @pair_address, @dex_id,
         @vol_h1, @vol_h24, @change_m5, @change_h1, @buys_h1, @sells_h1, @price_source, @kind, @venue)
    `),

    // How many distinct tokens this venue has ever supplied. One means nothing
    // else trades there, so nobody but its owner vouches for the supply.
    venueTokens: db.prepare('SELECT COUNT(DISTINCT token) n FROM events WHERE venue = ? AND chain_id = ?'),
    lastEventAt: db.prepare('SELECT MAX(ts) ts FROM events WHERE chain_id = ?'),
    getToken: db.prepare('SELECT * FROM tokens WHERE chain_id = ? AND address = ?'),
    putToken: db.prepare('INSERT OR REPLACE INTO tokens (chain_id, address, symbol, decimals) VALUES (?, ?, ?, ?)'),

    insertPosition: db.prepare(`
      INSERT OR IGNORE INTO positions
        (policy, chain_id, token, leader, open_event, opened_ts, leader_price,
         size_usd, qty, status, skip_reason)
      VALUES
        (@policy, @chain_id, @token, @leader, @open_event, @opened_ts, @leader_price,
         @size_usd, 1.0, @status, @skip_reason)
    `),
    pendingEntries: db.prepare("SELECT * FROM positions WHERE status = 'pending' AND opened_ts <= ?"),
    activate: db.prepare(`
      UPDATE positions
      SET status = 'open', entry_price = ?, entry_ts = ?,
          entry_liquidity_usd = ?, entry_mcap_usd = ?
      WHERE id = ?
    `),
    skip: db.prepare("UPDATE positions SET status = 'skipped', skip_reason = ? WHERE id = ?"),
    openPositions: db.prepare("SELECT * FROM positions WHERE status = 'open'"),
    openFor: db.prepare("SELECT * FROM positions WHERE status = 'open' AND chain_id = ? AND token = ? AND leader = ?"),
    liveFor: db.prepare(
      "SELECT * FROM positions WHERE chain_id = ? AND token = ? AND leader = ? AND status IN ('open', 'pending')"
    ),
    reduce: db.prepare('UPDATE positions SET qty = ? WHERE id = ?'),
    armTrail: db.prepare('UPDATE positions SET trail_armed = 1, trail_peak = ? WHERE id = ?'),
    setPeak: db.prepare('UPDATE positions SET trail_peak = ? WHERE id = ?'),
    close: db.prepare(`
      UPDATE positions
      SET status = 'closed', qty = 0, exit_price = ?, exit_ts = ?, exit_reason = ?,
          pnl_usd = ?, pnl_pct = ?
      WHERE id = ?
    `),
    addFill: db.prepare(`
      INSERT INTO fills (position_id, ts, fraction, price, reason, pnl_usd)
      VALUES (?, ?, ?, ?, ?, ?)
    `),
    fillsFor: db.prepare('SELECT * FROM fills WHERE position_id = ?'),
    putMark: db.prepare(`
      INSERT OR REPLACE INTO marks (position_id, offset_ms, ts, price, pnl_pct, liquidity_usd, mcap_usd)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `),
    marksFor: db.prepare('SELECT offset_ms, liquidity_usd FROM marks WHERE position_id = ?'),

    getCursor: db.prepare('SELECT block FROM cursors WHERE chain_id = ?'),
    setCursor: db.prepare('INSERT OR REPLACE INTO cursors (chain_id, block) VALUES (?, ?)'),

    getSetting: db.prepare('SELECT value FROM settings WHERE key = ?'),
    setSetting: db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)'),

    mute: db.prepare('INSERT OR REPLACE INTO muted (leader, since) VALUES (?, ?)'),
    unmute: db.prepare('DELETE FROM muted WHERE leader = ?'),
    isMuted: db.prepare('SELECT 1 FROM muted WHERE leader = ?'),
    listMuted: db.prepare('SELECT leader FROM muted ORDER BY leader'),
  };
}

module.exports = { open, statements, DATA_DIR };
