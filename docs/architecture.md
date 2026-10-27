# Health App: Architecture

Status as of 26 Oct 2026. This file records **why** the system is built the way it is: the decisions in force, the rules the code must keep, the open risks and the rejected options. When a decision changes, edit it here and note the date.

- How the parts fit together and how data flows: [HLD.md](HLD.md).
- Modules, interfaces, the full schema and the algorithms: [LLD.md](LLD.md).

## 1. Product summary

A personal health app, Android first (Samsung S23), iPhone second. It reads the owner's Garmin data from the Garmin Connect Personal API, stores it locally and encrypted on the phone, shows daily screens and trends, keeps manual logs, and lets the owner ask Claude questions about their own data.

- **Phase 1 (now):** phone only. Everything is local.
- **Phase 2 (later):** server with Postgres, sync between devices, and a web app.

## 2. Decisions (phase 1)

| Area | Decision | Status |
|---|---|---|
| Language | TypeScript everywhere. No Rust. | Decided |
| UI | React + Vite | Decided |
| Mobile shell | Capacitor 8 (Android first, iOS from the same code) | Decided |
| Local database | SQLite via `@capacitor-community/sqlite`, encrypted with SQLCipher | Built 25 Oct 2026 |
| Query layer | Typed raw SQL behind a 3-method `SqlDriver` interface, Zod at untrusted edges (backup files). Drizzle rejected, see risk 4 | Decided 25 Oct 2026 |
| Data source | Garmin Connect **Personal API**, read directly with the owner's personal API key, behind the `Source` interface (section 4b). Full history from the Garmin account export (section 4c). Replaced freddy | Built 26 Oct 2026 |
| Transport to Garmin | Capacitor native HTTP on the phone (not subject to WebView CORS) | Built 26 Oct 2026 |
| Apple Health / Health Connect | Not read. Garmin is the only wearable source | Decided 26 Oct 2026 |
| Claude integration | An agent: official SDK over native HTTP with the owner's key; manual tool-use loop over local SQLite tools; reads with per-class consent and a disclosure log; changes are additive only, confirmed by the owner, logged and undoable, through the same functions the screens use; photos with their own consent | Core built 25-26 Oct 2026; Chat tab 26 Oct 2026 |
| Secrets | Garmin personal API key and Claude API key in Android Keystore / iOS Keychain via `@aparajita/capacitor-secure-storage`. The DB passphrase is random per install, in the SQLite plugin's own secure store. Secrets are never written to SQLite, so they are never in a backup | Built 25 Oct 2026 |
| Backups | Android auto-backup and device transfer disabled (`scripts/android-harden.mjs`). Manual export/restore, encrypted with a password | Built 25 Oct 2026 |
| Account | Optional Google sign-in (Android Credential Manager via `@capgo/capacitor-social-login`, no Firebase). One owner per install: the first account to sign in owns the phone's data. See section 5b | Built 26 Oct 2026; needs the Google Cloud setup |
| Capacitor config | `capacitor.config.json`, not `.ts`: the Capacitor CLI compiles a `.ts` config with the TypeScript JS API, which TypeScript 7 no longer ships | 25 Oct 2026 |
| Native projects | `android/` and `ios/` are generated (`npx cap add`) and git-ignored. Anything we change in them is a script (`scripts/android-harden.mjs`) | 25 Oct 2026 |
| Builds and CI | Docker is the standard way to test and build (`Dockerfile`: Node from `.nvmrc`, Temurin 21, Android SDK 36, digests and checksum pinned); CI runs the same image. Development and the emulator stay native, because an emulator cannot run in Docker on Windows (docs/dev-setup.md section 4). PRs only test; merging `develop` into `master` builds the signed release, checks it on an emulator, tags `v<version>` and publishes the APK as a GitHub release (section 6 of dev-setup.md) | 27 Oct 2026 |

### Why these choices

- **TypeScript, no Rust:** a solo project at personal scale (a few million rows a year). One language, and the official Anthropic and MCP SDKs are first-class in TypeScript.
- **Capacitor, not a PWA:** the only copy of offline data must not live in browser storage that can be evicted. Capacitor gives native SQLite with encryption, native HTTP, and later background tasks and push.
- **Garmin's Personal API, not a hub:** until Oct 2026 Garmin's API was partner-gated, so the app started on freddy (a hub with a 7-day free window). Garmin's free Personal API gives the owner's own data directly, with full history, no third party in between and no plan limits. HealthKit and Health Connect would need native code and are not needed for a Garmin owner.
- **Raw SQL, not an ORM:** the schema is small and SQLite-specific (partial indexes, views, upserts). Plain SQL behind `SqlDriver` runs unchanged on the phone, in Node tests and in scripts.

## 3. Rules the code must keep

Schema (so phase 2 is cheap):
- Primary keys: UUIDv7 as text. Never auto-increment. Exceptions are natural-key tables (`sync_state`, `app_settings`, `metric_catalog`).
- Timestamps: UTC epoch milliseconds, plus an `offset_min` column (minutes east of UTC at that moment).
- Rows that belong to a calendar day also store `local_day` (YYYY-MM-DD in the zone in force for that row), so screens filter by day without timezone maths in SQL.
- Every user-authored table has `updated_at`, `deleted_at` (soft delete) and `origin_device_id`.
- Health samples carry `source`, `device`, `external_id`, unique on (source, device, metric, external_id), so re-syncs are idempotent.
- Migrations are numbered SQL files (`src/db/migrations/0001_name.sql`), applied at startup in order, tracked in `PRAGMA user_version`, one transaction each.
- No semicolons inside SQL comments in migration files: the Android plugin splits scripts on `";\n"`. `*.sql` files are pinned to LF line endings (`.gitattributes`) for the same reason.
- Every new table must be added to `BACKUP_TABLES` (`src/features/backup/backup.ts`). A test fails otherwise.

Data:
- The same Garmin reading can be stored by several sources (`garmin`, `freddy`, `garmin_export`). Screens read `daily_metric_values`, which shows one per metric and day (migration 0009). Never add sources together.
- How a metric's day is aggregated comes from `classifyMetric` (`DAILY_AGG_OVERRIDES` where the name rule is wrong, for example the max training effect of a day with two workouts). A new override needs a migration line too; a test checks the two lists match.
- Keep the source label (for example "Garmin Forerunner 245") when showing Garmin data (Garmin's attribution rule).

Code structure (26 Oct 2026):
- Layers: `app/` (shell) -> `features/<name>/` -> `ui/`, `platform/`, `db/` -> `core/`. Only `platform/` imports Capacitor plugins at runtime, and no feature logic reaches one even indirectly. Platform pieces are passed in as parameters. `tests/architecture.test.ts` enforces this. Details: [LLD section 1](LLD.md#1-repository-layout).
- One feature, one folder: its logic, SQL and screens live together; shared code moves down a layer, never sideways into another feature's internals.
- Writes that touch several rows go through `withTransaction` (`src/db/tx.ts`).

Logging (26 Oct 2026):
- Use `createLogger(scope)` from `src/core/log.ts`, never `console.*` in `src/`. Default level `info` in the built app, `debug` in development; changeable in Settings > Debug logs and stored in `app_settings` (`log.level`).
- Log what happened, not the data: ids, counts, kinds, durations, statuses. Never health values, food or recipe names, notes, chat text, URLs or keys. The logger redacts secret-looking fields as a backstop and `tests/logging.test.ts` checks real flows.
- Logs stay on the phone in memory (500 records) and are only shared when the owner copies them.

Privacy and security:
- Secrets only in the Keystore/Keychain. Never in SQLite, logs, error messages or the repo.
- Error messages from the network layer never contain a URL, key or token.
- The phone only reads from Garmin. Health data leaves the phone only to Claude, with recorded consent and a disclosure log, and in backup files the owner shares.

## 4. Open risks and spikes

1. **[SUPERSEDED 26 Oct 2026] Can a third-party phone app read from freddy?** Yes (MCP endpoint, and a REST API on the Pro plan), and the app did so from 25 to 26 Oct 2026. Garmin's Personal API (section 4b) made freddy unnecessary, and its code was removed.
2. **[HIGH, mitigated] The phone holds the only copy of user-authored data** (notes, goals, manual logs, chats, settings).
   - Built 25 Oct 2026: encrypted manual backup covering every table (format in [LLD.md section 9](LLD.md#9-backup-and-restore)). Restore is a merge in one transaction.
   - Still open: backups are not automatic; the owner has to remember to export. Phase 2 sync removes the problem.
   - Synced Garmin data is no longer at risk: Garmin keeps the history and the next sync reads every day since the cursor.
3. **[MEDIUM] The Garmin Personal API is new** (opened in Oct 2026) and its documentation is not always right (section 4b lists what differs). Keep the `Source` interface swappable, keep `scripts/garmin-probe.ts` to check endpoints quickly, and treat an endpoint failing for lack of access (HTTP 403/404) as a warning, not a failed sync.
4. **[RESOLVED 25 Oct 2026] Drizzle with Capacitor SQLite: rejected.** `sqlite-proxy` maps rows by position, but the plugin returns objects keyed by column name. Single-table queries work, but a join that selects two `id` columns silently puts values in the wrong fields (`npm run spike:drizzle` shows it). Making it safe means aliasing every joined column by hand, which defeats the point. Decision: typed raw SQL. The plugin quirks the driver handles are listed in [LLD.md section 3](LLD.md#3-database-access).
5. **[LOW] Android background sync is unreliable** (Doze, battery optimisation). Main path: sync on app open, when the app comes back to the front after an hour, and with the header sync button. A local notification reminds the owner 3 days after the last successful sync (then daily), which usually means the Garmin key expired; it can be switched off in Settings. Nothing is lost by syncing late. Periodic background sync is a bonus for later.
6. **[MEDIUM] The Garmin personal API key expires** on a date the owner picks when making it (30 days to 1 year), and Garmin shows it only once. When it expires, syncs fail with a message that says so, the banner and the 3-day reminder appear, and the owner pastes a new key in Settings → Connections. Not built yet: a reminder before the expiry date.
7. **[MEDIUM, mostly answered 27 Oct 2026] Not yet run on the phone.** On a Galaxy S23-shaped Android 16 emulator the debug build passes `npm run test:device`: the encrypted database opens and migrates (the file has no SQLite header), the Garmin sync works over native HTTP, data survives a restart. That run found that scheduling the sync reminder opened Android's *Alarms & reminders* screen after every sync (fixed: the reminder asks for an inexact alarm). Still to check on the phone: One UI specifics (battery optimisation), backup share and restore.

## 4b. Decision 26 Oct 2026: read Garmin directly through the Garmin Connect Personal API

Garmin opened a free, read-only Personal API for the owner's own data in Oct 2026. It replaces freddy (25-26 Oct 2026, through freddy's MCP endpoint on the FREE plan: 7 days of history, 1 source, text-only tools).
- **Key and token:** the owner makes a personal API key in Garmin Connect on the web (Settings → Personal API Key). The app trades it for an access token (`POST personal.connectapi.garmin.com/personalapitoken-service/personal-api/personal-api-key/token`, header `Authorization: ApiKey <key>`), valid about 24 h, with no refresh token. Data calls send `Authorization: Bearer <token>`. The token is kept in memory and renewed 5 minutes before it expires, or once after a 401.
- **What is read** (`src/features/sync/garmin.ts`): profile settings (time zone), daily summaries, sleep, HRV, weight and activities, per 28-day chunk from the cursor (30 days back on the first sync), activities paged 99 at a time. Metric names are the export importer's (and freddy's), so one series per metric across sources.
- **Seen with a real key, different from Garmin's OpenAPI document** (26 Oct 2026): the token comes back as `text/plain`, and asking for JSON gets HTTP 406. `weight/all` always answers HTTP 400, so `weight/range?includeAll=true` is used. Weight is in grams although documented as kilograms. Sleep may lack `avgHeartRate` (`averageSpO2HRSleep` is used instead) and `sleepScores`. HRV can come back empty. Timestamps are epoch milliseconds, not strings.
- **Checked against the export** (26 Oct 2026, real data): of 902 metric-days stored by both, 0 are shown twice, and the values agree on nearly every metric. That comparison found that the export's activity calories are kilojoules (fixed, migration 0009). Daily minimum and maximum heart rate differ slightly: the API documents them as 2-minute averages.
- **Transport:** Capacitor native HTTP on the phone (no WebView CORS). The browser build uses `fetch`, which Garmin may block.
- **Terms:** for personal use. Revisit before any public release.
- **Real sync from a PC** (`npm run sync:garmin`, 26 Oct 2026): 939 readings, 40 metrics, 30 days; a second sync adds no rows.

## 4c. Garmin history import (26 Oct 2026)

The Personal API sync reads 30 days on its first run, so the long history comes from Garmin's own account export (Garmin Connect → Account → Data Management → Export Your Data, a ZIP by email). The owner drops it in `imports/garmin/` (git-ignored) and runs `npm run import:garmin` on the PC. It reads the daily summaries, sleep, weigh-ins, VO2 max and fitness age, and activities, and writes an **encrypted backup file** that the owner restores on the phone (Settings → Restore). Restore merges, so nothing on the phone is lost or duplicated.

- **Own source:** `garmin_export`, with the same metric names as the Personal API sync (`daily_steps`, `sleep_deepSleepDurationInSeconds`, `pulseOx_avgSpo2InPercent`, ...), so history and recent days are one series per metric. On a day both have a metric, it is the same watch reading twice: `daily_metric_values` shows the sync's only (migrations 0008 and 0009). Both rows stay in `health_samples`; nothing is summed or lost.
- **Units** were checked against a real export: activity distance and elevation in centimetres, durations in milliseconds, activity calories in kilojoules (found 26 Oct 2026 by comparing with the API, fixed in the importer and migration 0009), weight in grams. Garmin's "no data" markers (-1, -2, null) are dropped, and the profile weight (`USER_SETTING`) is not taken as a weigh-in.
- **Privacy:** activity names, places and coordinates, profile images, routes and social data are not imported. The script prints counts and date ranges only.
- **Why a backup file rather than an import screen:** it reuses the tested restore path, and keeps an 80 MB ZIP off the phone. The parser (`src/features/import/`, `fflate`) also runs in the WebView, so an in-app import can come later.
- First run (26 Oct 2026): 1,281 days, 1,231 nights, 45 weigh-ins, 690 VO2 max values and 245 activities from 2018 to 2026, 41,650 readings in 48 metrics. The backup is 1.4 MB.

## 5. Claude integration (phase 1)

Core built 25 Oct 2026 (`src/features/chat/`); the Chat tab (`ui/ChatScreen.tsx`) 26 Oct 2026. Details in [LLD.md section 9b](LLD.md#9b-claude-chat).

- The app calls the Anthropic API directly with the owner's own key, kept in the Keystore (acceptable for personal use; not for a public release).
- **Decision 26 Oct 2026: connect with a verified API key; no "Sign in with Claude".** The Claude API authenticates with API keys, Workload Identity Federation (servers, CI) or App Attest (registered iOS/macOS apps, 1-hour tokens, no key on the device). There is no OAuth sign-in a third-party Android app can use, and a Claude.ai subscription does not cover API use: usage is billed to a Claude Console workspace. The interactive `ant auth login` OAuth is for development on your own machine, and reusing Anthropic's own client for it inside this app would impersonate their client. So the app's "Connect Claude" flow (`src/features/chat/connect.ts`) opens the Console key page, takes the pasted key, verifies it with a free `GET /v1/models/claude-opus-5-5` before saving it, shows it as connected with its last 4 characters, and flags "needs attention" when a later request is rejected (revoked or expired key). Later: App Attest for the iPhone build (no key at all), and a server with Workload Identity Federation in phase 2.
- **Model:** `claude-opus-5-5`, effort set explicitly to `medium` (its default; set so an upstream change does not move cost silently), thinking at the model default (always on). Server-side refusal fallback on (`fallbacks: "default"`), so a false-positive safety decline is re-run on the recommended fallback model instead of failing.
- **SDK:** the official `@anthropic-ai/sdk`, given our native-HTTP `fetch` (`CapacitorHttp`), so there is no WebView CORS question. Non-streaming, because native HTTP reads the whole reply at once.
- **Tools** are SQL over the local database. Only their results leave the phone. Each tool declares a data class: `aggregate` (summaries: `list_metrics`, `metric_summary`, `compare_periods`, `nutrition_summary`, `manual_summary`, `list_goals`), `raw` (`daily_series`), `note` (`day_notes`).
- **Consent (GDPR, special-category data):** one consent per class (`claude.aggregates`, `claude.raw_series`, `claude.notes`), stored as history in `consents` with a policy version. No aggregates consent means nothing is sent at all. A tool whose class has no consent is not run; Claude gets an error telling it to answer without that data.
- Every tool result sent is logged in `ai_disclosures` (class, one-line summary, exact payload, size) for the "what was sent to Claude" panel.
- **History is append-only and stored verbatim** (`chat_messages.content_json`), thinking and fallback blocks included, so replays keep thinking blocks valid and the prompt cache warm. Prompt caching: fixed tool list and system text first, date block after, automatic cache breakpoint.
- Chat needs network; the rest of the app works offline.
- Present output as insights, not diagnosis (in the system prompt).

**Decision 26 Oct 2026: the chat is an agent that can change data, under the owner's control.** It logs meals (also estimated from a photo), logs saved meals and meal prep portions, saves favourites (with the chat photo), creates meal prep recipes, puts ingredients on the shopping list, records cooked batches, and logs drinks, measurements, day notes and goals. It writes through the same functions as the Food and Meal prep screens (`food.ts`, `mealPrep.ts`, `shopping.ts`), so its entries behave exactly like the owner's. The limits are enforced in code, not only described in the prompt:
- **Additive only.** New rows, or more of an open shopping-list line. It cannot edit or delete anything, set the calorie target, or touch settings, consents, keys, sync or backups.
- **Every change is confirmed** by the owner against the exact lines to be saved. Without a confirmation handler every change is declined.
- **Every proposal is logged** (`agent_actions`) and each saved one can be **undone** with the app's own undo for that kind of row (an eaten prep portion goes back into stock, a merged shopping quantity goes back to what it was). Undo checks every effect's table first.
- **Hard input limits:** logs only from 60 days back to today, plausible ranges for calories, macros, portions and volumes, capped counts and text lengths.
- **Photos** need their own consent (`claude.photos`), come from the app's downscaling picker, and each one sent is logged.
- **Prompt injection** (text in photos, notes, food names) is contained by the rules above: the worst an injected instruction can do is propose a change the owner sees and must confirm.
- **Health guardrails** in the prompt: no very-low-calorie or unsafe plans, allergens cannot be guaranteed, estimates come with their assumptions.

The one edit allowed (26 Oct 2026): filling a missing kcal or price on a drink type, because the owner usually learns those from the chat ("a Mahou costs 1.20"); it never overwrites a value and undo blanks it again.

Why additive-only with confirmation rather than full editing: wrong numbers in a health log are worse than a missing entry, and an undo per action keeps every mistake one tap from fixed. Editing and deleting stay on the app's own screens.

## 5b. Account: Google sign-in (decided 26 Oct 2026)

**What it is for:** knowing whose data this is. The phone's data gets an owner (Google's stable account id), so phase 2 sync can key everything by that account and a backup cannot be restored into another person's data. It is **not** a lock: the data is protected on the phone by SQLCipher with a Keystore key whether or not anyone is signed in (a biometric lock would be the tool for that).

**Decisions (by the owner):**
- **One owner per install.** The first Google account that signs in owns the phone's data, including everything already stored. A different account is told whose data this is and nothing changes. Releasing ownership (confirmed in the UI) lets the next account bind; the data stays.
- **Optional.** The app works offline without an account, as before. Signing out ends the local session but keeps the binding.

**How:**
- Android Credential Manager through `@capgo/capacitor-social-login` (Capacitor 8, no Firebase). It returns an ID token; the app checks its claims (issuer `accounts.google.com`, audience = our Web client id, expiry, subject) and stores only identity facts in the `account` table: subject, email, whether Google verified it, name, times. **No token is stored.** The signature is not checked on the phone: the token arrives from the OS over the native bridge and only labels ownership. Any server that trusts it (phase 2) must verify the signature.
- Logs never contain the email or the account id.
- Backups include the `account` row; restore refuses a backup whose owner is a different account (message names its email), and on a phone with no owner the restore brings its owner along.

**Setup the owner does once (Google Cloud Console):** a project; the OAuth consent screen (Testing mode, add your own Google account as a test user; scopes `email`, `profile`); a **Web application** OAuth client, whose id goes in `.env` as `VITE_GOOGLE_WEB_CLIENT_ID` (public, not a secret); an **Android** OAuth client for package `app.health.personal` with the SHA-1 of the signing key (debug key from Android Studio, Gradle `signingReport`; later also the release / Play App Signing key). Credential Manager needs the **Web** client id in the app; using the Android one is the usual cause of "Developer console is not set up correctly".

## 6. Phase 2 parking lot (noted, not built)

- **Server:** Node + TypeScript API (Fastify or Hono), Postgres in Docker, same setup in dev and production. No SQLite on the server.
- **Sync:** health samples are append-only and one-directional, so a simple cursor sync (server-assigned sequence number, client asks for everything after N). User-authored tables use last-write-wins per row on `updated_at`, which the schema rules already support. If multi-device editing becomes real, adopt PowerSync (syncs Postgres to client SQLite with a local-write upload queue). Verify its licensing and self-hosting terms first.
- **Web:** React build using SQLite WASM.
- **Claude:** move the API key behind a server proxy; add a remote MCP server (TypeScript SDK, OAuth) so Claude.ai can query derived data.
- **Postgres details:** plain Postgres with partitioned time-series tables. TimescaleDB only if needed. `pg_dump` backups to encrypted storage.

## 7. Rejected options and why

| Option | Reason rejected |
|---|---|
| Rust core (Tauri / UniFFI) | Not needed at this scale; slower for a solo developer. React is the better UI layer. |
| Drizzle ORM | Positional row mapping breaks on the plugin's object rows (risk 4). |
| freddy (health data hub, MCP) | Used 25-26 Oct 2026. Replaced by the Garmin Personal API: no third party, full history, no 7-day window or 1-source limit, JSON instead of text. |
| Direct HealthKit / Health Connect plugins | Native code for data a Garmin owner already has in Garmin Connect. |
| Garmin Health API (partner program) | Partner-gated. The Personal API covers the owner's own data. |
| Unofficial Garmin scrapers | Fragile, risk of account bans, poor base for a health product. |
| PWA as the mobile shell | Browser storage eviction risk for the only offline copy. |
| SQLite on the server | Two SQL dialects to maintain. Postgres everywhere on the server. |
| CRDTs | Overkill for append-only health data plus small user tables. |
| Neon Realtime | Neon Postgres only; no SQLite client. |

## 8. Open question for the owner

Which 2-3 screens will be opened every day (for example today's sleep and recovery, a weekly trend, a food and alcohol log, a Claude chat)? The schema already covers all of these, so the answer decides what to build next, not what to store. Also still unanswered: which differentiator justifies the app, given that Claude plus a health-data connector already lets you ask questions about your data (candidates: own long-term history, dashboards, derived metrics, manual logs, proactive alerts).

## 9. Next steps

1. **Run on the real S23**: USB debugging on, then `npm run test:device -- --install android/app/build/outputs/apk/debug/app-debug.apk --fresh` (the same 11 checks as on the emulator), and backup export/share/restore by hand.
2. Answer the open question in section 8, then build those screens on the existing schema.
3. Try the Chat tab on the phone (camera, consent, confirmations, undo); the agent can also be tried from the PC with `npm run chat`.
4. Remind the owner before the Garmin key expires (risk 6): ask for the expiry date with the key.
5. Read the Garmin data the sync does not map yet: VO2 max and fitness age, nutrition and hydration logs, floors, respiration.
