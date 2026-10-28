-- Admins and the operator's audit log (docs/users.md section 2.6). An admin manages accounts,
-- invites and devices. Nothing here opens a sealed row: admins see who and when, never data.

-- Granted only from the CLI (npm run sync:admin), never from the API.
ALTER TABLE accounts ADD COLUMN is_admin BOOLEAN NOT NULL DEFAULT FALSE;
-- A suspended account keeps everything but cannot sign in, pair or sync until it is reactivated.
ALTER TABLE accounts ADD COLUMN suspended_at BIGINT;

-- Who made an invite (an admin account id, or NULL for the CLI), and whether it was cancelled.
ALTER TABLE invites ADD COLUMN created_by TEXT;
ALTER TABLE invites ADD COLUMN cancelled_at BIGINT;

-- Every admin action: who (an account id, or "cli"), what, on which account or invite, when.
-- detail holds ids and numbers only, never an email or a code.
CREATE TABLE admin_audit (
  id      TEXT PRIMARY KEY,
  at      BIGINT NOT NULL,
  actor   TEXT NOT NULL,
  via     TEXT NOT NULL,
  action  TEXT NOT NULL,
  target  TEXT,
  detail  TEXT
);
CREATE INDEX idx_admin_audit_at ON admin_audit (at);
