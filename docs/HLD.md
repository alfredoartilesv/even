# Health App: High-Level Design (HLD)

Status as of 25 Oct 2026, phase 1. This document shows the system as a whole: its context, its main components, how data flows between them, and the security and quality properties it is built to have. The reasons behind each choice are in [architecture.md](architecture.md); module-level detail is in [LLD.md](LLD.md).

## 1. Goals and scope

**Goals (phase 1)**
- Mirror the owner's wearable data (Garmin today, via freddy) into a local, encrypted database on their phone, and keep it beyond freddy's 7-day free-plan window.
- Show daily values and trends, and record what wearables do not capture: food, alcohol, manual measurements, daily notes, goals.
- Later in phase 1: let the owner ask Claude about their data, with consent and a record of what was sent.

**Non-goals (phase 1)**
- No server, no account, no multi-user support.
- No direct integration with Garmin, HealthKit or Health Connect (freddy does that).
- No medical diagnosis.

**Constraints**
- One developer, personal scale (a few million rows a year at most).
- freddy FREE plan: 7 days of history, 1 source, text-only MCP tools.
- Health data is GDPR special-category data.

## 2. System context

```mermaid
flowchart LR
  owner([Owner])
  subgraph phone[Owner's phone]
    app[Health app<br/>Capacitor + React]
    db[(Encrypted SQLite<br/>SQLCipher)]
    ks[[Keystore / Keychain]]
  end
  garmin[Garmin Connect]
  hc[Health Connect / Apple Health]
  freddy[freddy<br/>health data hub]
  claude[Anthropic API<br/>Claude]
  share[Drive, email, Files<br/>via share sheet]

  owner -- uses --> app
  app --- db
  app --- ks
  garmin -- wearable data --> freddy
  hc -. paused on FREE plan .-> freddy
  app -- "MCP over HTTPS (read only)" --> freddy
  app -. "later: aggregates, with consent" .-> claude
  app -- "encrypted backup file" --> share
```

| External system | Role | Direction | Data |
|---|---|---|---|
| freddy | Single source of wearable data | App reads | Daily metrics as text through MCP tools (`list_metrics`, `query_metrics`) |
| Anthropic API | Answers questions (not built yet) | App sends, receives | Aggregates by default; raw series and notes only with consent |
| Share targets | Where the owner keeps backups | App sends | One password-encrypted file |

## 3. Components

```mermaid
flowchart TB
  subgraph ui[UI layer - React]
    appShell[App shell<br/>App.tsx]
    today[Today screen]
    settings[Settings screen]
  end
  subgraph core[Core - plain TypeScript, no Capacitor imports]
    sync[Sync orchestrator<br/>runSync]
    source[FreddySource<br/>+ text parsers]
    mcp[MCP HTTP client<br/>McpHttpCaller]
    backup[Backup / restore]
    repo[Data access<br/>samples, catalog, settings, queries]
    migrate[Migration runner]
    secretsApi[Secrets API<br/>SecretStore]
  end
  subgraph platform[Platform adapters - Capacitor]
    driver[SqlDriver on<br/>capacitor-community/sqlite]
    nativeHttp[Native HTTP<br/>CapacitorHttp]
    secure[Secure storage<br/>Keystore / Keychain]
    files[Filesystem + Share]
  end

  appShell --> today & settings
  appShell --> sync
  today --> repo
  settings --> backup & secretsApi & repo
  sync --> source --> mcp --> nativeHttp
  sync --> repo
  backup --> repo
  repo --> driver
  migrate --> driver
  secretsApi --> secure
  settings --> files
```

| Component | Responsibility | Main files |
|---|---|---|
| App shell | Opens the DB, runs migrations, triggers sync on launch, switches screens | `src/App.tsx`, `src/db/open.ts` |
| Today screen | Last sync status, warnings, the latest day's values | `src/screens/TodayScreen.tsx` |
| Settings screen | freddy credentials and transport, backup export and restore | `src/screens/SettingsScreen.tsx` |
| Sync orchestrator | One sync of one source: fetch, store, move the cursor, log the attempt | `src/sync/runSync.ts` |
| FreddySource | Decides the date window, discovers metrics, calls tools, parses text into samples | `src/sources/freddy.ts`, `src/sources/freddyText.ts` |
| MCP HTTP client | JSON-RPC over HTTP with SSE replies, only CORS-safe headers, no secrets in errors | `src/sources/mcpHttp.ts` |
| Native HTTP adapter | `fetch` look-alike over `CapacitorHttp` | `src/sources/nativeFetch.ts` |
| Data access | Upserts, catalog, settings, day queries | `src/db/*.ts` |
| Migration runner | Applies numbered SQL files, versioned in `PRAGMA user_version` | `src/db/migrate.ts`, `src/db/migrations/` |
| SqlDriver (Capacitor) | Adapts the SQLite plugin to a 3-method interface and hides its quirks | `src/db/capacitorDriver.ts` |
| Backup | Export every table to an encrypted file; restore by merging | `src/backup/` |
| Secrets | freddy URL and key, later the Claude key | `src/settings/` |

**Design principle:** everything in "Core" depends only on interfaces (`SqlDriver`, `Source`, `ToolCaller`, `SecretStore`, a `fetch` function). Only the platform adapters import Capacitor. That is why the whole core runs in Node tests and in PC scripts (`scripts/freddy-sync.ts`) without a phone.

## 4. Main flows

### 4.1 App start

```mermaid
sequenceDiagram
  participant UI as App shell
  participant Open as openDatabase
  participant SQL as SQLite plugin
  participant M as migrate
  UI->>Open: openDatabase()
  Open->>SQL: secret stored? if not, store a random passphrase
  Open->>SQL: create or reuse connection (encrypted, mode "secret")
  Open->>SQL: open
  Open->>M: migrate(db, migrations)
  M->>SQL: PRAGMA user_version, then each pending file in its own transaction
  Open-->>UI: db ready
  UI->>UI: auto sync if freddy credentials exist
```

The browser build (`npm run dev`) stops at the first step: the local database exists only in the native app.

### 4.2 Sync

```mermaid
sequenceDiagram
  participant UI as App / Sync now
  participant S as runSync
  participant F as FreddySource
  participant H as McpHttpCaller
  participant Fr as freddy
  participant DB as SQLite
  UI->>S: runSync(db, source)
  S->>DB: load cursor, insert sync_runs (running)
  S->>F: fetchSince(cursor)
  F->>H: list_metrics
  H->>Fr: POST initialize, tools/call
  Fr-->>H: SSE text
  F->>H: query_metrics(start..today, up to 50 metrics per call)
  H-->>F: text
  F-->>S: samples, catalog, next cursor (yesterday), warnings
  S->>DB: upsert samples (one transaction), upsert catalog, save cursor
  S->>DB: sync_runs = ok (or error, cursor unchanged)
  S-->>UI: outcome
```

Key properties:
- **Idempotent:** samples are keyed by (source, device, metric, external_id), so re-reading a day updates rows in place.
- **Self-healing window:** the next cursor is yesterday, because today (and sometimes yesterday) are incomplete when read.
- **Visible gaps:** if the last cursor is older than the plan's window, a "Gap" warning names the days that could not be fetched.
- **Never throws to the UI:** failures are stored in `sync_runs` and `sync_state.last_error`; concurrent triggers share one run.

### 4.3 Backup and restore

```mermaid
flowchart LR
  subgraph export[Export]
    t[All tables] --> j[JSON] --> z[gzip] --> e[AES-256-GCM<br/>key = PBKDF2 of password] --> f[backup file] --> sh[Share sheet]
  end
  subgraph restore[Restore]
    f2[backup file] --> d[decrypt + verify] --> u[gunzip + validate] --> m[merge into DB<br/>one transaction,<br/>newest updated_at wins]
  end
```

### 4.4 Claude chat (planned)

The app sends the question plus tool definitions to the Anthropic API. Claude asks for tools such as `trend(metric, range)`. The app runs them locally as SQL, checks consent for the data class, logs the payload in `ai_disclosures`, and returns the result. Messages are stored verbatim in `chat_messages`.

## 5. Data

One local SQLite database (`health`), encrypted with SQLCipher. Main groups:

| Group | Tables | Written by |
|---|---|---|
| Synced data | `health_samples`, `metric_catalog`, `sync_state`, `sync_runs` | Sync |
| Logs written by the owner | `food_entries`, `drink_entries`, `manual_measurements`, `day_notes`, `goals` | UI (screens not built yet) |
| Claude | `chat_conversations`, `chat_messages`, `ai_disclosures`, `consents` | Chat (not built yet) |
| Settings | `app_settings` (non-secret) | UI |
| Read models | Views `daily_metric_values`, `daily_nutrition`, `daily_alcohol` | Derived |

Full columns and constraints: [LLD.md section 4](LLD.md#4-schema).

## 6. Security and privacy

| Asset | Protection |
|---|---|
| Database at rest | SQLCipher. Random 32-byte passphrase per install, kept by the SQLite plugin in Keystore-backed storage (Android) / Keychain (iOS) |
| freddy URL and key, future Claude key | Keystore / Keychain via secure storage. Never in SQLite, so never in a backup. Memory only in the browser build |
| Data in transit | HTTPS only (the URL validator rejects `http://`) |
| Backup files | AES-256-GCM with a key derived from the owner's password (PBKDF2-SHA256, 600k iterations). The header is authenticated, so any edit makes the file unreadable |
| OS backups | Android auto-backup, adb backup and device-to-device transfer disabled |
| Logs and errors | Network errors never include the URL or key. Scripts print counts, not health values |
| Data sent to Claude (planned) | Explicit consent per scope, aggregates by default, every payload logged and visible |

Threats not covered in phase 1: a rooted or unlocked phone in an attacker's hands while the app is open, and a weak backup password chosen by the owner (minimum length 8 is enforced).

## 7. Deployment

| Target | How | Status |
|---|---|---|
| Android (S23) | `npm run android:sync` (build, `cap sync`, hardening script), then build and run from Android Studio | Not yet run on the device |
| iOS (iPhone 14) | Same code; `npx cap add ios` on a Mac | Not started |
| Browser | `npm run dev`, UI only, no database | Development aid |
| PC scripts | `scripts/freddy-sync.ts` (real freddy -> SQLite file), `scripts/freddy-probe.mjs` | In use |

Native projects are generated and git-ignored; the repo holds only the web code, the Capacitor config and the patch scripts.

## 8. Quality attributes

| Attribute | How it is met |
|---|---|
| Offline first | Everything except sync and chat works without network |
| Data durability | Idempotent upserts; one transaction per migration, per sync batch and per restore; encrypted backups |
| Testability | Core depends on interfaces; 78 Node tests, including a fake of the Android plugin's statement splitting and transactions |
| Replaceable source | `Source` and `ToolCaller` interfaces; MCP today, REST later, others possible |
| Phase 2 readiness | UUIDv7 keys, `updated_at` / `deleted_at` / `origin_device_id` on user tables, append-only samples |
| Performance | Personal scale. Indexed by (metric, local_day). Restore inserts in multi-row batches to limit bridge calls |

## 9. Phase 2 outlook

A Node + Postgres server would receive samples by cursor sync and user tables by last-write-wins on `updated_at`; a web app would read the same API. The Claude key would move behind a server proxy. None of this changes the phone schema rules. See [architecture.md section 6](architecture.md#6-phase-2-parking-lot-noted-not-built).
