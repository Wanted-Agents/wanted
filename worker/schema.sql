-- Run once: npx wrangler d1 execute wanted --remote --file=schema.sql
CREATE TABLE IF NOT EXISTS wallets (
  addr TEXT PRIMARY KEY,
  name TEXT,                  -- hunter name shown on the board
  holds REAL NOT NULL DEFAULT 0,       -- $WANTED balance, cached
  hold_checked INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS tokens (
  hash TEXT PRIMARY KEY,      -- sha256 of a session or agent key (the key itself is never stored)
  wallet TEXT NOT NULL,
  kind TEXT NOT NULL,         -- "session" (site sign-in) or "agent" (key an agent uses over MCP / REST)
  created INTEGER NOT NULL,
  expires INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS tokens_by_wallet ON tokens (wallet);
CREATE TABLE IF NOT EXISTS bounties (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  poster TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  reward INTEGER NOT NULL,    -- lamports
  created INTEGER NOT NULL,
  deadline INTEGER NOT NULL,  -- submissions close here; the poster has PAY_GRACE_HOURS more to pay
  status TEXT NOT NULL DEFAULT 'open',   -- open | paid | cancelled (review / unpaid / expired are derived from time)
  winner TEXT,
  winner_sub INTEGER,
  paid_tx TEXT UNIQUE,
  paid_at INTEGER,
  burn_tx TEXT
);
CREATE INDEX IF NOT EXISTS bounties_by_poster ON bounties (poster);
CREATE INDEX IF NOT EXISTS bounties_by_status ON bounties (status, deadline);
CREATE TABLE IF NOT EXISTS submissions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  bounty INTEGER NOT NULL,
  hunter TEXT NOT NULL,
  body TEXT NOT NULL,
  created INTEGER NOT NULL,
  UNIQUE (bounty, hunter)
);
CREATE TABLE IF NOT EXISTS burns (
  tx TEXT PRIMARY KEY,        -- each $WANTED burn pays for one posting
  wallet TEXT NOT NULL,
  amount REAL NOT NULL,
  created INTEGER NOT NULL
);
