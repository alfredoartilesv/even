-- 0007: the Google account that owns this phone's data.
-- Same conventions as 0001 to 0006. Never put a semicolon inside a comment here.

-- One owner per install: at most one live row, id 'owner'. The first Google sign-in binds the
-- account and adopts every row already on the phone. subject is Google's stable account id
-- (the sub claim of the ID token), the key for phase 2 sync. The email can change and is kept
-- for display only. No token is stored. signed_in is the local session: signing out keeps the
-- binding. Releasing ownership soft-deletes the row, and the next sign-in binds again.
CREATE TABLE account (
  id                TEXT PRIMARY KEY CHECK (id = 'owner'),
  provider          TEXT NOT NULL CHECK (provider IN ('google')),
  subject           TEXT NOT NULL CHECK (subject <> ''),
  email             TEXT,
  email_verified    INTEGER NOT NULL DEFAULT 0 CHECK (email_verified IN (0, 1)),
  name              TEXT,
  bound_at_ms       INTEGER NOT NULL,
  last_sign_in_ms   INTEGER,
  signed_in         INTEGER NOT NULL DEFAULT 0 CHECK (signed_in IN (0, 1)),
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  deleted_at        INTEGER,
  origin_device_id  TEXT NOT NULL
);
