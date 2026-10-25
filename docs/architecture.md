# Health App: Architecture Decisions

Status as of 24 Oct 2026. This file records the current decisions, not the discussion history. When a decision changes, edit it here and note the date.

## 1. Product summary

A personal health app, Android first, iPhone second. It pulls wearable and health data through freddy, stores it locally on the phone, shows dashboards and trends, and lets the user ask Claude questions about their own data. Web and server come later.

**Phase 1 (now):** phone-only. Everything is local.
**Phase 2 (later):** server with Postgres, sync, and a web app.

## 2. Decisions (phase 1)

| Area | Decision | Status |
|---|---|---|
| Language | TypeScript everywhere. No Rust. | Decided |
| UI | React + Vite | Decided |
| Mobile shell | Capacitor (Android first, iOS from the same code) | Decided |
| Local database | SQLite via `@capacitor-community/sqlite`, encrypted with SQLCipher | Decided |
| Query layer | Drizzle (sqlite-proxy driver). Fallback: typed raw SQL + Zod | Test early |
| Data source | freddy as the single intermediary, via its Personal REST API (bearer key), behind a `FreddySource` adapter | Decided; key + plan still to confirm (section 4) |
| Apple Health / Health Connect | Handled by freddy's own mobile apps. No native health code in our app. | Decided |
| Garmin | Via freddy only. No direct Garmin integration. | Decided |
| Claude integration | Called directly from the app with a user-supplied API key; tool-use loop runs locally against SQLite | Decided |
| Secrets | API key and DB encryption key in Android Keystore (secure-storage plugin) | Decided |
| Backups | Automatic Google backup disabled for the DB; manual encrypted export/restore | Decided |

### Why these choices
- **TypeScript, no Rust:** a solo project at personal scale (a few million rows a year). One language, and the official Anthropic and MCP SDKs are first-class in TypeScript.
- **Capacitor, not a PWA:** the only copy of offline data must not live in browser storage that can be evicted. Capacitor gives native SQLite, background sync and push.
- **freddy, not direct integrations:** HealthKit needs native iOS code, and Garmin's API is partner-gated (new public access was reported closed as of Sept 2026; verify on Garmin's portal). freddy covers Apple Health, Health Connect and Garmin.

## 3. Local schema rules (so phase 2 is cheap)

- Primary keys: UUIDv7 as text. Never auto-increment.
- Timestamps: UTC epoch milliseconds, plus an offset-minutes column.
- Every user-authored table has `updated_at`, `deleted_at` (soft delete) and `origin_device_id`.
- Health samples carry `source`, `device`, `external_id`, with a unique constraint on (source, device, metric, external_id) so re-syncs are idempotent.
- A `sync_state` table holds per-source cursors.
- Migrations are numbered SQL files, applied at startup using `PRAGMA user_version`.
- For daily totals, prefer freddy's `<metric>_total` "Merged" metrics. They are already de-duplicated across apps. Never add per-app rows together.

## 4. Open risks and spikes (do these first)

1. **[RESOLVED 25 Oct 2026] Can a third-party phone app read from freddy?** Yes. freddy has a documented read-only REST API ("Personal API", v1.2.0), so the app does not need MCP.
   - Base URL `https://freddy.coach/api/v1/`, auth `Authorization: Bearer fk_live_...`. Keys are created in the freddy dashboard (AI apps -> API keys); the secret is shown once. Up to 10 active keys.
   - Endpoints (all GET): `/metrics` (filters `metric`, `provider`, `device`, `source_id`, `from`, `to`, `limit` up to 1000, cursor paging via `next_cursor`, optional `include_raw`), `/catalog`, `/sources`, `/profile`. Spec: `https://freddy.coach/api/openapi.json`.
   - Record fields: `date`, `timestamp` (UTC), `provider`, `source`, `metric`, `device`, `deviceLabel`, `sourceId`, `numValue`, `textValue`, `unit`, `stream`, plus `raw`/`rawStatus` with `include_raw=true`. One provider record can span several rows: join on (`provider`, `sourceId`). Use `device` (stable), never `deviceLabel`, for filtering.
   - Limits: 120 req/min per key (per freddy's API page), 30 `include_raw` req/min per account, raw pages capped at 50 rows / about 8 MB. Results are newest first and bounded by the plan's history window.
   - Terms: freddy's terms do not mention API use or apps built on the data. They forbid sharing your MCP endpoint with third parties for data collection and accessing other users' data. Garmin rule: keep the `source` label (for example "Garmin Forerunner 245") when showing Garmin data. For anything beyond personal use, email freddy (contact in their terms) first.
   - API page says the API is included in the **Pro** plan and is in beta. Not yet verified that the FREE plan can create keys.
   - Not verified: CORS. Avoid the question by calling the API with native HTTP (Capacitor `CapacitorHttp`), not browser fetch.
   - Not tested live: we have no API key yet.
2. **[HIGH] The phone holds the only copy of user-authored data** (notes, goals, manual logs, settings). Health samples can be re-fetched from freddy. Mitigation: encrypted manual export/restore. Phase 2 sync removes the problem.
3. **[HIGH] Vendor dependency on freddy**, a small service. Keep the `Source` interface swappable and mirror data locally.
4. **[MEDIUM] Drizzle with Capacitor SQLite** needs glue code. Test it in the first spike.
5. **[MEDIUM] Android background sync is unreliable** (Doze, battery optimization). Main path: sync on app open and pull-to-refresh. Periodic background sync is a bonus. Backfill history in windowed calls with a progress indicator.

6. **[HIGH] Free-plan history window.** The owner's freddy account is on FREE: 7 days of history, 1 connected source, Garmin the only queryable provider. Anything older than 7 days cannot be fetched, so the local mirror only keeps what it has synced. Sync at least every few days and build the first sync soon. Health Connect (the Android phone's own data, including any nutrition or hydration entries) is connected in freddy but **paused** because of the 1-source limit, so it is not flowing in. Decide: upgrade, or choose which source to keep.

## 4b. Decision 25 Oct 2026: stay on the FREE plan and read freddy through MCP

The Personal REST API needs freddy Pro. For now the app talks to freddy's MCP endpoint (the personal URL, plus a key if the probe shows it is needed).
- The MCP tools return **text**, not JSON. `src/sources/freddyText.ts` parses it; unknown lines are reported, not dropped. Formats are pinned by tests in `tests/fixtures.ts`.
- `FreddySource` talks to a small `ToolCaller` interface, so the transport can change (MCP now, REST later) without touching the sync logic.
- Free-plan limits still apply: 7-day window, 1 source (Garmin). The first sync window is 7 days; a cursor older than the window produces a "Gap" warning.
- The MCP URL and key are secrets: stored on the device (Keystore), never in the repo. Rotate them if they are ever pasted anywhere.
- Terms: freddy forbids sharing the MCP endpoint with third parties for data collection. An app on the owner's own phone, using the owner's own endpoint, is not a third party, but it is not what the endpoint is documented for. Revisit before any public release.
- **Probe result (25 Oct 2026, real endpoint):** URL alone returns 401; the URL plus `Authorization: Bearer <key>` works. Replies are `text/event-stream` (SSE), stateless (no session id), server `freddy 0.2.0`, 9 tools, 81 metrics. CORS preflight allows origin `*` and headers `content-type, authorization, mcp-session-id` only. So the official MCP SDK (which also sends `mcp-protocol-version`) would be blocked in a WebView; `src/sources/mcpHttp.ts` is a minimal fetch client that sends only the allowed headers.
- Still unverified: the real POST response CORS headers from inside an Android WebView, and SSE handling there. Fallback if blocked: Capacitor native HTTP (bypasses CORS), then Pro + REST.

## 5. Claude integration (phase 1)

- The app calls the Anthropic API directly with the user's own key (acceptable for personal use; not for a public release).
- Tools exposed to Claude are aggregate queries over local SQLite, for example `sleep_summary(range)`, `trend(metric, range)`, `compare_periods`.
- Send aggregates by default. Ask the user before sending raw time series.
- Show a "what was sent to Claude" panel.
- Use native HTTP for the API call. Chat needs network; the rest of the app works offline.
- Present output as insights, not diagnosis.
- Privacy note: health data is special-category data under GDPR. Sending it to an API needs explicit, granular user consent.

## 6. Phase 2 parking lot (noted, not built)

- **Server:** Node + TypeScript API (Fastify or Hono), Postgres in Docker, same setup in dev and production. No SQLite on the server.
- **Sync:** health samples are append-only and one-directional, so use a simple cursor sync (server-assigned sequence number, client asks for everything after N). User-authored tables use last-write-wins per row. If multi-device editing becomes real, adopt PowerSync (syncs Postgres to client SQLite with a local-write upload queue). Verify its licensing and self-hosting terms first. Neon's realtime offering is limited to Neon Postgres, so it does not fit a SQLite client.
- **Web:** React build using SQLite WASM.
- **Claude:** move the API key behind a server proxy; add a remote MCP server (TypeScript SDK, OAuth) so Claude.ai can query derived data.
- **Postgres details:** plain Postgres with partitioned time-series tables. TimescaleDB only if needed. `pg_dump` backups to encrypted storage.

## 7. Rejected options and why

| Option | Reason rejected |
|---|---|
| Rust core (Tauri / UniFFI) | Not needed at this scale; slower for a solo developer. Rust works for backend, WASM and mobile via UniFFI, but React is the better UI layer. |
| Direct HealthKit / Health Connect plugins | freddy's apps already cover them. Kept only as the fallback in section 4. |
| Direct Garmin Health API | Partner-gated, and public access reported closed. |
| Unofficial Garmin scrapers | Fragile, risk of account bans, poor base for a health product. |
| PWA as the mobile shell | Browser storage eviction risk for the only offline copy. |
| SQLite on the server | Two SQL dialects to maintain. Postgres everywhere on the server. |
| CRDTs | Overkill for append-only health data plus small user tables. |
| Neon Realtime | Neon Postgres only; no SQLite client. |

## 8. Open question for the owner

Which 2–3 screens will be opened every day (for example today's sleep and recovery, a weekly trend, a Claude chat)? The schema and sync scope should come from that, so that only the needed metrics are modeled. Also still unanswered: which differentiator justifies the app, given that Claude plus the freddy connector already lets you ask questions about your data (own history, dashboards, derived metrics, manual logs, proactive alerts).

## 9. Next steps

1. ~~freddy spike~~ done: REST API exists. Next: get an API key, call `/profile` and `/catalog`, confirm what the FREE plan allows.
2. Answer the open question in section 8.
3. Draft the local schema from the daily screens.
4. Scaffold Capacitor + React + SQLite + migrations, and test Drizzle.
