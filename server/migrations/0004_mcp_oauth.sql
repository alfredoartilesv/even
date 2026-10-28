-- OAuth for the admin MCP server (docs/users.md section 9): Claude registers itself as a client,
-- an admin signs in with email and passphrase, Claude gets an access token for /mcp only. Codes
-- and tokens are kept as SHA-256 hashes.

-- Clients that registered themselves (Dynamic Client Registration). Public clients: no secret.
CREATE TABLE oauth_clients (
  id             TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  redirect_uris  TEXT NOT NULL,
  created_at     BIGINT NOT NULL
);

-- An authorization code: single use, two minutes, bound to its client, redirect and PKCE challenge.
CREATE TABLE oauth_codes (
  code_hash       TEXT PRIMARY KEY,
  client_id       TEXT NOT NULL,
  account_id      TEXT NOT NULL,
  redirect_uri    TEXT NOT NULL,
  code_challenge  TEXT NOT NULL,
  expires_at      BIGINT NOT NULL,
  used_at         BIGINT
);

-- One grant per sign-in: an access token (an hour) and a refresh token (30 days) that is replaced
-- on every use. Revoking the grant stops both.
CREATE TABLE mcp_grants (
  id                  TEXT PRIMARY KEY,
  client_id           TEXT NOT NULL,
  account_id          TEXT NOT NULL,
  access_hash         TEXT NOT NULL UNIQUE,
  access_expires_at   BIGINT NOT NULL,
  refresh_hash        TEXT NOT NULL UNIQUE,
  refresh_expires_at  BIGINT NOT NULL,
  created_at          BIGINT NOT NULL,
  last_used_at        BIGINT,
  revoked_at          BIGINT
);
CREATE INDEX idx_mcp_grants_account ON mcp_grants (account_id);
