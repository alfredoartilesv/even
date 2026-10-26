# Health App documentation

A personal health app for Android (then iPhone): wearable data through freddy, kept in an encrypted local database, with daily screens, manual logs and, later, Claude on top. Phase 1 runs entirely on the phone.

## Which document to read

| Document | Read it when you want to know | Contents |
|---|---|---|
| [architecture.md](architecture.md) | **Why** it is built this way | Decisions in force, rules the code must keep, open risks, rejected options, the open question for the owner, next steps |
| [HLD.md](HLD.md) | **What** the system is and how data moves | Context, components, main flows (start, sync, backup, Claude), data groups, security, deployment, quality attributes |
| [LLD.md](LLD.md) | **How** a part works in the code | Repo layout, interfaces, database driver and its quirks, the full schema, freddy parsing and MCP client, sync algorithm, backup file format and merge rules, tests, how to extend |

New to the repo: read this page, then the HLD, then the parts of the LLD you need. Before changing a decision, read architecture.md.

## Status (25 Oct 2026)

| Area | State |
|---|---|
| Encrypted local database, migrations at startup | Built, tested in Node |
| Schema for all candidate daily screens (version 2) | Built, tested |
| freddy sync in the app (Keystore credentials, sync on launch and on demand, native HTTP) | Built, tested; real sync verified from a PC |
| Encrypted backup export and restore | Built, tested |
| Android auto-backup disabled | Built (patch script) |
| Run on the S23 | **Not done yet** |
| Daily screens beyond the "latest day" list | Not started; waiting for the owner to choose them |
| Claude agent (questions, meal logging from photos, saved meals, meal prep and shopping, logs and goals; every change confirmed and undoable) | Built and tested (`src/features/chat/`, `npm run chat` on a PC); no chat screen yet |
| Connect Claude (verified API key; there is no "Sign in with Claude" for Android apps, see architecture.md section 5) | Built and tested (`connect.ts`); no screen yet |
| Google sign-in (optional; one owner per install, data and backups tied to that account) | Built and tested (`features/account`); needs the Google Cloud setup (architecture.md 5b) and a screen |

## Quick start

```bash
npm install
npm test                    # 172 tests, no device needed
npm run build               # typecheck + Vite build
npm run dev                 # browser: UI only, no local database
```

Real freddy data on your PC (needs `.env` with `FREDDY_MCP_URL` and `FREDDY_MCP_KEY`, see `.env.example`):

```bash
node --env-file=.env --import tsx scripts/freddy-sync.ts                  # in memory
node --env-file=.env --import tsx scripts/freddy-sync.ts --db health.sqlite   # keep a file (git-ignored)
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
| freddy | Third-party hub that collects Garmin, Health Connect and Apple Health data. The app reads it through freddy's MCP endpoint |
| MCP | Model Context Protocol. freddy exposes tools (`list_metrics`, `query_metrics`) that return text |
| Sample | One reading stored in `health_samples` (one metric, one local day, one device) |
| Local day | Calendar day (`YYYY-MM-DD`) in the time zone in force for that reading |
| Cursor | Where the last sync of a source ended (for freddy: a local day). Stored in `sync_state` |
| Gap | Days that could not be fetched because the last sync is older than freddy's 7-day free-plan window |
| SqlDriver | The 3-method database interface the core code uses, so it runs on the phone and in Node |
| Live row | A row whose `deleted_at` is NULL (soft delete) |

## Keeping these docs current

- A decision changes: edit [architecture.md](architecture.md) and date it.
- A new migration: update [LLD.md section 4](LLD.md#4-schema) and the data table in [HLD.md section 5](HLD.md#5-data).
- A new component or flow: update the HLD diagrams.
