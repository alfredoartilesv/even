-- Accounts, invites, keys, pairing, friends and shares (docs/users.md). What is readable here is
-- who and when: emails, display names, devices, friend links. Rows, shares and keys stay sealed.

-- One person. devices.owner_id and sync_rows.owner_id are this id from here on.
CREATE TABLE accounts (
  id              TEXT PRIMARY KEY,
  email           TEXT NOT NULL UNIQUE,
  display_name    TEXT NOT NULL,
  google_subject  TEXT UNIQUE,
  created_at      BIGINT NOT NULL,
  quota_bytes     BIGINT NOT NULL DEFAULT 209715200
);

-- One invite lets one email make one account (npm run sync:invite). Only the code's hash is kept.
CREATE TABLE invites (
  code_hash   TEXT PRIMARY KEY,
  email       TEXT NOT NULL,
  created_at  BIGINT NOT NULL,
  expires_at  BIGINT NOT NULL,
  used_at     BIGINT,
  account_id  TEXT
);

-- The account's keys, as only its own devices can open them. identity_private and adk_wrapped are
-- sealed on the devices. recovery_verifier is the SHA-256 of a key derived from the passphrase
-- (a different one from the key that unwraps adk_wrapped). key_check lets a device prove it holds
-- the right account data key before it is allowed to push.
CREATE TABLE account_keys (
  account_id         TEXT PRIMARY KEY REFERENCES accounts (id),
  identity_public    TEXT NOT NULL,
  identity_private   TEXT NOT NULL,
  adk_wrapped        TEXT NOT NULL,
  wrap_salt          TEXT NOT NULL,
  wrap_iterations    INTEGER NOT NULL,
  recovery_verifier  TEXT NOT NULL,
  key_check          TEXT NOT NULL,
  updated_at         BIGINT NOT NULL
);

ALTER TABLE devices ADD COLUMN kind TEXT NOT NULL DEFAULT 'phone';
ALTER TABLE devices ADD COLUMN added_by TEXT NOT NULL DEFAULT 'operator';

-- A new device asking to join an account. It keeps its token, the server its hash. The approving
-- device seals the account keys to ephemeral_public, so the server only relays them.
CREATE TABLE pairings (
  id                TEXT PRIMARY KEY,
  token_hash        TEXT NOT NULL UNIQUE,
  ephemeral_public  TEXT NOT NULL,
  device_name       TEXT NOT NULL,
  device_kind       TEXT NOT NULL,
  account_id        TEXT,
  sealed            TEXT,
  created_at        BIGINT NOT NULL,
  expires_at        BIGINT NOT NULL,
  approved_at       BIGINT,
  picked_up_at      BIGINT
);

-- Friends: an invite code one account makes and another uses. a is always the smaller id.
CREATE TABLE friend_invites (
  code_hash   TEXT PRIMARY KEY,
  account_id  TEXT NOT NULL,
  created_at  BIGINT NOT NULL,
  expires_at  BIGINT NOT NULL,
  used_at     BIGINT,
  used_by     TEXT
);
CREATE TABLE friendships (
  a           TEXT NOT NULL,
  b           TEXT NOT NULL,
  created_at  BIGINT NOT NULL,
  PRIMARY KEY (a, b)
);

-- One kind of an owner's data shared with one friend. wrapped_key is the share key sealed with
-- the owner's and the friend's identity keys, so only those two accounts' devices can open it.
CREATE TABLE shares (
  id           TEXT PRIMARY KEY,
  owner_id     TEXT NOT NULL,
  friend_id    TEXT NOT NULL,
  kind         TEXT NOT NULL,
  wrapped_key  TEXT NOT NULL,
  created_at   BIGINT NOT NULL,
  UNIQUE (owner_id, friend_id, kind)
);

-- A share's sealed daily summaries, one per day.
CREATE TABLE share_rows (
  share_id    TEXT NOT NULL,
  day         TEXT NOT NULL,
  updated_at  BIGINT NOT NULL,
  seq         BIGINT NOT NULL,
  blob        TEXT NOT NULL,
  PRIMARY KEY (share_id, day)
);
CREATE INDEX idx_share_rows_pull ON share_rows (share_id, seq);

-- Attempts at sign-in, recovery and invites, for rate limits. Old rows are dropped as new ones come.
CREATE TABLE rate_events (
  bucket  TEXT NOT NULL,
  at      BIGINT NOT NULL
);
CREATE INDEX idx_rate_events ON rate_events (bucket, at);
