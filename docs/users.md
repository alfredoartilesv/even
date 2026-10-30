# Even: users, devices, friends (phase 2, 0.4)

Status: built 28 Oct 2026 (PR #53), apart from the items in section 8. Decided with the owner: **built like a public product, run as a private one**: real accounts, isolation, sign-up, deletion and audit as if strangers used it, but sign-up is by invite, the app stays non-commercial (Vercel Hobby and Neon free), and there is no marketing, billing or support load. The web holds a **full end-to-end encrypted copy** (as a phone does). A new device gets the key **by a pairing code from a device that has it (typed now, a QR later), or by a recovery passphrase**. Others see data **only as friends, and only the kinds the owner chose**.

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

### 2.6 Operator and admins

Decided 28 Oct 2026: the operator works through an **admin account**, a role on an ordinary account granted only from the CLI (`npm run sync:admin -- --email ...`; no endpoint grants it).

- **Settings > Admin** (phone and web, shown only to admins; the server checks the role on every `/v1/admin` request): make an invite for an email (3 to 30 days, the code shown once and sent through the share sheet), list and cancel invites, list accounts (devices, last seen, storage against the quota, friend count), change a quota (10 MB to 2 GB), see and revoke an account's devices, suspend or reactivate an account.
- **Suspended** means: its devices get 403 on every request, passphrase sign-in is refused (only after the passphrase matched, so a stranger learns nothing), nothing is deleted. An admin cannot suspend themselves. Deleting an account stays with its owner.
- **Never:** an admin reads no row, key or share, and does not see who is friends with whom (a count only). The server could not read the data anyway.
- **Audit log** (`admin_audit`): every admin action with who (account id, or `cli`), through what (`app`, `mcp`, `cli`), on which account or invite, when. Ids and numbers only, never an email or a code.
- The same actions are tools of the admin MCP server, for Claude (section 9).
- CLI: `sync:invite`, `sync:accounts`, `sync:admin`, migrations in the Vercel build.
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

Shipped in 0.4.0 (28 Oct 2026), with fixes in 0.4.1 and 0.4.2 (the Vercel function, the phone's sync, the connect screens). Where it went another way than planned: the web database is sql.js sealed in IndexedDB (not OPFS), pairing codes are typed (QR later), and sign-up is invite plus passphrase before Google (section 6).

1. Fix the three sync findings from the review of PR #53 (photos over the row limit, push cursor and clock skew, one unreadable row stopping the pull).
2. Accounts, invites and Google ID token sign-in on the server; device tokens from sign-in.
3. ADK, key check and passphrase wrap; Settings > Sync on the phone; sync wired into the app.
4. Web data layer (SQLite WASM in OPFS) and QR pairing.
5. Chat on the web with the owner's key.
6. Friends and shares (daily summaries per kind).

## 6. Decided (28 Oct 2026)

- **One identity: the sync account is the user.** Google is an optional way into it (Settings > Sync & devices > Google, `POST /v1/me/google`; the server's `GOOGLE_CLIENT_ID` must be the same Web client id as the app's `VITE_GOOGLE_WEB_CLIENT_ID`). A connected device's backups name its sync account, and a connected device restores only backups of the same account, whatever Google account owns the phone locally. The local Google owner (migration 0007, Settings > Profile) stays only for phones that never connect, and for backups made before connecting. Its row syncs like any other, so the devices of one account agree on it.
- Sign-in for 0.4 is invite + email + passphrase, with pairing for more devices; "Sign in with Google" comes after the deploy. Admins make invites (section 2.6), and Claude can too, through the admin MCP server (section 9).

- Friends see 90 days back from the day a kind is shared.
- A friend's shared data never goes to the owner's Claude chat.
- The passphrase uses PBKDF2-SHA256 at 600k iterations, as backups do; Argon2id to be revisited.

## 7. Claude with the owner's Claude Pro plan (asked 28 Oct 2026)

The owner would rather use their Claude Pro subscription than a paid API key for the phone's chat. A Pro plan covers Anthropic's own apps (claude.ai, the Claude desktop and mobile apps, Claude Code). A third-party app like Even cannot sign in with it or send requests on it: there is no "Sign in with Claude" for apps (section 5 of architecture.md), and borrowing a subscription login token from another app is against Anthropic's terms and can get the account suspended. So the in-app chat keeps the API key (pay per use; Haiku keeps it to cents a day).

The way to use the Pro plan is the other direction: **Claude's apps come to Even's data**, as a custom connector (a remote MCP server, which Pro can add in Settings > Connectors). The owner then asks Claude on claude.ai or the Claude phone app, on the Pro plan, and Claude calls Even's tools. The catch: the server only holds ciphertext, so the connector needs its own readable copy. Shape that keeps the rules: Claude is treated like a friend, with its own share key, held by the MCP server, receiving only the kinds the owner ticks, as daily summaries, every call in the disclosure log. Readable on the server, but only that stream. Not built; needs the owner's yes, as it is the first plaintext on the server (architecture.md section 3).

**Decided 28 Oct 2026:** not the data connector. Claude on the Pro plan gets an **admin** connector instead (section 9): it manages the service with the admin tools and sees no health data. A data connector would still need its own decision.

## 8. As built (28 Oct 2026)

- **Sign-up is invite plus passphrase, not Google first.** Google sign-in is not set up yet (no Web OAuth client id in the build), and the keys need the passphrase or a pairing anyway. An account is made from an invite (`npm run sync:invite`) and the email it was made for; Google can be linked to it later (`POST /v1/me/google`, the ID token checked against Google's keys). The web Google button waits for the client id and its origin in Google Cloud.
- **The passphrase gives two keys** (PBKDF2-SHA256, 600k iterations, 64 bytes): one unwraps the account data key on the device, the other is sent as proof and the server keeps its SHA-256. A wrong passphrase and an unknown email get the same answer; unknown emails get a stable made-up salt (from `SERVER_SECRET`). Five tries an hour per email, twenty per address.
- **Pairing codes** are `XXXXXX-YYYYYY`: the pairing id and six characters of the new device's key fingerprint, so the approving device notices a swapped key. Typed for now; a QR scanner is a follow-up. They work once, for 5 minutes; the sealed keys are relayed once and then deleted.
- **Friend summaries** are pushed for the last 90 days on every sync of the owner's devices, sealed per day with the share key. A friend's data is read from the server when shown, never stored on the friend's device.
- **The web app's database** is sql.js in memory, saved to IndexedDB sealed with a non-extractable key of that browser profile; one tab at a time (Web Locks). Disconnecting or deleting the account on the web wipes that copy.
- **How long the web keeps it** (decided 28 Oct 2026, `src/apps/web/browserCopy.ts`): until Disconnect, or 30 days without being opened (then the copy and its sealing key are deleted, the device is removed, and the Connect screen says why), or, with **This is a shared computer** ticked when connecting, until the tab closes. In that mode nothing reaches IndexedDB: the data, the session and the key stay in the tab's memory (`keepNothing` in `platform/idb.ts`), a reload signs out, and closing the tab removes the device on the server. A browser connected by pairing never had a passphrase, so coming back after 30 days means connecting again, by passphrase or by pairing.
- **Connecting** (`screens/cloudsync/ConnectPanel.tsx`, 30 Oct 2026): three ways in, each with one line saying whose it is: *Sign in* (email and passphrase; after forgetting it, pair and set a new one), *Pair* (the code with a countdown, copy and cancel, and where to type it on the connected device) and *New account* (a live hint on what the passphrase still needs, and a switch confirming it is written down). The server address can be typed without `https://`.
- **Signing out on the web:** the side menu shows the account's email and *Sign out*, which disconnects the browser and removes its copy, as Settings > Sync & devices does.
- **Not built yet:** QR scanning, Google on the web, rotating the account data key after a lost device, a per-account quota other than the default 200 MB, the audit log of share grants as rows in the owner's data (the server keeps the shares themselves).

## 9. The admin MCP server (decided 28 Oct 2026)

Claude (on claude.ai or the Claude apps, on the owner's Pro plan) manages Even as a custom connector at `<server>/mcp`, with the same functions as Settings > Admin (`server/mcp.ts` over `server/admin.ts`). Tools: `service_health`, `list_invites`, `create_invite`, `cancel_invite`, `list_accounts`, `list_devices`, `revoke_device`, `set_quota`, `suspend_account`, `audit_log`. None reads a row, key or share, so **Claude never sees health data**. It does see what an admin sees: account names, emails, device names, dates and sizes. Every change is in the audit log with via `mcp`.

**Sign-in** (`server/oauth.ts`, OAuth 2.1 as claude.ai expects):
- Claude finds the metadata (`/.well-known/oauth-protected-resource`, `/.well-known/oauth-authorization-server`) and registers itself (Dynamic Client Registration, public client).
- Codes are only sent to Claude's callbacks (`claude.ai`, `claude.com`) or to `localhost`. Registration is open, so this stops a look-alike client from getting a code.
- The login page asks for the admin's email and passphrase. Its script derives the same proof as passphrase sign-in and posts only that; the passphrase field has no name and is cleared. The same rate limits apply (5 an hour per email, 20 per address). Only an admin account that is not suspended gets a code. The page says where the browser goes next, and has a strict CSP with no framing.
- PKCE (S256 only), codes single use for 2 minutes. Access tokens last an hour; refresh tokens last 30 days and are replaced on every use. All are stored as hashes.
- Settings > Admin > Claude connector shows the address to add and every connection, with Disconnect. Losing the admin role or being suspended stops the tokens at once.

Stateless Streamable HTTP with JSON answers, so it runs in the same Vercel function as the API. `PUBLIC_URL` (for example `https://even.vercel.app`) fixes the issuer and resource address; without it they come from the request.

