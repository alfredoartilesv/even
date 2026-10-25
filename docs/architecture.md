# Health App: Architecture

Status as of 25 Oct 2026. This file records **why** the system is built the way it is: the decisions in force, the rules the code must keep, the open risks and the rejected options. When a decision changes, edit it here and note the date.

- How the parts fit together and how data flows: [HLD.md](HLD.md).
- Modules, interfaces, the full schema and the algorithms: [LLD.md](LLD.md).

## 1. Product summary

A personal health app, Android first (Samsung S23), iPhone second. It pulls wearable and health data through freddy, stores it locally and encrypted on the phone, shows daily screens and trends, keeps manual logs, and lets the owner ask Claude questions about their own data.

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
| Data source | freddy as the single intermediary, behind the `Source` interface. Now: freddy's **MCP endpoint** (works on the FREE plan, section 4b). Later, on Pro: its Personal REST API, behind the same interface | Built 25 Oct 2026 |
| Transport to freddy | Capacitor native HTTP by default (not subject to WebView CORS). WebView `fetch` selectable in Settings | Built 25 Oct 2026 |
| Apple Health / Health Connect | Handled by freddy's own mobile apps. No native health code in our app. | Decided |
| Garmin | Via freddy only. No direct Garmin integration. | Decided |
| Claude integration | Called directly from the app with a user-supplied API key; the tool-use loop runs locally against SQLite | Decided, not built |
| Secrets | freddy URL + key (and later the Claude key) in Android Keystore / iOS Keychain via `@aparajita/capacitor-secure-storage`. The DB passphrase is random per install, in the SQLite plugin's own secure store. Secrets are never written to SQLite, so they are never in a backup | Built 25 Oct 2026 |
| Backups | Android auto-backup and device transfer disabled (`scripts/android-harden.mjs`). Manual export/restore, encrypted with a password | Built 25 Oct 2026 |
| Capacitor config | `capacitor.config.json`, not `.ts`: the Capacitor CLI compiles a `.ts` config with the TypeScript JS API, which TypeScript 7 no longer ships | 25 Oct 2026 |
| Native projects | `android/` and `ios/` are generated (`npx cap add`) and git-ignored. Anything we change in them is a script (`scripts/android-harden.mjs`) | 25 Oct 2026 |

### Why these choices

- **TypeScript, no Rust:** a solo project at personal scale (a few million rows a year). One language, and the official Anthropic and MCP SDKs are first-class in TypeScript.
- **Capacitor, not a PWA:** the only copy of offline data must not live in browser storage that can be evicted. Capacitor gives native SQLite with encryption, native HTTP, and later background tasks and push.
- **freddy, not direct integrations:** HealthKit needs native iOS code, and Garmin's API is partner-gated (new public access was reported closed as of Sept 2026; verify on Garmin's portal). freddy covers Apple Health, Health Connect and Garmin.
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
- Every new table must be added to `BACKUP_TABLES` (`src/backup/backup.ts`). A test fails otherwise.

Data:
- For daily totals from Apple Health / Health Connect, prefer freddy's `<metric>_total` "Merged" metrics. They are already de-duplicated across apps. Never add per-app rows together.
- Keep the source label (for example "Garmin Forerunner 245") when showing Garmin data (Garmin's attribution rule, via freddy's terms).

Privacy and security:
- Secrets only in the Keystore/Keychain. Never in SQLite, logs, error messages or the repo.
- Error messages from the network layer never contain the freddy URL or key.
- Health data leaves the phone only to freddy (reads) and, later, to Claude with recorded consent and a disclosure log.

## 4. Open risks and spikes

1. **[RESOLVED 25 Oct 2026] Can a third-party phone app read from freddy?** Yes, two ways. The MCP endpoint is what we use now (section 4b). freddy also has a documented read-only REST API ("Personal API", v1.2.0), included in the Pro plan:
   - Base URL `https://freddy.coach/api/v1/`, auth `Authorization: Bearer fk_live_...`. Keys are created in the freddy dashboard (AI apps -> API keys); the secret is shown once. Up to 10 active keys.
   - Endpoints (all GET): `/metrics` (filters `metric`, `provider`, `device`, `source_id`, `from`, `to`, `limit` up to 1000, cursor paging via `next_cursor`, optional `include_raw`), `/catalog`, `/sources`, `/profile`. Spec: `https://freddy.coach/api/openapi.json`.
   - Record fields: `date`, `timestamp` (UTC), `provider`, `source`, `metric`, `device`, `deviceLabel`, `sourceId`, `numValue`, `textValue`, `unit`, `stream`, plus `raw`/`rawStatus` with `include_raw=true`. One provider record can span several rows: join on (`provider`, `sourceId`). Use `device` (stable), never `deviceLabel`, for filtering.
   - Limits: 120 req/min per key, 30 `include_raw` req/min per account, raw pages capped at 50 rows / about 8 MB. Results are newest first and bounded by the plan's history window.
   - Terms: freddy's terms do not mention API use or apps built on the data. They forbid sharing your MCP endpoint with third parties for data collection and accessing other users' data. For anything beyond personal use, email freddy (contact in their terms) first.
2. **[HIGH, mitigated] The phone holds the only copy of user-authored data** (notes, goals, manual logs, chats, settings), and on the FREE plan also of samples older than 7 days.
   - Built 25 Oct 2026: encrypted manual backup covering every table (format in [LLD.md section 9](LLD.md#9-backup-and-restore)). Restore is a merge in one transaction.
   - Still open: backups are not automatic; the owner has to remember to export. Phase 2 sync removes the problem.
3. **[HIGH] Vendor dependency on freddy**, a small service. Keep the `Source` interface swappable and mirror data locally.
4. **[RESOLVED 25 Oct 2026] Drizzle with Capacitor SQLite: rejected.** `sqlite-proxy` maps rows by position, but the plugin returns objects keyed by column name. Single-table queries work, but a join that selects two `id` columns silently puts values in the wrong fields (`npm run spike:drizzle` shows it). Making it safe means aliasing every joined column by hand, which defeats the point. Decision: typed raw SQL. The plugin quirks the driver handles are listed in [LLD.md section 3](LLD.md#3-database-access).
5. **[MEDIUM] Android background sync is unreliable** (Doze, battery optimisation). Main path: sync on app open and on "Sync now". Periodic background sync is a bonus for later.
6. **[HIGH] Free-plan history window.** The owner's freddy account is on FREE: 7 days of history, 1 connected source, Garmin the only queryable provider. Anything older than 7 days cannot be fetched, so the local mirror only keeps what it has synced; the app syncs on every launch and warns about gaps. Health Connect (the phone's own data, including any nutrition or hydration entries) is connected in freddy but **paused** because of the 1-source limit. Decide: upgrade, or choose which source to keep.
7. **[MEDIUM] Not yet run on a device.** Everything is tested in Node against a fake that copies the Android plugin's behaviour, and a real freddy sync has been run from a PC. The first run on the S23 must confirm: encrypted DB opens and migrates, native-HTTP sync, backup share and restore.

## 4b. Decision 25 Oct 2026: stay on the FREE plan and read freddy through MCP

The Personal REST API needs freddy Pro. For now the app talks to freddy's MCP endpoint (the personal URL plus a key).
- The MCP tools return **text**, not JSON. `src/sources/freddyText.ts` parses it; unknown lines are reported as warnings, never dropped silently. The formats seen so far are pinned by tests (`tests/fixtures.ts`).
- `FreddySource` talks to a small `ToolCaller` interface, so the transport can change (MCP now, REST later) without touching the sync logic.
- Free-plan limits apply: 7-day window, 1 source (Garmin). A cursor older than the window produces a "Gap" warning.
- The MCP URL and key are secrets: stored on the device (Keystore), never in the repo. Rotate them if they are ever pasted anywhere.
- Terms: freddy forbids sharing the MCP endpoint with third parties for data collection. An app on the owner's own phone, using the owner's own endpoint, is not a third party, but it is not what the endpoint is documented for. Revisit before any public release.
- **Probe result (25 Oct 2026, real endpoint):** URL alone returns 401; the URL plus `Authorization: Bearer <key>` works. Replies are `text/event-stream` (SSE), stateless (no session id), server `freddy 0.2.0`, 9 tools, 81 metrics. CORS preflight allows origin `*` and headers `content-type, authorization, mcp-session-id` only. The official MCP SDK also sends `mcp-protocol-version`, which a WebView would block, so `src/sources/mcpHttp.ts` is a minimal client that sends only the allowed headers.
- **Real sync from a PC (25 Oct 2026):** 260 samples, 38 metrics, 7 local days; a second sync adds no rows.
- Native HTTP is the default on the phone, so CORS does not apply there. Still unverified: whether WebView `fetch` would also work (selectable in Settings to test once).

## 5. Claude integration (phase 1, not built yet)

- The app calls the Anthropic API directly with the user's own key (acceptable for personal use; not for a public release).
- Tools exposed to Claude are aggregate queries over local SQLite, for example `sleep_summary(range)`, `trend(metric, range)`, `compare_periods`.
- Send aggregates by default. Ask the user before sending raw time series or notes. Consent is stored per scope in `consents`.
- Every piece of data sent is logged in `ai_disclosures` and shown in a "what was sent to Claude" panel.
- Use native HTTP for the API call. Chat needs network; the rest of the app works offline.
- Present output as insights, not diagnosis.
- Privacy: health data is special-category data under GDPR. Sending it to an API needs explicit, granular consent.

The tables for this already exist (`chat_conversations`, `chat_messages`, `ai_disclosures`, `consents`), see [LLD.md section 4](LLD.md#4-schema).

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
| Official MCP SDK in the WebView | Sends a header freddy's CORS policy does not allow. |
| Direct HealthKit / Health Connect plugins | freddy's apps already cover them. Kept only as a fallback. |
| Direct Garmin Health API | Partner-gated, and public access reported closed. |
| Unofficial Garmin scrapers | Fragile, risk of account bans, poor base for a health product. |
| PWA as the mobile shell | Browser storage eviction risk for the only offline copy. |
| SQLite on the server | Two SQL dialects to maintain. Postgres everywhere on the server. |
| CRDTs | Overkill for append-only health data plus small user tables. |
| Neon Realtime | Neon Postgres only; no SQLite client. |

## 8. Open question for the owner

Which 2-3 screens will be opened every day (for example today's sleep and recovery, a weekly trend, a food and alcohol log, a Claude chat)? The schema already covers all of these, so the answer decides what to build next, not what to store. Also still unanswered: which differentiator justifies the app, given that Claude plus the freddy connector already lets you ask questions about your data (candidates: own long-term history, dashboards, derived metrics, manual logs, proactive alerts).

## 9. Next steps

1. **Run on the S23** (needs Android Studio): `npm run android:sync`, `npx cap open android`. Check that the DB opens encrypted and migrates, that a native-HTTP sync works, and that backup export/share/restore works. Then try the "WebView fetch" transport once.
2. Answer the open question in section 8, then build those screens on the existing schema.
3. Claude chat (section 5).
4. Decide on freddy FREE vs Pro (risk 6).
