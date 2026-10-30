# Even documentation

Even is a personal health app for Android (then iPhone), with a web app: Garmin data straight from the Garmin Connect Personal API, kept in an encrypted local database, with daily screens, manual logs and Claude on top. Phase 1 runs entirely on the phone; phase 2 (0.4) adds a sync server, accounts and the web app, with rows sealed on the device.

## Which document to read

| Document | Read it when you want to know | Contents |
|---|---|---|
| [architecture.md](architecture.md) | **Why** it is built this way | Decisions in force, rules the code must keep, open risks, rejected options, the open question for the owner, next steps |
| [users.md](users.md) | **Who** uses Even in phase 2 | Accounts, devices, friends, the operator; each case step by step (first phone, adding the web, recovery, friends and shares); server tables; order of work for 0.4 |
| [HLD.md](HLD.md) | **What** the system is and how data moves | Context, components, main flows (start, sync, backup, Claude), data groups, security, deployment, quality attributes |
| [LLD.md](LLD.md) | **How** a part works in the code | Repo layout, interfaces, database driver and its quirks, the full schema, the Garmin Personal API client and mapping, sync algorithm, backup file format and merge rules, tests, how to extend |
| [phases.md](phases.md) | **What comes next**, per target | How the code splits per target; Android, the web app, iOS later; what each needs before it is deployed |
| [dev-setup.md](dev-setup.md) | **How to build and run** on this PC | JDK 21 and Android SDK install, environment variables, emulator acceleration, VS Code extensions and tasks, debugging the WebView, when Docker helps |

New to the repo: read this page, then the HLD, then the parts of the LLD you need. Before changing a decision, read architecture.md.

## Status (30 Oct 2026, version 0.4.2)

| Area | State |
|---|---|
| Encrypted local database, migrations at startup | Built, tested in Node |
| Schema for all candidate daily screens (version 2) | Built, tested |
| Garmin Personal API sync in the app (personal API key in the Keystore, sync on launch and on demand, native HTTP) | Built, tested; real sync verified from a PC. Replaced the freddy sync on 26 Oct 2026 |
| Encrypted backup export and restore | Built, tested |
| Android auto-backup disabled | Built (patch script) |
| Run on Android | Debug build passes the device integration test (`npm run test:device`, 11 checks). The 0.1.0 release APK is installed on the real S23 on a Galaxy S23-shaped Android 16 emulator. **Not yet on the real phone** |
| Docker (standard test and APK build, CI) | `npm run docker:test`, `npm run docker:apk`, `.github/workflows/ci.yml` (PRs: tests only) |
| Releases | Merge `develop` into `master`: signed APK built and checked in Docker, launched on an emulator, tagged `v<version>` and published as a GitHub release (`release.yml`, dev-setup.md section 6). Needs the four `HEALTH_*` GitHub secrets |
| Dashboard (Day / Week / Month: rings, macro split, energy with two-week trends, recovery, check-in, workouts, alcohol, meal prep, groceries), Journal, Profile | Built and tested |
| Claude agent (questions, meal logging from photos, saved meals, meal prep and shopping, logs and goals; every change confirmed and undoable) | Built and tested (`src/domain/chat/`, `npm run chat` on a PC); Chat tab with camera and image attach |
| Connect Claude (verified API key; there is no "Sign in with Claude" for Android apps, see architecture.md section 5) | Built and tested (`connect.ts`); screen in Settings > Connections |
| Garmin history import (account export ZIP, imported on the phone in Settings > Connections, or on a PC as an encrypted backup to restore; 2018-2026 imported on the first run) | Built and tested (`domain/import`, `npm run import:garmin`) |
| Google sign-in (optional; one owner per install, for a phone that never connects) | Built and tested (`domain/account`, Settings > Profile); needs the Google Cloud setup (architecture.md 5b). On a connected device the sync account is the user and Google links to it |
| Sync server, accounts, devices, pairing, friends (phase 2) | Built and tested (`server/`, `domain/cloudsync/`); deployed on Vercel + Neon with 0.4; locally in Docker or `npm run dev:web` (dev-setup.md 4b) |
| Admins and the admin MCP server (invites, accounts, quotas, devices, suspension, audit log; Claude as a connector behind OAuth 2.1) | Built and tested (users.md sections 2.6 and 9) |
| Web app (connect gate, side menu with Sign out, the shared screens, database sealed in the browser, 30 days without use or tab-only on a shared computer) | Built and deployed (`apps/web/`, phases.md) |

## Quick start

```bash
npm install
npm test                    # 410 tests, no device needed
npm run docker:test         # the same in the pinned Docker toolchain (standard before a PR; CI runs it)
npm run build               # typecheck + Vite build
npm run dev                 # browser: UI only, no local database
npm run dev:web             # the web app on :5173 with the sync server on :8787 (PGlite, no Docker)
```

Android build, emulator and VS Code tasks: [dev-setup.md](dev-setup.md).

Real Garmin data on your PC (needs `.env` with `GARMIN_API_KEY`, see `.env.example`):

```bash
npm run sync:garmin                                         # in memory
npm run sync:garmin -- --db health.sqlite                   # keep a file
node --env-file=.env --import tsx scripts/garmin-probe.ts   # which endpoints work for the key (field names only)
npm run import:garmin                                       # Garmin export ZIP in imports/garmin/ -> encrypted backup (git-ignored)
```

On the phone (needs Android Studio and the Android SDK):

```bash
npx cap add android         # once; android/ is generated and git-ignored
npm run android:sync        # build + cap sync + disable Android backups; run after every change
npx cap open android        # build and run on the device from Android Studio
```

## Glossary

| Term | Meaning |
|---|---|
| Garmin Personal API | Garmin's read-only API for your own data. A personal API key (made in Garmin Connect, shown once, expires on a date you pick) is traded for a short-lived access token |
| freddy | Third-party hub the app synced through until 26 Oct 2026. Its code is gone; rows it stored (source `freddy`) stay and are shown where the Personal API has nothing for that day |
| Sample | One reading stored in `health_samples` (one metric, one local day, one device) |
| Local day | Calendar day (`YYYY-MM-DD`) in the time zone in force for that reading |
| Cursor | Where the last sync of a source ended (for Garmin: a local day; the next sync reads again from there). Stored in `sync_state` |
| Source priority | The same reading can be stored by the Personal API (`garmin`), freddy and the export (`garmin_export`). `daily_metric_values` shows one of them per metric and day, in that order (migration 0009) |
| SqlDriver | The 3-method database interface the core code uses, so it runs on the phone and in Node |
| Live row | A row whose `deleted_at` is NULL (soft delete) |

## Keeping these docs current

- A decision changes: edit [architecture.md](architecture.md) and date it.
- A new migration: update [LLD.md section 4](LLD.md#4-schema) and the data table in [HLD.md section 5](HLD.md#5-data).
- A new component or flow: update the HLD diagrams.
