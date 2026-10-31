-- The health connector (docs/users.md section 10): Claude, signed in as the owner, reads and adds
-- to the owner's own data through /mcp/health. Unlike the admin scope this needs the sync keys.
-- The owner's browser derives them on the sign-in page (the account data key itself never leaves
-- it). They are kept sealed with a key made from the code or token they belong to, which only
-- Claude holds (the server keeps hashes), so a copy of this database alone opens nothing.

-- admin (the admin MCP server) or health (the health connector). Older rows are admin.
ALTER TABLE oauth_codes ADD COLUMN scope TEXT NOT NULL DEFAULT 'admin';
-- The sync keys sealed with the code, set when the sign-in page sends them (health only).
ALTER TABLE oauth_codes ADD COLUMN keys_sealed TEXT;

ALTER TABLE mcp_grants ADD COLUMN scope TEXT NOT NULL DEFAULT 'admin';
-- The device the connector's changes are pushed as, so they sync and show who made them.
ALTER TABLE mcp_grants ADD COLUMN device_id TEXT REFERENCES devices (id);
-- The sync keys sealed with the access token, and again with the refresh token.
ALTER TABLE mcp_grants ADD COLUMN keys_access TEXT;
ALTER TABLE mcp_grants ADD COLUMN keys_refresh TEXT;
