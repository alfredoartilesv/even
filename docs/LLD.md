# Health App: Low-Level Design (LLD)

Status as of 26 Oct 2026, phase 1, schema version 7. This document describes the code: modules, interfaces, the full schema, the algorithms and file formats, error handling and tests. It assumes you have read [HLD.md](HLD.md). Reasons for decisions are in [architecture.md](architecture.md).

## 1. Repository layout

The tree follows the three layers in [HLD section 3](HLD.md#3-components): UI, core logic and platform adapters. Logic is grouped by feature; anything shared sits in a layer below.

```
src/
  main.tsx                         entry: initLogging(), render <App />
  app/                             UI shell (the composition root)
    App.tsx                        DB open, stored log level, auto sync, tabs
    logging.ts                     default level (debug in dev, info built), uncaught-error hooks
    styles.css
  core/                            pure helpers, no app or platform imports
    log.ts                         createLogger, levels, sinks, redaction, recentLogs ring buffer
    health.ts                      health maths (BMR/TDEE, BMI, macros, alcohol, HR zones, series stats)
    tz.ts, uuidv7.ts               timezone helpers (Intl), UUIDv7
    secretStore.ts                 SecretStore interface + memory store
    notifier.ts                    Notifier interface (local notifications) + no-op
  db/                              storage plumbing, no feature logic
    driver.ts                      SqlDriver interface
    tx.ts                          withTransaction (nests by joining the outer transaction)
    migrate.ts, migrations.ts      runner and the Vite import of migrations/*.sql
    migrations/0001..0006_*.sql    schema (section 4)
    settings.ts                    app_settings get/set, deviceId
  platform/                        the only code that imports Capacitor plugins at runtime
    openDatabase.ts                encryption secret, connection, migrate
    sqlite.ts                      SqlDriver on @capacitor-community/sqlite
    secureStore.ts                 Keystore/Keychain SecretStore
    nativeFetch.ts                 fetch look-alike over CapacitorHttp (request injected)
    device.ts                      isNative, nativeRequest, deviceFetch, shareText
    notifications.ts               Notifier on @capacitor/local-notifications (no-op in the browser)
    files.ts                       backup file to the share sheet / download
  ui/                              the UI kit: presentational components, plain props in, callbacks out (section 8b)
    common.tsx                     shared screen helpers: Msg, failed(), dates, TagChips
    charts/                        LineChart, BarChart, CalendarHeatmap, StatTile, Sparkline, Meter, StackedBar; scale.ts (pure)
    mealprep/                      StockSummary, DefrostTimeline, StockAlerts, BatchBar; timeline.ts (pure)
    nutrition.tsx, controls.tsx    CalorieMeter, MacroSplit; RangePicker, Stepper, StatusBadge
    ui.css                         kit styles and chart color tokens (light and dark)
  features/<name>/                 logic (*.ts), data access and screens (*.tsx or ui/)
    metrics/                       samples, catalog, queries, TodayScreen
    sync/                          runSync, freddyClient, FreddySource, text parsers, MCP client, Source types
    food/                          food log, saved meals, photos, calorie goal, suggestions; ui/ Calories, History, Saved
    mealprep/                      recipes, batches, stock fold and defrost plan, shopping list; ui/ Stock, Recipes, Shopping
    alcohol/                       drink types, drink log, totals in kcal and money, weight without alcohol; ui/ Alcohol view
    journal/                       manual measurements, day notes, goals
    chat/                          engine, read tools, write tools (actions), consent, store, prompt, client, service
    backup/                        exportBackup, restoreBackup, BACKUP_TABLES
    settings/                      secrets, log level, SettingsScreen, LogsPanel
tests/                             node:test suites, fixtures, fakes; setup.ts silences logs
scripts/                           probe, PC sync, PC chat, Drizzle spike, Android hardening
docs/                              this documentation
capacitor.config.json              app id, SQLite encryption settings
```

Dependency rules, enforced by `tests/architecture.test.ts`:

| Layer | May import |
|---|---|
| `core/` | `core/` |
| `db/` | `db/`, `core/` |
| `platform/` | `platform/`, `db/`, `core/`, Capacitor plugins |
| `ui/` | `ui/`, `core/` |
| `features/` | other features, `ui/`, `platform/`, `db/`, `core/` |
| `app/` | everything |

On top of that, feature logic (`*.ts` outside a `ui/` folder) never imports a screen and never reaches a Capacitor plugin at runtime, not even through another module (the test follows the import graph; `import type` is allowed). That is what keeps all logic runnable in Node tests and PC scripts. Platform pieces reach the logic as parameters: `freddySource(creds, transport, nativeRequest)`, `chatDeps(db, { secrets, fetch })`.

## 2. Core interfaces

```ts
// src/db/driver.ts
type SqlValue = string | number | null;
interface SqlDriver {
  exec(sql: string): Promise<void>;                                   // no params, no result, may be several statements
  run(sql: string, params?: SqlValue[]): Promise<void>;                // one parameterised statement
  all<T>(sql: string, params?: SqlValue[]): Promise<T[]>;             // rows as objects keyed by column name
}

// src/features/sync/types.ts
interface Source {
  readonly id: string;                                                 // "freddy"
  fetchSince(cursor: string | null): Promise<SyncResult>;
}
interface SyncResult {
  samples: SampleInput[];
  catalog?: CatalogEntry[];                                            // when the source listed its metrics
  nextCursor: string | null;                                           // opaque, stored in sync_state
  warnings?: string[];
}
interface SampleInput {
  source: string; device: string; externalId: string; metric: string;
  startMs: number; endMs?: number; offsetMin: number;
  valueNum?: number; valueText?: string; unit?: string; raw?: unknown;
}

// src/features/sync/freddy.ts
interface ToolCaller { callTool(name: string, args: Record<string, unknown>): Promise<string>; }

// src/features/settings/secrets.ts
interface SecretStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
}
```

Implementations:

| Interface | Phone | Tests / PC |
|---|---|---|
| `SqlDriver` | `capacitorDriver(conn)` | `memoryDriver()` on `node:sqlite` (`tests/helpers.ts`); `capacitorDriver(fakePlugin().conn)` (`tests/fakePlugin.ts`); file DB in `scripts/freddy-sync.ts` |
| `ToolCaller` | `McpHttpCaller` with native fetch | `McpHttpCaller` with a fake fetch; plain fake callers |
| `SecretStore` | `secretStore` (Keystore/Keychain) | `memorySecretStore()` (also used by the browser build) |

## 3. Database access

### 3.1 Opening (`src/platform/openDatabase.ts`)

1. Refuse on non-native platforms (`Capacitor.isNativePlatform()`), with the message the shell shows.
2. If `isSecretStored()` is false, `setEncryptionSecret(hex of 32 random bytes)`. The plugin keeps it in its secure store.
3. `checkConnectionsConsistency()` + `isConnection("health")`: reuse the native connection after a WebView reload, otherwise `createConnection("health", encrypted=true, mode="secret", version=1, readonly=false)`.
4. `open()` if not open. The plugin enables foreign keys on open.
5. `migrate(capacitorDriver(conn), migrations)`.

`openDatabase()` caches its in-flight promise, because React StrictMode runs effects twice and two concurrent `createConnection` calls for one name fail. A failed open is not cached, so it can be retried.

The plugin's own version system is not used: with `version=1` and no `addUpgradeStatement`, it never touches `PRAGMA user_version`, so `migrate()` owns it.

Config (`capacitor.config.json`): `androidIsEncryption: true`, `iosIsEncryption: true`, `iosKeychainPrefix: "app.health.personal"`, biometrics off.

### 3.2 Capacitor driver (`src/platform/sqlite.ts`)

It depends only on `PluginConnection = Pick<SQLiteDBConnection, "execute" | "run" | "query" | "beginTransaction" | "commitTransaction" | "rollbackTransaction">`.

| Plugin behaviour | What the driver does |
|---|---|
| `execute()` and `run()` wrap each call in their own transaction unless passed `false` | Always passes `transaction=false`. `exec("BEGIN" / "COMMIT" / "END" / "ROLLBACK" [TRANSACTION])` maps to `beginTransaction` / `commitTransaction` / `rollbackTransaction`, so callers control transactions as on any SQLite |
| Android `execute()` splits the script on `";\n"`, strips `--` comments line by line, and runs each piece as a single statement | Normalises `\r\n` and `\r` to `\n` first. Without that, a CRLF file becomes one piece and only its first statement runs, with no error |
| iOS `query()` may return a first row `{ ios_columns: [...] }` | Drops it |
| `run()` has a `returnMode` | Passes `"no"` |

Consequences for SQL written for this app: no semicolons inside comments in multi-statement scripts, no `--` inside string literals in migration files, and no triggers (the plugin's trigger handling is not tested).

### 3.3 Migrations (`src/db/migrate.ts`)

- Files: `src/db/migrations/NNNN_name.sql`, inlined by Vite (`import.meta.glob(..., { query: "?raw", eager: true })`), read from disk in tests and scripts.
- `parseMigrations(files)`: parses the version from the file name, sorts, rejects bad names and duplicate versions.
- `migrate(db, migrations)`: reads `PRAGMA user_version`; for each newer migration runs `BEGIN`, the file, `PRAGMA user_version = N`, `COMMIT`. On error: `ROLLBACK` and throw `Migration N_name failed: ...`. The DB stays at the last good version. Returns the versions applied.

### 3.4 Write helpers

| Function | SQL behaviour |
|---|---|
| `upsertSamples(db, samples, nowMs, newId)` | One transaction. `INSERT ... ON CONFLICT (source, device, metric, external_id) DO UPDATE` of times, values, unit, raw, `local_day`, `updated_at`. The `id` and `created_at` of an existing row are kept |
| `sampleLocalDay(s)` | `new Date(startMs + offsetMin * 60000).toISOString().slice(0, 10)`. Same rule as the SQL backfill in 0002 |
| `saveSyncState(db, source, cursor, nowMs, error)` | Upsert. On success sets `last_synced_ms`; on error keeps the previous `last_synced_ms` and stores `last_error` |
| `loadCursor(db, source)` | Cursor or `null` |
| `upsertCatalog(db, source, entries, nowMs)` | Insert with a guessed `category` and `daily_agg` (`classifyMetric`). On conflict refreshes only `unit`, `device` (when given), `first_day`, `last_day`, `records`, `updated_at` |
| `getSetting`, `setSetting`, `deviceId` | `app_settings` key/value. `deviceId` creates a UUIDv7 on first use |

`classifyMetric(name)` rules, first match wins: `sleep_*` -> sleep/last; `dailyBodyBattery_*` or contains `hrv` -> recovery/last; `stress_*` or contains `stress` -> stress/avg; contains `heartrate` or `pulseOx_*` -> heart/avg; `body_*`, `userMetrics_*` -> body/last; `nutrition_*`, `food_*`, `drink_*` -> nutrition/sum; `daily_*`, `activity_*`, contains `steps` -> activity/sum; otherwise other/avg.

### 3.5 Read helpers (`src/features/metrics/queries.ts`)

- `latestSampleDay(db)`: `MAX(local_day)` of `health_samples`.
- `dayValues(db, day)`: `daily_metric_values` left-joined with `metric_catalog`, ordered by pinned, `sort_order`, category, metric. Picks `avg_num` / `sum_num` / `min_num` / `max_num` / `last_num` according to `daily_agg` (default `avg`). Returns label (catalog label or metric name), device, unit, readings and the partial flag.

### 3.6 Logging (`src/core/log.ts`)

`createLogger(scope)` returns `debug / info / warn / error`, `time(msg, level?)` (logs `ms` when the returned function is called) and `child(sub)` (scope `parent.sub`). Levels: `debug < info < warn < error < silent`. `setLogLevel(level)` sets the global threshold and `setLogLevel(level, scope)` overrides it for a scope and its children (`sync` covers `sync.freddy`).

Records are `{ ts, level, scope, msg, fields }`. Every record goes to `consoleSink` (one line: `12:00:01.234 INFO  sync: sync finished {"samples":10,"ms":812}`) and to `recentLogs`, a 500-record ring buffer in memory that Settings > Logs shows. Nothing is written to disk. A sink that throws is ignored.

Fields are sanitised before any sink sees them: keys matching key, token, secret, password, passphrase, authorization, cookie or url become `[redacted]`; errors become `{ name, message }` (validation errors as `path: message` per issue); strings are cut at 200 characters, arrays over 20 items and objects deeper than 2 levels are summarised.

Level in force: `app/logging.ts` sets `debug` in `npm run dev` and `info` in the built app before React renders; once the DB is open, `applyStoredLogLevel` applies `app_settings` key `log.level` if set (changed in Settings, `saveLogLevel`). Tests run with `silent` (`tests/setup.ts`, `LOG_LEVEL=debug npm test` to see them); scripts use `LOG_LEVEL` or `info`.

What is logged, by scope:

| Scope | Events |
|---|---|
| `app` | start (level, native), database unavailable, uncaught errors and rejections, sync skipped |
| `db.open`, `db.migrate`, `db` | open time, first-launch secret, connection reuse; each migration applied (version, name, ms), failure; transaction rollback (debug) |
| `http.native` | each native request (method, status, ms; debug), failures (warn) |
| `sync`, `sync.freddy`, `sync.mcp` | start (cursor), finish (samples, catalog, warnings, cursor, ms), each warning, failure; window and chunks (debug); tool calls (tool, chars, ms; debug), HTTP errors and tool errors (warn) |
| `metrics` | samples upserted (count, ms), catalog refreshed (debug) |
| `backup` | export (tables, rows, bytes, ms), restore (rows, ms), every refusal and rollback |
| `chat`, `chat.actions`, `chat.store`, `chat.consent` | each request and reply (model, stop reason, tokens, tool uses, ms), fallback, refusal, request errors; each tool (name, data class, bytes, ms) and each blocked or failed tool; proposals (approved or not), recorded and undone agent actions; consents |
| `food`, `mealprep`, `mealprep.shopping`, `journal` | every write and delete, by id and kind (meal slot, move kind, portions, has photo), refusals at debug |
| `settings`, `settings.secrets` | log level changes; credentials saved or removed (never the values) |
| `ui.<feature>` | actions a screen reported as failed (info: usually input the core refused) |

Pure modules (`core/health.ts`, `tz.ts`, `stock.ts`, `suggest.ts`, the freddy text parsers) do not log: they have no side effects worth recording, and their callers log the outcome.

Privacy rule (architecture.md section 3): log what happened, not the data. Ids, counts, kinds, durations and statuses only; never health values, food or recipe names, notes, chat text, URLs or keys. `tests/logging.test.ts` runs real flows with recognisable values and fails if any reaches a record.

### 3.7 Transactions (`src/db/tx.ts`)

`withTransaction(db, fn)` wraps `fn` in `BEGIN` / `COMMIT` and rolls back on error. A call made inside another `withTransaction` on the same driver joins the outer transaction (SQLite cannot nest `BEGIN`), so for example a chat write tool can call `saveMealPrep` inside its own transaction and one failure undoes both. `migrate()` and `restoreBackup()` keep their own `BEGIN` because they wrap errors in their own messages.

### 3.8 Health calculations (`src/core/health.ts`)

Pure functions, no dependencies, shared by screens and (later) the chat tools. Inputs are validated: bad values throw `RangeError` with the field name.

| Area | Functions | Formula |
|---|---|---|
| Age | `ageOn(birthDay, day)` | whole years, birthday counts on the day |
| Body | `bmi`, `bmiClass`, `healthyWeightRange` | kg/m², WHO adult classes 18.5 / 25 / 30, range = BMI 18.5 to 24.9 |
| Energy | `bmr`, `tdee`, `calorieTarget`, `kgPerWeekFromBalance` | Mifflin-St Jeor; activity factors 1.2 / 1.375 / 1.55 / 1.725 / 1.9; 7700 kcal per kg; target rounded to 10 kcal and never below BMR (`floored` says so) |
| Nutrition | `kcalFromMacros`, `macroSplit`, `proteinTarget` | Atwater 4 / 4 / 9 / 7 kcal per g (protein, carbs, fat, alcohol); protein default 1.6 g/kg |
| Alcohol | `alcoholGrams`, `standardDrinks`, `alcoholKcal` | ml x ABV / 100 x 0.789 (same as `daily_alcohol`); standard drink 10 g (ES, EU), 8 g (UK), 14 g (US); kcal = grams x 7 (alcohol only, so sugary drinks are undercounted) |
| Weight | `weightWithoutKcal(kg, kcal)` | kg - kcal / 7700: the weight without those kcal if they were not made up for elsewhere (an upper bound) |
| Heart rate | `maxHeartRate`, `heartRateZones` | Tanaka 208 - 0.7 x age; five zones 50 to 100 % in 10 % steps, of the heart rate reserve (Karvonen) when a resting rate is given |
| Series | `mean`, `slopePerDay`, `rollingAverage`, `smoothed` | least squares over calendar days; trailing window by calendar days, gaps not counted as zero; exponential smoothing (alpha 0.1 default) |

The food log form uses `kcalFromMacros` to estimate kcal when only macros are typed, and History uses `mean`. The chat tools use `slopePerDay`, `alcoholGrams` and the energy functions from here.

## 4. Schema

Version 7 (`0001_init.sql` to `0007_account.sql`). Conventions: ids are UUIDv7 text; `*_ms` are UTC epoch ms; `offset_min` is minutes east of UTC; `local_day` is `YYYY-MM-DD`. "Std" below means the user-table columns `created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER, origin_device_id TEXT NOT NULL`.

```mermaid
erDiagram
  health_samples }o--|| metric_catalog : "source + metric (logical)"
  sync_state ||--o{ sync_runs : "source (logical)"
  chat_conversations ||--o{ chat_messages : conversation_id
  chat_conversations ||--o{ ai_disclosures : conversation_id
  chat_messages ||--o{ ai_disclosures : message_id
  goals }o..o| metric_catalog : "metric (logical)"
  meal_preps ||--o{ meal_prep_ingredients : meal_prep_id
  meal_preps ||--o{ meal_prep_tags : meal_prep_id
  meal_preps ||--o{ meal_prep_batches : meal_prep_id
  meal_prep_batches ||--o{ meal_prep_moves : batch_id
  meal_prep_moves |o--o| food_entries : food_entry_id
  meal_preps |o--o{ shopping_list_items : meal_prep_id
  saved_meals ||--o{ food_entries : saved_meal_id
  food_photos |o--o| saved_meals : photo_id
  chat_conversations ||--o{ agent_actions : conversation_id
  agent_actions }o..o{ food_entries : "rows_json (logical)"
```

Only the `chat_*`, `ai_disclosures` and `meal_prep_*` / `shopping_list_items` links are real foreign keys; the others are logical (matching values, no constraint).

### 4.1 Synced data

**`health_samples`**: one reading from a source.

| Column | Type | Notes |
|---|---|---|
| `id` | TEXT PK | UUIDv7 |
| `source` | TEXT NOT NULL | `freddy` |
| `device` | TEXT NOT NULL DEFAULT '' | freddy's source label, e.g. `Garmin` |
| `external_id` | TEXT NOT NULL | `<day>#<n>` for freddy (n = nth reading of that metric/label that day) |
| `metric` | TEXT NOT NULL | provider metric name, e.g. `daily_steps` |
| `start_ms`, `end_ms` | INTEGER | local day start and next day start, in UTC ms |
| `offset_min` | INTEGER NOT NULL DEFAULT 0 | |
| `value_num` / `value_text` | REAL / TEXT | `value_text` when the value is not `<number> [unit]` |
| `unit` | TEXT | as freddy prints it |
| `raw_json` | TEXT | `{"partial":true}` when the day was not over |
| `local_day` | TEXT | added in 0002, backfilled |
| `created_at`, `updated_at` | INTEGER NOT NULL | |

Unique (source, device, metric, external_id). Indexes: (metric, start_ms), (metric, local_day).

**`metric_catalog`**: PK (source, metric). Source facts: `unit`, `device`, `first_day`, `last_day`, `records`. User choices: `label`, `category` (sleep, recovery, activity, heart, stress, body, nutrition, other; default other), `daily_agg` (avg, sum, min, max, last; default avg), `higher_is_better` (0/1/NULL), `pinned` (0/1), `sort_order`. Plus `updated_at`.

**`sync_state`**: PK `source`; `cursor`, `last_synced_ms`, `last_error`, `updated_at`.

**`sync_runs`**: `id`, `source`, `started_ms`, `finished_ms`, `status` (running, ok, error), `cursor_before`, `cursor_after`, `samples_written`, `warnings_json` (JSON array or NULL), `error`. Index (source, started_ms).

### 4.2 Logs written by the owner

| Table | Columns besides Std | Constraints / indexes |
|---|---|---|
| `food_entries` | `id`, `eaten_at_ms`, `offset_min`, `local_day`, `name`, `meal`, `calories`, `protein_g`, `carbs_g`, `fat_g`, `notes` | `meal` in breakfast, lunch, dinner, snack, prep. Index on `eaten_at_ms` and on `local_day`, live rows only |
| `drink_entries` | `id`, `drunk_at_ms`, `offset_min`, `local_day`, `name`, `volume_ml` NOT NULL, `abv_percent` NOT NULL, `notes`; 0006: `drink_type_id` FK, `calories`, `price` (per drink, copied from the type when logged; NULL kcal = estimate) | Index on `drunk_at_ms`, `local_day` and `drink_type_id`, live rows only |
| `manual_measurements` | `id`, `measured_at_ms`, `offset_min`, `local_day` NOT NULL, `kind` NOT NULL, `value_num`, `value_num2`, `value_text`, `unit`, `notes` | `kind` free text (weight, blood_pressure, glucose, supplement, symptom...). `value_num2` = second number of a pair (diastolic). Index (kind, local_day), live rows |
| `day_notes` | `id`, `local_day` NOT NULL, `mood`, `energy`, `body` | `mood`, `energy` between 1 and 5. Unique `local_day` among live rows |
| `goals` | `id`, `title`, `target_kind`, `metric`, `comparator`, `target_num`, `unit`, `period`, `start_day` NOT NULL, `end_day`, `notes` | `target_kind` in sample, manual, food, drink, none. `comparator` in `>=`, `<=`. `period` in day, week, month (default day). CHECK: `target_kind = 'none'` or metric, comparator and target_num all set |

`local_day` on `food_entries` and `drink_entries` was added in 0002 (nullable, backfilled). Code that inserts these rows must set it; use `food.ts` for food and `logs.ts` for the other four.

0005 adds `created_by` (`user` or `assistant`, default `user`) to the five tables above and to `meal_preps`, `meal_prep_batches`, `saved_meals` and `shopping_list_items`: the rows the chat agent can create.

### 4.2b Meal prep (0003)

| Table | Columns besides Std | Constraints / indexes |
|---|---|---|
| `meal_preps` | `id`, `name`, `portions` (per batch, default 4), `fridge_days` (4), `freezer_days` (90), `thaw_hours` (24), `calories`, `protein_g`, `carbs_g`, `fat_g` (per portion), `notes` | counts > 0, `thaw_hours` >= 0 |
| `meal_prep_ingredients` | `id`, `meal_prep_id` FK, `sort_order`, `name`, `quantity`, `unit` | `quantity` NULL or > 0. Index (meal_prep_id), live |
| `meal_prep_tags` | `id`, `meal_prep_id` FK, `tag` | `tag` non-empty, already `lower(trim())`. Unique (meal_prep_id, tag) among live rows. Index (tag), live |
| `meal_prep_batches` | `id`, `meal_prep_id` FK, `cooked_at_ms`, `offset_min`, `local_day`, `portions`, `notes` | `portions` > 0. Index (meal_prep_id), live |
| `meal_prep_moves` | `id`, `batch_id` FK, `at_ms`, `offset_min`, `local_day`, `kind`, `from_loc`, `portions`, `food_entry_id` FK | `kind` in freeze (from fridge), thaw (from freezer), eat (from fridge), discard (either). Append only, undo = soft delete. Index (batch_id, at_ms), live |
| `shopping_list_items` | `id`, `name`, `quantity`, `unit`, `checked` (0/1), `meal_prep_id` FK (where it came from) | Index (checked, name), live |

Stock is never stored. `loadStock` reads live batches that still have portions (`portions` > eaten + discarded, in SQL) and `foldBatch` replays their moves: every portion starts in the fridge with eat-by `local_day + fridge_days`; freeze takes the fridge lot that goes off first and makes a freezer lot (best by `freeze day + freezer_days`); thaw takes the oldest freezer lot and makes a fridge lot ready at `at_ms + thaw_hours`, eat-by `thaw day + ceil(thaw_hours / 24) + fridge_days`; eat prefers lots already ready. `addMove` refuses more portions than the location holds; `undoMove` refuses when the remaining moves would overdraw (for example undoing a defrost whose portion was eaten). Eating writes a `food_entries` row (`meal = 'prep'`, macros x portions); undo and `deleteBatch` soft-delete it too. Deleting a recipe keeps its batches in stock.

`planDefrost` simulates the next 7 days at `portions_per_day` (setting `meal_prep.portions_per_day.<tag|all>`, default 1, minus portions eaten today): each day eats from ready fridge lots by eat-by, and covers any gap from the freezer lot with the earliest best-by, advising to start the defrost `ceil(thaw_hours / 24)` days earlier (`late` when that day is past). It also reports days nothing covers and fridge portions that will pass eat-by uneaten. `stockAlerts` lists expired, due today/tomorrow, still defrosting and past-best-by freezer lots.

Shopping: `addShoppingItem` merges into an open (unchecked) item with the same name (case-insensitive) and unit, after folding g/kg and ml/cl/dl/l into g and ml. `addRecipesToShopping` adds each recipe's ingredients x batches in one transaction.

### 4.2c Food log (0004)

| Table | Columns besides Std | Constraints |
|---|---|---|
| `food_photos` | `id`, `mime` (image/jpeg, image/webp), `data_b64`, `width`, `height`, `bytes` | The app sends at most 1024 px JPEG, re-encoded through a canvas (no EXIF). `food.ts` rejects non-base64 data and more than 1.5 MB |
| `saved_meals` | `id`, `name`, `meal` (usual slot), `calories`, `protein_g`, `carbs_g`, `fat_g` (per serving), `notes`, `photo_id` FK | Same `meal` values as `food_entries` |
| `food_entries` | + `saved_meal_id` FK | Index (saved_meal_id), live |

Photos are only kept with saved meals: logging with a photo bookmarks the meal. Use counts and "last eaten" are not stored, they come from the entries linked by `saved_meal_id`. `saveEntryAsMeal` also links earlier live entries with the same name (case-insensitive) that have no live saved meal. Deleting a saved meal soft-deletes it and its photo; its entries stay in the history, without a photo. Replacing a photo soft-deletes the old one.

The daily calorie target is a `goals` row (`target_kind = 'food'`, `metric = 'calories'`, `comparator = '<='`, `period = 'day'`, unit kcal). `setCalorieGoal` keeps one live row: a change on a later day sets `end_day` on the old one before soft-deleting it, a change on the same day replaces it.

`deleteFood` on an entry made by eating a meal prep portion calls `undoMove`, so the portion goes back into stock. `relogFood` copies an entry to now; a copied meal prep entry gets the slot for the hour instead of `prep` and does not touch stock.

`suggestions` offers saved meals plus anything else logged at least twice in the last 30 days (by lower-case name, `prep` excluded). `rankSuggestions` scores: uses in 30 days (capped at 10), +4 if its usual slot (most logged slot, else the saved slot) matches `mealForHour(now)` (5-10 breakfast, 11-15 lunch, 16-18 snack, otherwise dinner), +2 if saved, +1 if eaten in the last 3 days, -6 if already logged today.

### 4.2d Alcohol (0006)

| Table | Columns besides Std | Constraints |
|---|---|---|
| `drink_types` | `id`, `name`, `volume_ml` (one serving), `abv_percent`, `calories` and `price` (per serving, both optional), `created_by` | Unique `lower(name)` among live rows. `volume_ml` > 0, ABV 0 to 100, kcal and price >= 0 |

Prices are in the currency in `app_settings` key `currency` (ISO code, default EUR). Each drink stores its own kcal and price, so editing or deleting a type never rewrites history. `logDrink` takes a type (its values are defaults, any can be overridden) or a name, ml and ABV, and a count (1 to 20 rows). Totals come from `daily_alcohol`; kcal is the stored value or 7 kcal per gram of alcohol, and money only counts drinks with a price (`priced` says how many).

`latestWeight(db, day)` takes the newest of a manual `weight` measurement (unit kg, g or lb; kg if empty) and a synced `body_weightInGrams` sample, on or before the day. `weightWithoutAlcohol(db, from, to)` = that weight - drink kcal in the range / 7700.

### 4.3 Claude

| Table | Columns besides Std | Constraints |
|---|---|---|
| `chat_conversations` | `id`, `title`, `model` | Index on `updated_at`, live rows |
| `chat_messages` | `id`, `conversation_id` FK, `seq`, `role`, `content_json`, `model`, `stop_reason`, `input_tokens`, `output_tokens` | `role` in user, assistant. Unique (conversation_id, seq). `content_json` = the Anthropic content blocks array, verbatim |
| `ai_disclosures` | `id`, `conversation_id` FK, `message_id` FK, `sent_at_ms`, `tool_name`, `data_class`, `summary`, `payload_json`, `bytes` | `data_class` in aggregate, raw, note, photo (photo added in 0005 by rebuilding the table; rows kept). Index on `sent_at_ms` |
| `consents` | `id`, `scope`, `granted` (0/1), `decided_at_ms`, `policy_version` | Index (scope, decided_at_ms). Newest row per scope is in force |
| `agent_actions` (0005) | `id`, `conversation_id` FK, `tool_name`, `summary`, `input_json`, `status`, `rows_json`, `error`, `decided_at_ms` | `status` in applied, declined, failed, undone. `rows_json` = the effects to reverse (`{op, table, id}`, plus `before`/`after` for a shopping-list merge). Index (conversation_id, decided_at_ms) |

### 4.3b Account (0007)

**`account`**: at most one live row, `id = 'owner'` (CHECK). `provider` (`google`), `subject` (Google `sub`, non-empty), `email`, `email_verified` (0/1), `name`, `bound_at_ms`, `last_sign_in_ms`, `signed_in` (0/1, the local session) + Std. No token columns.

Code: `src/features/account/account.ts` (pure) and `service.ts`, platform wrapper `src/platform/googleSignIn.ts`.

| Function | Does |
|---|---|
| `parseGoogleIdToken(token, { webClientId, now })` | Decodes the JWT payload and checks `iss` (accounts.google.com), `aud` (= Web client id, string or array), `exp` (5 min skew) and `sub`. Signature not checked on the phone (architecture.md 5b). Messages safe to show |
| `applySignIn(db, identity, deviceId, now)` | No owner: insert (or re-bind a released row) -> `bound`; same `sub`: refresh email and name, `signed_in = 1` -> `signed_in`; other `sub`: no change -> `other_owner` with the owner's email |
| `signOut(db)` | `signed_in = 0`; binding kept |
| `releaseOwnership(db)` | Soft-deletes the row; the next sign-in binds. UI confirms first |
| `assertSameOwner(current, backupSubject, backupEmail)` | Used by `restoreBackup` before merging anything |
| `signInWithGoogle(db, { signIn, webClientId })` | Platform sign-in -> token -> checks -> `applySignIn`; also `cancelled` and `error` (plugin details are logged, not shown) |
| `signOutOfGoogle(db, { signOut })` | Local sign-out first, then the device's Google state (a plugin failure is only logged) |

`googleSignIn()` initializes `SocialLogin` once with `{ google: { webClientId, mode: "online" } }`, logs in with scopes `email`, `profile`, returns the ID token, or `null` on `USER_CANCELLED`. `googleSignInAvailable` is true only in the native app with `VITE_GOOGLE_WEB_CLIENT_ID` set at build time.

### 4.4 Settings

**`app_settings`**: PK `key`; `value`, `updated_at`. Keys in use: `device_id` (UUIDv7 of this install, never restored from a backup), `freddy.transport` (`native` or `fetch`), `sync.reminder` (`off` turns the 3-day reminder off; anything else, or unset, is on), `log.level`, `currency`, `meal_prep.portions_per_day.<tag|all>`.

### 4.5 Views

| View | Grain | Columns |
|---|---|---|
| `daily_metric_values` | metric, local_day, source, device (numeric samples with a `local_day`; a `garmin_export` row is left out when another source has the same metric on the same day, 0008) | `readings`, `avg_num`, `sum_num`, `min_num`, `max_num`, `last_num` (latest by `start_ms`, then `rowid`), `unit`, `partial` (1 if any row's `raw_json` has `"partial":true`) |
| `daily_nutrition` | local_day, live food rows | `entries`, `calories`, `protein_g`, `carbs_g`, `fat_g` |
| `daily_alcohol` | local_day, live drink rows | `drinks`, `volume_ml`, `alcohol_g` = sum(ml x ABV / 100 x 0.789), `calories` (stored, else alcohol_g x 7), `calories_estimated` (rows without a kcal), `price` (sum of known prices), `priced` (rows with a price). Rebuilt in 0006 |

## 5. freddy source

### 5.1 Window and cursor (`FreddySource.fetchSince`)

Options: `caller`, `timeZone` (default `Europe/Madrid`, replaced by the zone freddy reports), `windowDays` (default 7), `metrics` (default: discovered), `now`.

```
today       = local day of now() in the zone
windowStart = today - (windowDays - 1)
start       = windowStart
if cursor > windowStart: start = cursor
if cursor < windowStart: warn "Gap: ... <cursor+1> to <windowStart-1> could not be fetched"
names = opts.metrics ?? defaultMetricFilter(list_metrics)    (catalog returned only when discovered)
for each chunk of 50 names: query_metrics { metrics, start, end: today } -> parse
nextCursor = today - 1      (yesterday may have been incomplete)
```

`defaultMetricFilter` keeps names matching `^daily_`, `^dailyBodyBattery_`, `^sleep_`, `^pulseOx_`, `^stress_`, `^body_`, `^userMetrics_`, `^activity_`, and drops `^epoch_`, `^respiration_`, `^moveIQ_`, `_samples$` (high-volume or raw-only).

### 5.2 Text formats (`src/features/sync/freddyText.ts`)

`list_metrics` lines:
```
<name>: <n> records (<from> to <to>[, unit: <u>][, source: <s>][, device: "<d>"]) [optional bracket note]
```

`query_metrics` blocks:
```
Dates are local days in Europe/Madrid ...
2026-10-24:
  (possibly incomplete: ...)          -> following rows get raw {"partial":true}
  <metric>: <value> [unit] (<label>)  -> one sample
Note: ...                             -> collected in notes
```

A value that is `<number>` optionally followed by a unit made of letters, `_`, `%`, `/` becomes `value_num` + `unit`; anything else (for example `very stressful`, or `5 bpm at 07:30+01:00`) is kept whole in `value_text`. Indented lines that do not match are returned in `skipped`, and the source turns them into a warning. The fixtures in `tests/fixtures.ts` pin the formats seen on 25 Oct 2026.

### 5.3 MCP HTTP client (`src/features/sync/mcpHttp.ts`)

- First call: `initialize` (`protocolVersion: "2025-03-26"`, client info) then the `notifications/initialized` notification. The handshake promise is cached; on failure it is cleared so the next call retries.
- Each call: `POST url` with JSON-RPC 2.0, headers `content-type: application/json`, `accept: application/json, text/event-stream`, `authorization: Bearer <key>` if set, `mcp-session-id` if the server sent one. No other headers (freddy's CORS allows only these).
- Reply: plain JSON (object or batch) or SSE. For SSE, every `data:` line is parsed and the reply with the matching `id` is taken.
- `tools/call` result: `content[]` text blocks joined with newlines; `isError` -> `McpHttpError("freddy tool ... failed: <first 300 chars>")`.
- Errors (`McpHttpError`, with `status`): 401/403 -> "freddy rejected the credentials"; other non-2xx -> "freddy answered HTTP n"; network -> "Network error contacting freddy (<code>)"; unreadable or missing reply. No message ever contains the URL or the key.

### 5.4 Native HTTP adapter (`src/platform/nativeFetch.ts`)

`makeNativeFetch(request)` returns a `typeof fetch`:
- Headers are normalised through `Headers` (lower-case keys).
- A string body with a JSON content type is parsed back to an object, because `CapacitorHttp` serialises `data` itself and would otherwise send a quoted string.
- Always requests `responseType: "text"`. If the plugin still hands back parsed JSON, it is re-serialised.
- Returns a real `Response` (null body for 204, 205, 304).
- A rejected request becomes `TypeError("Native HTTP request failed", { cause })`, the same shape as a failed `fetch`.

`freddySource(creds, transport, nativeRequest)` (`src/features/sync/freddyClient.ts`) wires `McpHttpCaller` with the native adapter when the transport is `native`, otherwise with the WebView's `fetch`. `loadTransport` reads `freddy.transport`, defaulting to `native` on the phone and `fetch` in the browser.

## 5b. Garmin export import (`src/features/import/`)

`readGarminZip(bytes)` (fflate `unzipSync` with a filter) unpacks only the files `garminKind(path)` recognises, matched on their tail because some names start with the account email:

| Kind | File | Read as |
|---|---|---|
| daily | `DI-Connect-Aggregator/UDSFile_*.json` | One record per `calendarDate`. Offset = `wellnessStartTimeLocal - wellnessStartTimeGmt` (kept per day, reused for sleep, weight and VO2) |
| sleep | `DI-Connect-Wellness/*_sleepData.json` | One per night, stage seconds; total = deep + light + REM |
| biometrics | `DI-Connect-Wellness/*_userBioMetrics.json` | Weight rows only (grams). `sourceType = USER_SETTING` is the profile value: skipped. `calendarDate` here is a date-time |
| vo2max | `DI-Connect-Metrics/MetricsMaxMetData_*.json` | Per day and sport the latest `updateTimestamp` wins; also fitness age |
| activities | `DI-Connect-Fitness/*_summarizedActivities.json` | `distance`, `elevationGain` in **cm**, `duration`, `movingDuration` in **ms**; `avgSpeed` ((m/s)/10) not used. Start = `startTimeGmt`, offset = local - GMT |

`parseGarminExport(files, { timeZone })` returns samples (source `garmin_export`, device `Garmin`), catalog entries and a report per kind (files, records, imported, skipped, first/last day). Day metrics use `externalId = <day>#0` (weigh-ins `<day>#<sequence>`), activities `activity:<activityId>`. Each value is range-checked (steps 0–200k, heart rate 20–250, SpO2 50–100, stress and Body Battery 0–100, ...), so Garmin's -1/-2/null markers and impossible values are dropped. Metric names are freddy's for the same values (checked against freddy's list, 26 Oct 2026; 0008 renamed rows stored under the earlier names). Resting HR is `currentDayRestingHeartRate` (`restingHeartRate` is Garmin's 7-day average). Metrics: `daily_*` (steps, distance, kcal total/active/BMR, resting/min/max HR, moderate/vigorous/active/highly active durations, average/max stress, stress/rest durations), `dailyBodyBattery_*` (highest, lowest, charged, drained), `pulseOx_*`, `respiration_avgWakingBreathsPerMinute`, `sleep_*` (total, deep, light, REM, awake, SpO2, HR, respiration), `body_weightInGrams`, `userMetrics_vo2Max{Running,Walking,Cycling,}`, `userMetrics_fitnessAge`, `activity_*` (`activity_activityType` as text, duration, moving duration, distance, `activity_totalElevationGainInMeters`, kcal, average/max HR, steps, aerobic/anaerobic training effect, VO2 max). Not imported: names, locations, coordinates, hydration (only sweat estimates), nutrition (only goals), FIT files, routes, social, images, workouts, gear.

`storeGarminImport(db, parsed)` runs in one transaction: `upsertSamples` (idempotent), `upsertCatalog`, then `GARMIN_DAILY_AGG` defaults (max for training effect, VO2 and max HR/stress, min for min HR and lowest SpO2) only for catalog rows this import created, so the owner's later choices survive a re-import.

## 6. Sync orchestrator (`src/features/sync/runSync.ts`)

```
runSync(db, source, now):
  if a run for source.id is in flight: return the same promise
  cursorBefore = loadCursor
  INSERT sync_runs (running, cursor_before)
  try:
    res = source.fetchSince(cursorBefore)
    upsertSamples(res.samples)                 one transaction
    if res.catalog: upsertCatalog
    saveSyncState(nextCursor)
    UPDATE sync_runs ok, cursor_after, samples_written, warnings_json
    return { status: "ok", ... }
  catch err:
    saveSyncState(cursorBefore, error=message)  cursor does not move
    UPDATE sync_runs error
    return { status: "error", error, ... }      never throws
```

If samples were written but a later step failed, the next run rewrites them in place (upserts are idempotent).

`lastSync(db, source)` returns the newest run (status, times, count, warnings, error) plus `lastOkMs`, the latest successful finish, so the UI can show "last successful sync" even after a failure.

**When the app syncs** (`src/app/App.tsx`): on launch (after loading the status), with the header sync button on every tab, and when the app comes back to the front (`visibilitychange`) if the last success is more than an hour old (`RESYNC_ON_RESUME_MS`). `runSync` shares one run per source, so these never overlap.

**Staleness and the 3-day reminder** (`src/features/sync/reminder.ts`, pure apart from settings):
- `freshness(lastOkMs, now)`: `never`, `fresh`, or `stale` from 3 days (`STALE_AFTER_MS`) after the last success. Stale or a failed last attempt shows `SyncBanner` above every tab and turns the header button amber.
- `nextReminderAt(lastOkMs, now)`: last success + 3 days, or now + 1 day once that has passed (repeats daily until a sync succeeds). Never synced: now + 3 days.
- `reminderText`: "No freddy sync for N days", and how many days are left in freddy's 7-day free window.
- `refreshSyncReminder(db, notifier, { configured })` keeps exactly one pending notification (id `SYNC_REMINDER_ID` = 1001, replaced on every call): it cancels it when freddy is not set up or `sync.reminder` is `off`, asks for the notification permission otherwise (Android 13+ shows the prompt the first time), and schedules it. Called at start, after every sync attempt and after any settings change. It never throws; failures are logged as `sync.reminder` warnings.
- The `Notifier` interface is in `src/core/notifier.ts`; `src/platform/notifications.ts` implements it with `LocalNotifications.schedule({ at, allowWhileIdle: true })`, which Doze delivers close to the time. Tapping the notification opens the app, which syncs on launch.

## 7. Secrets and settings

| Key | Where | Written by |
|---|---|---|
| `freddy.mcp_url` | SecretStore | Settings. Must parse as a URL and use `https:` |
| `freddy.mcp_key` | SecretStore | Settings. Empty input keeps the stored key; "Forget" removes both |
| `anthropic.api_key` | SecretStore | `connectClaude` after the key is verified (shape check `normalizeClaudeKey`, must look like `sk-ant-...`) |
| `claude.verified_at`, `claude.key_hint`, `claude.problem` | `app_settings` | `connectClaude` (time, last 4 characters), `watchConnection` (problem when a request is rejected; cleared on the next success), `disconnectClaude` (all cleared). Never the key itself |
| `claude.effort` | `app_settings` | `saveEffort`; default `medium` |
| SQLCipher passphrase | SQLite plugin secure store | `openDatabase()` on first launch |
| `device_id`, `freddy.transport` | `app_settings` | `deviceId()`, Settings |

`secretStore` (`src/platform/secureStore.ts`) uses `SecureStorage.getItem/setItem/removeItem` on native platforms and `memorySecretStore()` in the browser, so secrets typed into the dev build are never written to `localStorage`.

## 8. UI

`App.tsx` state: `dbStatus` (opening, ready with `db`, error with message), `tab` (today, food, mealprep, settings), `configured`, `syncing`, `version` (incremented after each sync or settings change; screens reload on change), `autoSynced` ref (one automatic sync per launch).

- **Header** (every tab): `SyncButton` ("Synced 5 min ago", "Syncing…" with a spinner, amber when stale or failed; disabled until freddy is set up) and `SyncBanner` (3+ days without a sync, or the last attempt failed, with its error and a Sync now button).
- **TodayScreen**: `lastSync` + `latestSampleDay` + `dayValues`. Shows the last successful sync time, and the latest day's values with device and "day not over".
- **FoodScreen**: four views (the fourth, *Alcohol*, is described after this list). *Calories*: meter for today against the target (numbers in text, warning color plus the words "over target" when over), macros, set or change the target, "Eat again" suggestions (one tap logs, with Undo), "Log a meal" (name with saved-meal completion that fills the macros, slot chips defaulting to the hour, macros, notes, camera photo, save to favourites), and today's entries by slot. *History*: 7-day `BarChart` of calories with the target as a dashed line (tap a bar to open the day, the selected bar shows its value), weekly average and days over target, the day's entries, jump to the previous logged day. Entries everywhere have Eat again, ☆ Save, Edit and Delete. *Saved*: grid of saved meals with photo, kcal, slot, times eaten and last time; log with servings; edit (photo, name, slot, macros, notes) or remove.
- **AlcoholView** (Food > Alcohol): period chips (today, 7 days, 30 days, year); tiles for drinks (and standard drinks), kcal (flagged when some are estimated) and money (flagged when some drinks have no price); "Weight without alcohol" (expected weight, the difference, where the weight came from, and the caveat); one-tap logging from drink types (with Undo) and "Other…" (name, ml, ABV, kcal with an estimate placeholder, price, how many, save as a type); the period's drinks with delete; drink types with edit/remove; the currency. Drink kcal are also added to the Calories meter ("including N kcal from drinks") and to the History bars and averages.
- **MealPrepScreen**: tag filter chips shared by three views. *Stock*: totals (meals left, in the fridge, frozen), the defrost plan with a portions-a-day field, alerts, one card per batch with fridge and freezer lots and Eat / Freeze / Defrost / Toss / Undo / Delete for N portions, and "Log a cook" (portions made, straight to the freezer). *Recipes*: list with a batches count per recipe and "Add to shopping list"; editor for name, portions, shelf life, per-portion macros, tags (suggested breakfast, lunch, dinner, snack, or free text) and ingredients. *Shopping*: add item, tick, remove, clear ticked or all, share (phone) or copy (browser) the open items as text.
- **SettingsScreen**: freddy URL, key (password field) and transport; backup export (password twice, minimum 8) and restore (file input + password). Messages are shown inline; nothing throws to React.

Screens for the other logs, goals and chat are not built yet; their tables (and, for chat, the engine in `src/features/chat/`) exist.

## 8b. UI kit (`src/ui/`)

Presentational components shared by every screen. They take plain props and report through callbacks; they never load data, so they import only `ui/` and `core/` (enforced by `architecture.test.ts`). Where a component draws a feature's data it declares the fields it needs as its own type (`PlanLike` mirrors the defrost `Plan`), so the screen passes its object straight in.

| Component | Use |
|---|---|
| `LineChart` | Trend over days, one or more series on one axis. Missing days break the line. One series: accent color, 10% area wash, last value labelled. Several: categorical slots and a legend. Crosshair on hover and arrow keys reads every series at that day. Optional target line; `zero` for amounts |
| `BarChart` | Magnitude per day from a zero baseline, columns 24 px at most with a rounded end. Optional target; columns over it use the warning color and say "over target" (tooltip, table, legend). `onSelect` makes each column a button |
| `CalendarHeatmap` | A day grid (weeks by weekday) in five steps of the accent, for consistency over months or years. Missing days stay empty |
| `StatTile`, `Sparkline` | One number with an optional change against a named period (arrow and words; colored by whether that direction is good) and a small trend |
| `Meter`, `CalorieMeter` | A value against a limit; past it, the warning color plus the words |
| `StackedBar`, `MacroSplit`, `BatchBar` | Part-to-whole in one bar with 2 px gaps; the legend prints every value and share |
| `StockSummary`, `DefrostTimeline`, `StockAlerts` | Meal prep stock tiles, the next days (covered or short, what to defrost, what to eat or freeze), alerts with badges |
| `RangePicker`, `Stepper`, `StatusBadge` | Date-range presets above the charts they scope; − n + for portions; a state as icon plus words |

Rules every chart keeps: a `ChartFrame` with title, a legend only for two or more series, and a Table toggle showing every value as text; text in text colors, never the series color; color never the only signal; status colors only for state. Series colors are the validated categorical palette in `ui.css` (slots 1-8, fixed per series, checked for color-vision deficiency against both app surfaces); one-series charts use the accent. Charts measure their width and draw in real pixels, so text never scales.

`npm run dev` and open `/?gallery` to see every component with invented data (dev builds only, never in the production bundle).

## 9. Backup and restore

### 9.1 File format

```json
{
  "format": "health-app-backup",
  "version": 1,
  "kdf": { "name": "PBKDF2", "hash": "SHA-256", "iterations": 600000, "salt": "<base64, 16 bytes>" },
  "cipher": { "name": "AES-GCM", "iv": "<base64, 12 bytes>" },
  "data": "<base64 of AES-256-GCM ciphertext + tag>"
}
```

- Key: PBKDF2-SHA256 of the password with `salt` and `iterations` -> AES-GCM 256.
- Additional authenticated data: `JSON.stringify` of the envelope without `data`, in the field order above. Changing any header field makes decryption fail.
- Plaintext: gzip (`CompressionStream`) of the payload:

```json
{
  "format": "health-app-data",
  "schemaVersion": 2,
  "exportedAt": 1761400000000,
  "tables": { "<table>": { "columns": ["..."], "rows": [["..."]] } }
}
```

All of this is WebCrypto and Streams, available in the Android WebView, iOS WKWebView and Node, so the same code runs in tests.

### 9.2 Export (`exportBackup(db, password, { now, iterations })`)

- Password at least 8 characters, otherwise `BackupError`.
- For each table in `BACKUP_TABLES` that exists in this schema: columns from `PRAGMA table_info`, rows read in pages of 2000 ordered by `rowid`, stored as arrays in column order.
- Returns the file text and row counts per table. `src/platform/files.ts` writes it to the app cache and opens the share sheet (or downloads it in the browser). The file name is `health-backup-YYYY-MM-DD.json`.

### 9.3 Restore (`restoreBackup(db, text, password)`)

1. Parse and validate the envelope with Zod, else "This is not a Health backup file".
2. Derive the key, decrypt, gunzip, validate the payload. Any failure -> "Wrong password, or the file is damaged".
3. If the backup's schema version is newer than the database's -> refuse ("Update the app first"). Older backups are fine.
3b. If this phone has an owner and the backup's live `account` row names a different `subject` -> refuse ("This backup belongs to another Google account (email)"). A phone without an owner takes the backup's owner with the data.
4. `BEGIN`. For each table in `BACKUP_TABLES` order (parents before children), when present in the file:
   - keep only the columns that exist in this schema. This also means a column name from the file never reaches SQL unchecked. Table names come from `BACKUP_TABLES` only;
   - require the conflict-key columns;
   - for `app_settings`, skip `device_id`;
   - insert in multi-row batches of at most 900 parameters:
     - last-write-wins tables: `ON CONFLICT (<key>) DO UPDATE SET <non-key, non-id columns> WHERE excluded.updated_at > <table>.updated_at`;
     - `sync_runs`: `ON CONFLICT (id) DO NOTHING`.
5. `COMMIT`. Any error -> `ROLLBACK` and "Restore failed, nothing was changed: <cause>".

| Table | Conflict key | Merge |
|---|---|---|
| `app_settings` | key | newest wins (except `device_id`, skipped) |
| `sync_state` | source | newest wins |
| `metric_catalog` | source, metric | newest wins |
| `health_samples` | source, device, metric, external_id | newest wins; existing `id` kept |
| `food_entries`, `drink_entries`, `manual_measurements`, `day_notes`, `goals`, `chat_conversations`, `chat_messages`, `ai_disclosures`, `consents`, `meal_preps`, `meal_prep_ingredients`, `meal_prep_tags`, `meal_prep_batches`, `meal_prep_moves`, `shopping_list_items`, `food_photos`, `saved_meals` | id | newest wins |
| `sync_runs` | id | existing rows kept |

Known failure: a backup with a live `day_notes` row for a day that already has a live note under another id (or a live `meal_prep_tags` row duplicating a tag under another id) breaks the unique index, and the whole restore rolls back with that message.

## 9b. Claude chat agent

The chat is an agent: it reads the owner's data through local tools and, after the owner confirms each change, writes through the same functions the screens use (`food.ts`, `mealPrep.ts`, `shopping.ts`, `logs.ts`).

Files: `src/features/chat/engine.ts` (loop), `tools.ts` (read tools), `actions.ts` (write tools, action log, undo), `consent.ts`, `store.ts`, `prompt.ts` (system prompt, quick prompts), `images.ts` (attachment checks), `client.ts` (SDK, key verifier), `connect.ts` (Connect Claude flow), `service.ts` (phone wiring). No chat screen yet.

**Connecting.** There is no "Sign in with Claude" for a third-party Android app (architecture.md section 5), so the connect screen follows `CONNECT_STEPS`: open `CLAUDE_KEYS_URL` in the browser, create a personal key with an expiration, paste it. `connectClaude` checks its shape, verifies it with `claudeKeyVerifier` (`GET /v1/models/claude-opus-5-5` over the same native fetch as the chat: free, proves the key works and its workspace can use the model), and only then saves it. 401 → "rejected the API key", 404 → "workspace cannot use claude-opus-5-5", other errors as in 9b.6. `chatDeps` wraps the Messages call in `watchConnection`, so a 401/403 during chat sets `claude.problem` (status `needs_attention`, the screen asks to reconnect) and the next successful reply clears it.

### 9b.1 Entry points

```ts
// UI: get everything for this device (null = no Claude key stored yet)
const deps = await chatDeps(db, {
  askConsent: (scope, text) => showConsentDialog(text),        // a data class has no consent yet
  confirmAction: (p) => showConfirmSheet(p.summary, p.lines),   // every change the agent wants to save
});

startConversation(deps, question, { images })        // new conversation, titled from the question
askClaude(deps, conversationId, question, { images }) // follow-up; images optional (max 4, 5 MB each)
continueConversation(deps, conversationId)            // retry after a ChatApiError; the question is already stored
attachmentFromPhoto(await downscalePhoto(file))       // a photo from the app's picker as an attachment
QUICK_PROMPTS                                         // starters, each with the permission it needs
listConversations / loadMessages / renameConversation / deleteConversation (soft)
listDisclosures(db, conversationId?) / disclosurePayload(db, id)   // "What was sent to Claude"
listAgentActions(db, conversationId?) / undoAgentAction(db, id)    // "Assistant activity" + undo
consentStatus(db) / recordConsent(db, scope, granted, deviceId)    // permission toggles
CONNECT_STEPS / CLAUDE_KEYS_URL                       // connect.ts: what the connect screen shows, the Console key page
connectClaude(db, secrets, key, claudeKeyVerifier(fetch)) // verify with GET /v1/models/claude-opus-5-5 (free), then save
claudeConnection(db, secrets)                         // not_connected | connected | needs_attention, key hint, verified at, problem
disconnectClaude(db, secrets)                         // forget the key and its facts
loadEffort / saveEffort (service.ts)
```

All of them return a `ChatTurnResult`: `status` (`ok`, `refusal`, `max_tokens`, `tool_limit`), `text`, `servedBy`, `fallbackUsed`, `refusal` (category, explanation), `toolCalls` (name, class, allowed, error), `actions` (id, tool, summary, applied / declined / failed), and summed `usage` (input, output, cache read/write tokens, request count).

### 9b.2 Request

```ts
client.beta.messages.create({
  model: "claude-opus-5-5",
  max_tokens: 16000,                                   // non-streaming
  system: [ { text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } } ],   // fixed text, no clock
  tools: 14 read + 12 write tools (fixed order, strict: true, additionalProperties: false),
  tool_choice: { type: "auto" }                        // "none" on the last allowed round
  messages: <stored history, verbatim>,
  output_config: { effort: "medium" },                 // setting claude.effort
  cache_control: { type: "ephemeral" },                // automatic breakpoint at the end of the history
  betas: ["server-side-fallback-2026-07-01"], fallbacks: "default",
})
```

`thinking` is not sent: on Claude Opus 5.5 it is always on, and `disabled` would be rejected. `tool_choice` `any`/`tool` are not used (rejected on this model).

Transport: `claudeCreate(key, fetchImpl)` builds the SDK client with `dangerouslyAllowBrowser: true` (the key is the owner's own, on their own phone), `maxRetries: 2`, a 5-minute timeout, and on the phone `makeNativeFetch(CapacitorHttp.request, { connectTimeoutMs: 30000, readTimeoutMs: 300000 })`. SDK 1.x sends the key as `Authorization: Bearer`, and the beta list as the `anthropic-beta` header.

### 9b.3 Loop

```
require consent claude.aggregates, and claude.photos if images are attached (ask if askConsent is given;
  record the answer) else ConsentRequiredError, nothing stored
append user message [image blocks..., {text: question}, {text: "[App] Now: Sunday 2026-10-25, 19:00 (time zone ...)"}]
log one "photo" disclosure per image
loop:
  res = create(params(history))           errors -> ChatApiError
  append assistant message = res.content verbatim (thinking, fallback, tool_use blocks), model, stop_reason, tokens
  tool_use   -> answer every tool_use block; ONE user message with all tool_results; log disclosures; round += 1; loop
  pause_turn -> loop without adding anything
  other stop with unanswered tool_use blocks -> append is_error tool_results so the history stays valid
  refusal    -> status refusal (+ stop_details);  max_tokens -> status max_tokens
  else       -> status ok, or tool_limit if the round cap (10) was reached
```

The clock goes in the user message, not the system prompt: the system text stays byte-identical, and each stored turn keeps the time it was asked at, so the whole history stays cacheable.

For each **read** tool call: unknown name -> `is_error`. No consent for its class (after asking, if possible) -> `is_error` "the owner has not allowed ... answer without it", and nothing is run or logged. Otherwise run it: success -> JSON result + a disclosure row (`message_id` = the tool-result message); a Zod or query error -> `is_error` with the validation message (no health data), so Claude can fix its arguments.

For each **write** tool call (9b.7): `prepare` validates and describes. Invalid -> `is_error`; the owner is not asked; nothing is logged. Valid -> `confirmAction(proposal)`. Declined, or no `confirmAction` -> `agent_actions` row `declined` and `is_error` "the owner declined". Approved -> `apply` -> `agent_actions` row `applied` with its effects, and the result `{status: "saved", ...ids}`. A failure while saving -> row `failed`, `is_error`.

Rules this keeps:
- **Append-only.** Nothing rewrites or drops an earlier message. Edited history would invalidate thinking blocks and the cache.
- **The history is always valid to resend.** It never ends with an unanswered `tool_use`; after an API error it ends with a user message, which `continueConversation` resends. A new question after that is a second consecutive user message, which the API merges.
- **Fallback detection:** a `fallback` content block or a `fallback_message` entry in `usage.iterations`. `servedBy` is `res.model`.

### 9b.4 Read tools

| Tool | Class | Input | Returns |
|---|---|---|---|
| `list_metrics` | aggregate | none | Synced metrics with local coverage (first/last day, days, unit, category, `daily_agg`), manual kinds, food/drink log day counts |
| `metric_summary` | aggregate | metric, from, to | Per source/device: days with data, avg, min, max, first, last (with `day_not_over`), trend per week (`slopePerDay` from `health.ts`) |
| `compare_periods` | aggregate | metric, a_from, a_to, b_from, b_to | Both summaries, change of the average (absolute and %) |
| `nutrition_summary` | aggregate | from, to | Days logged, average calories and macros per logged day; alcohol drinks, grams total, per drinking day, per calendar day |
| `manual_summary` | aggregate | kind, from, to | Count, avg/min/max of `value_num` and `value_num2`, unit, first/last day |
| `list_goals` | aggregate | none | Live goals, including the daily calorie target |
| `list_saved_meals` | aggregate | none | Saved meals: id, name, usual meal, macros per serving, has photo, times and last time logged |
| `list_meal_preps` | aggregate | tag or null | Recipes: id, name, tags, portions, shelf life, macros per portion, ingredients for one batch, notes |
| `meal_prep_stock` | aggregate | none | Batches with portions left: fridge lots (eat-by, thawed), freezer lots (best-before), eaten, discarded |
| `shopping_list` | aggregate | none | Items, quantities, units, ticked or not |
| `energy_needs` | aggregate | sex, age, height, weight, activity, kg per week | BMR, TDEE, calorie target (floored at BMR), protein target, from `health.ts`. Reads nothing from the database |
| `daily_series` | raw | metric, from, to (max 400 days) | One value per day per source/device |
| `list_food_entries` | raw | from, to (max 31 days) | Food log entries (`dayFood`): id, day, time, meal, name, macros, notes, from meal prep, saved meal, logged by |
| `day_notes` | note | from, to (max 92 days) | Day, mood, energy, note text |
| `drink_types` | aggregate | none | Currency; saved drink types with serving ml, ABV, kcal per serving (and whether estimated), price, times logged |
| `alcohol_impact` | aggregate | from, to | Drinks, drinking days, alcohol g, standard drinks, kcal (and how many estimated), kcal per calendar day, money (and how many priced), currency, latest weight, kg from alcohol, expected weight without alcohol |

A day's value always follows `metric_catalog.daily_agg` (`dailySeries` in `src/features/metrics/queries.ts`), so two weigh-ins on one day count once. Dates are `YYYY-MM-DD`; ranges up to 3660 days; numbers rounded to 2 decimals.

### 9b.5 Consent and disclosures

- Scopes: `claude.aggregates` (questions, summaries, goals, meal prep, saved meals, shopping list; needed for any chat, since the question itself is sent), `claude.raw_series` (day-by-day values and individual food entries), `claude.notes`, `claude.photos`. UI wording in `CONSENT_TEXT`.
- `CONSENT_POLICY_VERSION[scope]` (all `2026-10-25`): a consent recorded under another version of that scope's text does not count, so changing one wording asks again for that scope only.
- In force = newest row per scope (`decided_at_ms`, then insertion order). Refusals are recorded too.
- `ai_disclosures` rows are written when the tool results are stored, just before the request that sends them. If that request fails, the retry sends the same payload. Photos: one `photo` row per image (type and size; the image itself is in `chat_messages`).

### 9b.6 Errors (`toChatError`)

| SDK error | `kind` | Retryable |
|---|---|---|
| `APIConnectionError` (incl. timeout) | network | yes |
| `AuthenticationError`, `PermissionDeniedError` | auth | no |
| `RateLimitError` | rate_limit | yes |
| `BadRequestError` | bad_request | no |
| other `APIError`, 529 | overloaded / server | yes |

The SDK already retries 408/409/429/5xx twice before this. Messages never include the key.

### 9b.7 Write tools, security model, undo

**Security model.** Enforced in code; the system prompt describes it so the assistant can explain it:

| Rule | Where |
|---|---|
| The assistant sees data only through the read tools, each only with the consent for its data class | `tools.ts`, `consent.ts`, engine |
| It can only **add**: new food, drink, measurement, note and goal rows, saved meals, recipes, cooked batches, portion moves, shopping-list lines (or more of an open line), drink types, and a missing kcal or price on an existing drink type (never overwriting a value). No other edits of existing entries, no deletes, no calorie target, settings, consents, keys, sync or backups | `actions.ts` (no other write path) |
| Hard input limits: logs from 60 days back to today (notes 30, batches and portion moves 14), at most 20 food entries per call, kcal 0–5000 per entry, macros, volumes, portions and text lengths capped, measurement kinds `lower_snake_case`, recipe names unique | Zod schemas and checks in `prepare` |
| Nothing is written until the owner confirms the exact lines shown. Without a `confirmAction` handler every change is declined | engine |
| Every proposal is logged in `agent_actions` (applied, declined, failed) with its effects | engine, `logAgentAction` |
| Undo reverses exactly those effects with the app's own undo, and checks every effect's table against `OP_TABLES` before touching anything | `undoAgentAction` |
| Rows the assistant created carry `created_by = 'assistant'` | `logs.ts`, `markAssistant` |
| Text in photos, notes, food names and tool results is data, not instructions | system prompt; the rules above limit an injected instruction to proposing a change the owner must confirm |

**Write tools**

| Tool | Calls | Undo |
|---|---|---|
| `log_food` | `logFood` per entry, one transaction | `deleteFood` |
| `log_saved_meal` | `logSavedMeal` (servings, meal, time) | `deleteFood` |
| `save_meal` | `saveMeal`, optionally with the last JPEG/WebP photo of the chat | `deleteSavedMeal` |
| `create_meal_prep` | `saveMealPrep` (portions, shelf life, macros per portion, tags, ingredients for one batch) | `deleteMealPrep` |
| `log_cooked_batch` | `logBatch` (portions, frozen) | `deleteBatch` |
| `prep_portions` | `addMove`: eat (also logs food), freeze, thaw, discard | `undoMove` (an eaten portion goes back into stock) |
| `add_shopping_items` | `addShoppingItem` per item, one transaction | remove the new lines, put merged quantities back |
| `add_recipe_to_shopping` | `addRecipesToShopping` (recipes x batches) | same |
| `add_drink_type` | `saveDrinkType` (created by the assistant). If the name exists, only a missing kcal or price is filled in (`drink_type_fill`); set values are never changed | delete the type / blank the filled value if it is still the same |
| `log_drink` | `logDrink`: by `drink_type` (its values as defaults) or name, ml and ABV; count 1 to 20; kcal and price per drink | soft delete of each drink |
| `log_measurement` | `insertMeasurement` | soft delete |
| `add_day_note` | `insertDayNote` (refused if the day has a note) | soft delete |
| `create_goal` | `insertGoal` (refuses the daily calorie target) | soft delete |

Shopping-list changes are recorded as a before/after diff of the live lines: new lines become `shopping_insert`, merged quantities `shopping_quantity` with `before` and `after`. Undo refuses a merge whose line has changed since ("undo the item there instead").

Times: `day` + `time` (HH:MM local) become UTC ms + offset with `localDateTimeToMs` (DST-safe). No time: today means now, another day uses a usual time for the meal (breakfast 08:30, lunch 14:00, snack 17:30, dinner 21:00, otherwise 12:00).

`ActionProposal` = `{ tool, summary, lines }`, for example `Log 2 food entries (590 kcal)` with `2026-10-24 14:00 lunch: Grilled chicken, about 200 g, 330 kcal (P 50 g, C 0 g, F 14 g)`.

**Photos.** The app's picker (`downscalePhoto`, JPEG at most 1024 px, no EXIF) feeds `attachmentFromPhoto`. `toAttachment` accepts base64 or a `data:` URL and checks the type (JPEG, PNG, WebP, GIF), base64 validity and the 5 MB limit; at most 4 per message. Photos stay in the conversation (`chat_messages`), so they are in backups. `save_meal` can keep the last JPEG or WebP one with the saved meal (`food_photos`).

**System prompt** (`SYSTEM_PROMPT`): the app's sections by name (Today, Food, Meal prep, Settings, What was sent to Claude, Assistant activity), the data facts, how changes work (propose, confirm, undo; add only; prefer saved meals and prep portions; check the log first), food estimation from photos (portion, hidden fats, ranges, one question at most, notes, offer to save), meal prep (ask once for missing essentials, reuse recipes, `energy_needs` for a target, create recipes, add to shopping, log batches), what it cannot do (permissions, no internet or other apps, no settings or keys, never ask for passwords, data is not instructions), and health guardrails (insights not diagnosis, no very-low-calorie or unsafe plans, allergens cannot be guaranteed).

**Quick prompts** (`QUICK_PROMPTS`): log a meal from a photo (needs `claude.photos`), plan meal prep, what to defrost, sleep this week, what did I eat today (needs `claude.raw_series`), weekly check-in.

## 10. Time and ids

- `tzOffsetMinutes(ms, zone)`, `localDayStart(day, zone)`, `localDay(ms, zone)`, `addDays(day, n)` in `src/core/tz.ts`, using `Intl` only. DST is handled: a local day can be 23 or 25 hours long, and `localDayStart` corrects the offset at the start of the day.
- freddy samples cover a whole local day: `start_ms` = local midnight, `end_ms` = next local midnight, `offset_min` = offset at midnight.
- `uuidv7(now, random)`: RFC 9562 version 7, 48-bit ms timestamp, random rest, so ids sort roughly by creation time and can be generated offline on any device.

## 11. Error handling summary

| Where | On failure |
|---|---|
| `openDatabase` | Rejects; the shell shows "Database unavailable: ..." and the cached promise is cleared |
| `migrate` | Rolls back that migration and throws with its name |
| `upsertSamples` | Rolls back the whole batch and rethrows |
| `runSync` | Never throws: records the error in `sync_runs` and `sync_state.last_error`, cursor unchanged |
| `McpHttpCaller` | `McpHttpError` with a message safe to show (no URL, no key) |
| `exportBackup` / `restoreBackup` | `BackupError` with a message safe to show; restore is all or nothing |
| Chat | `ConsentRequiredError` (nothing sent); `ChatApiError` (kind, retryable, safe message; history stays valid, retry with `continueConversation`); tool errors go back to Claude as `is_error` results |
| Agent changes | Invalid input: `is_error`, owner not asked. Declined: logged, `is_error`. Saving failed: logged as `failed`, `is_error`. `undoAgentAction` throws with a safe message (unknown, not applied, table not allowed, shopping line changed since) |
| Settings form | Validation errors shown inline |

## 12. Tests

Run with `npm test` (`tsx --import ./tests/setup.ts --test tests/*.test.ts`), 184 tests, no device needed.

| File | Covers |
|---|---|
| `uuidv7.test.ts`, `tz.test.ts` | ids; offsets and DST days in Madrid |
| `migrate.test.ts` | parsing, ordering, idempotency, rollback, expected tables, base constraints |
| `schema.test.ts` | 0002 backfill of `local_day` in the row's zone, the views, `dayValues`, day-note and goal constraints, chat foreign keys |
| `samples.test.ts` | upsert columns, re-sync in place, text values, rollback, sync state |
| `catalog.test.ts` | `classifyMetric`, catalog from `list_metrics`, user choices preserved |
| `freddyText.test.ts`, `freddySource.test.ts` | text formats, window, gap warning, chunking, skipped lines |
| `mcpHttp.test.ts`, `nativeFetch.test.ts` | handshake, SSE, headers, error messages without secrets, native adapter |
| `runSync.test.ts` | success, failure keeps cursor, shared concurrent run, `lastSync` |
| `syncReminder.test.ts` | freshness thresholds, next reminder time (due, overdue, never), text and days left, "ago" labels, one reminder moved after each sync, failed runs ignored, cancel when not set up or off, no prompt while off, permission denied, notifier errors swallowed |
| `capacitorDriver.test.ts` | migrations through the plugin fake, CRLF files, rollback via plugin, iOS column row |
| `backup.test.ts` | table coverage, round trip, merge rules, wrong password and tampering, schema versions, rollback mid-restore, restore through the plugin fake in batches |
| `secrets.test.ts` | freddy credentials and Claude key validation and storage |
| `chat.test.ts` | consent gate and recording, request shape, tool loop with parallel calls, verbatim replay of thinking blocks, disclosures, per-class consent, bad arguments, round cap, fallback, refusal, cut-off tool calls, API errors and retry, conversation list |
| `chatTools.test.ts` | every tool against a seeded database, `daily_agg` handling, range limits |
| `agent.test.ts` | photo meal logging end to end, confirm and decline, input limits, photo consent, meal prep end to end (recipe, shopping merge, batch, eaten portion) and undo of each step, shopping undo refused after a change, saved meal with the chat photo and scaled logging, undo table guard, drinks/measurements/notes/goals, `energy_needs`, attachments, the 0005 table rebuild, writes through the plugin fake |
| `claudeClient.test.ts` | the real SDK over `makeNativeFetch` with a fake `CapacitorHttp`: endpoint, auth and beta headers, body sent as an object, 401 mapping |
| `garminImport.test.ts` | file selection by tail (emails in names), unreadable/empty ZIPs, unit conversions (cm, ms, minutes), per-day offsets, no-data markers dropped, date-time dates, profile weight skipped, VO2 latest wins, privacy (no names, places, coordinates, email), report counts, store with aggregation defaults, re-import idempotent and keeping the owner's choices, day view |
| `account.test.ts` | ID token claim checks (issuer, audience incl. arrays, expiry with skew, subject), bind with existing data adopted, owner re-sign-in refreshes email, other account refused, sign-out keeps binding, release and re-bind, backup owner guard (refused / fresh phone / same owner), sign-in flow outcomes and safe messages |
| `connect.test.ts` | key verified over native HTTP before saving (GET models, bearer), rejected keys never saved (401, 404, 529, malformed) with safe messages, key never in SQLite, connection marked and cleared by `watchConnection`, other errors ignored, disconnect |
| `mealPrepStock.test.ts` | stock fold (lots, eat-by, defrost readiness, overdraw), alerts, defrost plan (advice days, late, short days, waste, eaten today) |
| `health.test.ts` | age, BMI and range, BMR/TDEE/target with the floor, macro kcal and split, protein, alcohol and standard drinks, max HR and both zone methods, mean, slope across DST, rolling average with gaps, smoothing |
| `uiKit.test.ts` | ticks, compact numbers, label spacing, line gaps, column paths; the defrost timeline mapping; rendered charts keep their accessible name, table view, empty state, "over target" in words, legend rules and fixed slots; tile deltas, macro shares, alert badges |
| `architecture.test.ts` | every relative import resolves; native plugins only in `platform/`; no logic module reaches one at runtime; layers only depend downwards; logic never imports UI |
| `log.test.ts`, `logging.test.ts` | levels and scope overrides, redaction and summaries, timers, ring buffer, broken sinks; nested transactions; stored log level; no data leaks from real flows into logs |
| `alcohol.test.ts` | kcal and weight maths; drink types (unique names, estimates, delete keeps history); totals in drinks, grams, kcal, money and per day; latest weight from manual or synced in kg/g/lb; expected weight; currency; 0006 on existing drinks; chat add/fill/refuse types, log by type, undo of each, read tools |
| `food.test.ts` | slot by hour and ranking, log/edit/relog/delete in the owner's zone, range with empty days, history paging, calorie goal history, saved meals from entries with linked history and photo replace/delete, servings, photo validation, suggestions by time of day without prep, deleting a prep entry restores stock, backup round trip with photos |
| `mealPrep.test.ts` | recipes with tags and ingredients, edit in place, moves and limits, food log rows, undo rules, tag filter, deleted recipes and batches, portions-a-day setting, unit folding, shopping list merge and clear |

`tests/fakePlugin.ts` copies the Android plugin's behaviour that matters: `execute` splits on `";\n"`, strips comments, runs each piece as one statement, and both `execute` and `run` open their own transaction unless told not to.

Not covered by automated tests: the React screens (the UI kit's components are, rendered to markup), `open.ts`, `secureStore.ts` and `files.ts` (thin Capacitor wrappers), and anything on a real device.

## 13. Scripts

| Script | Purpose |
|---|---|
| `scripts/freddy-probe.mjs` | One-off checks of the freddy endpoint (auth, SSE, CORS, tool output). Never prints URL or key |
| `scripts/garmin-import.ts` (`npm run import:garmin`) | Garmin account export ZIP (the one in `imports/garmin/`, or `--zip`) -> real migrations -> encrypted backup in `imports/garmin/garmin-import-<date>.json` to restore on the phone. Password from `GARMIN_BACKUP_PASSWORD` or a hidden prompt. `--db file` also keeps a local SQLite file, `--no-backup` with `--db` only that, `--dry-run` reads and reports only, `--tz` for days without an offset (default: the PC's zone). Prints counts and date ranges only |
| `scripts/freddy-sync.ts` | Real freddy -> real migrations -> SQLite (memory or `--db file`). Prints counts only |
| `scripts/drizzle-spike.ts` (`npm run spike:drizzle`) | Reproduces why Drizzle was rejected |
| `scripts/claude-chat.ts` (`npm run chat -- --db health.sqlite "question"`) | The agent against a local SQLite file, with `ANTHROPIC_API_KEY` from `.env`. `--photo meal.jpg`, `--allow raw,notes,photos`, `--continue <id>`, `--yes` (otherwise each change asks y/n). Prints the answer, tools, changes, tokens and what was sent. Costs API usage |
| `scripts/android-harden.mjs` (part of `npm run android:sync`) | Sets `allowBackup="false"`, `fullBackupContent="false"`, and data extraction rules excluding every domain. Idempotent |

## 14. How to extend

**Add a migration**
1. Create `src/db/migrations/000N_name.sql`. LF endings, no semicolons in comments, no triggers.
2. Follow the schema rules in [architecture.md section 3](architecture.md#3-rules-the-code-must-keep).
3. Add every new table to `BACKUP_TABLES` with its conflict key (`backup.test.ts` fails until you do).
4. Update the expected table lists in `migrate.test.ts` and `capacitorDriver.test.ts`, add schema tests, and update section 4 of this file.

**Add a source**
1. Implement `Source` (`fetchSince(cursor)` returning samples with stable `externalId`s).
2. Use a new `source` id; samples, catalog and sync state are already keyed by it.
3. Call `runSync(db, newSource)` from the shell.

**Add a feature**
1. Create `src/features/<name>/` with the logic and SQL in `*.ts` (typed rows, writes in `withTransaction`) and tests against `migratedDb()`.
2. Give it a logger, `createLogger("<name>")`, and log each write and refusal by id, kind and count (section 3.6). Never log the values.
3. Put screens in `src/features/<name>/ui/` (or `*.tsx` next to the logic). Keep them thin, take `db` as a prop, and report errors with `failed(err, "<name>")`.
4. Anything that needs the phone goes in `src/platform/` and reaches the logic as a parameter. `npm test` runs the architecture checks.

## 15. Known limitations

- Not yet run on a device (see [architecture.md risk 7](architecture.md#4-open-risks-and-spikes)).
- Backups are manual and the whole file is built in memory. Fine for years of personal data, but it grows with every sample.
- No screens yet for drinks, manual measurements, notes, goals or the chat.
- The chat is non-streaming (native HTTP returns the whole reply), so a long answer shows up all at once after the wait.
- Calorie estimates from photos are estimates: portion size and hidden fats can be off by a lot. The agent says so and keeps its assumption in the entry notes.
- The agent cannot edit or delete entries, or set the calorie target (by design); corrections are an undo plus a new entry, or an edit on the Food screen.
- Photos sent in the chat stay in the conversation, so they are in backups and make them larger.
- Food photos live base64 in SQLite and in the backup file. Fine for a few hundred saved meals (about 100 kB each); a much larger photo library would need files on disk instead.
- Meal prep reminders only show inside the app: there are no push notifications to defrost yet. Shelf-life defaults (4 days fridge, 90 days freezer, 24 h defrost) are rules of thumb the owner can change per recipe, not food-safety advice.
- Text parsing of freddy output can break if freddy changes its wording; unknown lines show up as warnings rather than being lost.
- `last_num` in `daily_metric_values` uses a correlated subquery, fine at personal scale.
