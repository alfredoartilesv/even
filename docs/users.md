# Even: users, devices, friends (phase 2, 0.4)

Status: draft, 28 Oct 2026. Decided with the owner: **built like a public product, run as a private one**: real accounts, isolation, sign-up, deletion and audit as if strangers used it, but sign-up is by invite, the app stays non-commercial (Vercel Hobby and Neon free), and there is no marketing, billing or support load. The web holds a **full end-to-end encrypted copy** (as a phone does). A new device gets the key **by QR from a device that has it, or by a recovery passphrase**. Others see data **only as friends, and only the kinds the owner chose**.

How it fits the rest: [architecture.md section 6](architecture.md#6-phase-2-server-sync-web) (server, sync protocol, encryption), [dev-setup.md section 4b](dev-setup.md#4b-sync-environment-postgres-the-sync-server-the-web-app) (environment).

## 1. Who is who

| Principal | What it is | Can | Cannot |
|---|---|---|---|
| **Account** (a person) | One Google account (`subject`, stable), invited. Owns one data set. Today's phone `account` row is this. | Read and write all of its own data from any of its devices; invite friends; choose what each friend sees; delete everything | See another account's data unless shared; sign up without an invite |
| **Device** | One phone, or one browser profile, of an account. The unit the server authenticates. | Push and pull its account's rows; pair a new device; manage friends and shares | Act for another account; survive revocation |
| **Friend** | Another account connected by an invite both accepted. | Read, on its own devices, the kinds the owner shared with it, as daily summaries | Write anything; see kinds not shared; see raw rows, notes, chats, photos (never shareable in 0.4) |
| **Operator** | Whoever runs Vercel, Neon and the CLI (the owner, today). | Deploy, migrate, invite, see counts, sizes, last-seen times, revoke devices | Read any health data: the server holds ciphertext only |
| **Claude** | The owner's Anthropic key, per device. Not a user of the server. | What the phone's chat already does, with the same consents and disclosure log | Reach the server or friends' data |

## 2. What each one needs, case by case

### 2.1 First phone (new account)

1. Owner opens Settings > Sync, signs in with Google. Server checks the Google ID token, and that the email has an invite; creates the account.
2. Phone makes the **account data key** (ADK, 32 random bytes: today's sync secret) and an **identity key pair** (ECDH P-256, WebCrypto on both phone and web).
3. Owner sets a **recovery passphrase** (shown strength meter, at least 4 random words suggested). Phone derives a wrapping key (PBKDF2-SHA256, 600k iterations, as backups; Argon2id if a WASM build is acceptable) and uploads `wrap(ADK)` plus a **key check** (HMAC of a fixed string under ADK).
4. Server stores: account, device (token hash), public identity key, wrapped ADK, key check. Phone stores in the Keystore: ADK, identity private key, device token.
5. First push of everything.

Needs: Google sign-in on Android (built), Google ID token check on the server (new), invites (new), Keystore entries (built pattern).

### 2.2 Add the web (or a second phone)

**By QR (normal path):**
1. Sign in with Google in the browser. Server knows the account but the browser has no ADK.
2. Browser makes an ephemeral key pair and shows a QR: pairing id + its public key + a 6-digit code.
3. On the phone: Settings > Sync > Add a device, scan, check the code matches. Phone encrypts ADK and the identity private key to the browser's ephemeral key (ECDH + AES-GCM) and posts it to the pairing session.
4. Browser opens it, checks the key check, registers as a device, pulls everything into SQLite WASM (OPFS), asks for persistent storage (`navigator.storage.persist()`).
Pairing sessions live 5 minutes and are single use; the server only relays ciphertext.

**By passphrase (recovery, or no phone at hand):** sign in, type the passphrase, browser fetches the wrapped ADK, unwraps it, checks the key check, registers. Rate-limited per account (5 tries an hour), and every device sees "a device was added by passphrase".

Needs: pairing endpoints, a QR scanner on the phone (camera plugin, new), SQLite WASM web data layer (new, the `platform/` swap the demo build already does), persistent storage request.

### 2.3 Every day

| | Phone | Web |
|---|---|---|
| Garmin, Apple Health | reads them (phone only: Garmin's key and HealthKit stay on the phone) | sees them after the phone syncs |
| Logs (food, meal prep, alcohol, journal) | yes | yes, same rows, last write wins |
| Dashboard, Profile, trends | yes | yes, more room |
| Chat with Claude | yes, key in the Keystore | yes, **owner's own key, called from the browser directly** (Anthropic's browser access header), key kept non-extractable in IndexedDB, never on the server. Same consents and disclosure log, synced |
| Backups | as today | export only |
| Sync | after each Garmin sync and on open | on open, every few minutes while open |

### 2.4 Friends

1. Owner makes an invite (link or 8-character code, 7 days, single use) and sends it however they like.
2. Friend (with their own invited account) accepts. Both see a pending connection; nothing is shared yet.
3. Each side picks, per friend, the **kinds** to share. 0.4 kinds: `activity` (steps, active minutes, workouts list), `sleep` (duration, score), `recovery` (resting HR, HRV, body battery), `weight`, `nutrition` (daily kcal and macros, not food names), `alcohol` (daily grams and standard drinks). Never shareable: notes, journal text, chats, photos, food names, account details.
4. For each (friend, kind) the owner's devices keep a **share key**, wrap it to the friend's public identity key, and upload sealed **daily summaries** for that kind (from `daily_metric_values` and the log totals) into a separate share stream. Raw rows never go to a share.
5. The friend's devices pull share streams read-only and show a **Friends** tab: their shared kinds, last 90 days.
6. Removing a kind or the friend: the server stops serving that stream at once and deletes it; the owner's devices rotate the share key if the friendship continues. What the friend already saw cannot be unseen: the UI says so before sharing.

Every grant and removal is a row in the owner's (synced) audit log, as `consents` is for Claude.

### 2.5 Devices and safety

- **Revoke a device** from any other device (Settings > Sync > Devices, with last seen). Its token stops at once. For a lost or stolen device, also **rotate the ADK** (re-seal everything, re-wrap for every device, new passphrase wrap): slow, offered, not automatic.
- **Change passphrase:** re-wrap ADK only.
- **Lost every device:** sign in + passphrase. Lost the passphrase too: the server copy is unreadable by design; a backup file is the only way back.
- **Delete account:** from any device; server deletes every row of the account (rows, devices, shares to and from it, invites, wraps) in one transaction; local data stays on devices until the owner deletes it.

### 2.6 Operator

- `npm run sync:invite -- --email ...` (new, replaces hand-made device tokens), `sync:device --revoke`, migrations in the Vercel build.
- Sees per account: devices and last seen, row counts, bytes (Neon free has 0.5 GB: about 1 GB-year of samples for one person, so a quota per account, default 100 MB, with a clear error).
- Logs: device ids, counts, durations. Never emails in logs (the account id instead), never blobs.

## 3. What the server needs (on top of PR #53)

| Table | For |
|---|---|
| `accounts` (id, google_subject unique, email, created_at, deleted_at, quota_bytes) | sign-in, isolation (today's `owner_id` becomes `account_id`) |
| `invites` (code_hash, email, created_by, expires_at, used_at) | invite-only sign-up |
| `devices` + `kind` (phone, web), `added_by` (qr, passphrase) | as now, plus how it was added |
| `account_keys` (account_id, identity_public, adk_wrapped, wrap_params, key_check) | pairing and recovery |
| `pairings` (id, account_id, ephemeral_public, sealed_payload, expires_at, used_at) | QR pairing relay |
| `friendships` (a, b, status, created_at) and `friend_invites` | connections |
| `shares` (id, owner_id, friend_id, kind, wrapped_key, revoked_at) and `share_rows` (share_id, day_key, seq, blob) | friend streams |

Auth changes: sessions from a Google ID token (`jose` against Google's keys) issue a device token; every query is scoped by account id from the token, never from the request body; rate limits per account and IP on sign-in, passphrase recovery and invites (a small table on Postgres, no extra service).

## 4. Public-product hygiene, kept even though it is private

- Isolation tested: a test per endpoint that another account's token gets 404/403 (the "another owner" test in `tests/cloudSync.test.ts` is the pattern).
- A privacy page in the app: what the server stores (ciphertext, sizes, times, devices, friend links), what friends see, how to delete.
- Account deletion and export work from day one.
- Health data is special-category data (GDPR art. 9): E2E keeps it unreadable on Neon and Vercel; friend sharing is explicit consent per kind; the audit log proves it.
- If it ever becomes a real public product: Vercel Pro (Hobby is non-commercial only), a DPA with Neon and Vercel, terms, a support address. Nothing in this design blocks that.

## 5. Order of work for 0.4

1. Fix the three sync findings from the review of PR #53 (photos over the row limit, push cursor and clock skew, one unreadable row stopping the pull).
2. Accounts, invites and Google ID token sign-in on the server; device tokens from sign-in.
3. ADK, key check and passphrase wrap; Settings > Sync on the phone; sync wired into the app.
4. Web data layer (SQLite WASM in OPFS) and QR pairing.
5. Chat on the web with the owner's key.
6. Friends and shares (daily summaries per kind).

## 6. Open questions

- Friends see 90 days back, or from the day of sharing on? (Draft: 90 days back.)
- Should a friend's shared kinds also go to the owner's Claude chat when asked about the friend? (Draft: no.)
- Argon2id (WASM, about 200 KB, lazy) or PBKDF2 for the passphrase? (Draft: PBKDF2 at 600k, as backups, revisit.)
