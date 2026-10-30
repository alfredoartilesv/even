# Even: context for Claude

Even is a personal health app for one owner, Android first (Galaxy S23), plus a web app (phase 2, shipped in 0.4, now 0.4.2); iPhone is a later phase (kept in the repo, out of CI). It reads the owner's Garmin data (Garmin Connect Personal API, plus the Garmin export ZIP), stores everything locally in an encrypted database on the phone, shows a Dashboard and logs (food, meal prep, alcohol, journal), and lets the owner ask Claude about their own data with recorded consent.

Stack: React 19, TypeScript 7, Vite 8, Capacitor 8 (Android, iOS), SQLite with SQLCipher through `@capacitor-community/sqlite`, zod, fflate. Sync server: Hono + Postgres in `server/`, deployed as the Vercel function `api/index.ts` on Neon; the web app's database is sql.js sealed in IndexedDB. Tests: `node:test` through tsx, with node:sqlite standing in for the plugin. Node 24 (`.nvmrc`). App id `app.health.personal` (kept from before the rename to Even, as are the DB name `health` and the `HEALTH_*` env names).

Read first when the task needs it: `docs/architecture.md` (decisions and **section 3, rules the code must keep**), `docs/LLD.md` (layout, schema, backup format), `docs/dev-setup.md` (toolchain, Docker, health checks, emulator, releases), `docs/HLD.md`.

## Commands

| Command | What |
|---|---|
| `npm run health` | format check, lint (0 warnings), typecheck (app + tests + scripts), duplicates (max 1%), tests. **Must pass before every commit that goes in a PR.** CI runs it in Docker. |
| `npm run format` | Prettier, print width 160, LF |
| `npm test` | Node tests only |
| `npm run docs:screens` | regenerates `docs/screens/` from the real app with demo data; look at the captures after UI changes |
| `npm run android:sync` | web build, `cap sync`, hardening (`scripts/android-harden.mjs`) |
| `npm run perf:device` | start-up timings on the emulator, two builds compared (dev-setup.md) |
| `npm run release:check -- --apk <apk>` | the 5 checks a release APK must pass (9 with `--device`) |

## Rules that are easy to break

- **Layers** (`tests/architecture.test.ts`): `apps/<target>` -> `shell` -> `screens` -> `domain`, `ui`, `platform` -> `db` -> `core`. One entry per target (`apps/android`, `apps/web`); a target never imports another, and `domain/` never imports a screen, `ui/` or `platform/`. Only `src/platform/` imports Capacitor plugins at runtime; logic never reaches one, even indirectly.
- **Targets**: `npm run build` is Android, `npm run build:web` (`--mode web`) the web app; `android-harden.mjs` refuses a web build. Schema, migrations, backup and sync formats, metric names and sources are shared by every target, never forked; what one target needs alone goes in `apps/<target>/` (`docs/phases.md`).
- **Migrations**: new numbered file in `src/db/migrations/`, never edit one that shipped (phones already ran it). No semicolons in SQL comments. A new table goes in `BACKUP_TABLES` (`src/domain/backup/backup.ts`).
- **Logging**: `createLogger(scope)`, never `console.*` in `src/`. Log ids, counts, kinds, durations; never health values, food names, notes, chat text, URLs or keys.
- **Secrets** only in the Keystore/Keychain: never in SQLite, logs, error messages, the repo or a backup.
- **Health data leaves the phone only** to Claude (consent per kind, every send in the disclosure log) and in encrypted backup files the owner shares. Garmin is read only.
- **Sources** (`garmin`, `freddy`, `apple_health`, `garmin_export`) are never added together; `daily_metric_values` picks one per metric and day.
- **Server imports**: in everything the Vercel function loads (`api/index.ts` and what it reaches in `server/` and `src/core/`), relative imports name the `.js` file and there are no TypeScript parameter properties, or the Vercel function fails to load (`tests/vercelFunction.test.ts`).
- **Start-up path** stays small: every screen but the Dashboard is lazy (`src/shell/screens.tsx`), and modules on the Dashboard's path use `zod/mini`. Check the bundle when adding imports there.
- **No duplicated blocks**: shared UI goes in `src/ui/`, shared Node helpers for scripts and tests in `scripts/lib/`.
- Comments say why, in plain words; tests describe behaviour in their names. Match the surrounding style.

## Workflow

- Branch from `develop` (`feat/…`, `fix/…`, `chore/…`, `perf/…`), PR into `develop`. `master` is for releases only: merging `develop` into `master` runs `.github/workflows/release.yml` (build, emulator check, tag `v<version>`, GitHub release). Bump `package.json` on `develop` first: an already tagged version stops the release.
- Commit messages end with the `Co-Authored-By` line from the session's instructions; PR bodies end with the Claude Code line.
- Another Claude session may be working in this folder. Do work in a worktree under `.worktrees/` (git-ignored), run `npm ci` in it (real `node_modules`, **never** a junction into the main folder: removing the worktree would delete the real one), and never commit someone else's uncommitted changes.
- Windows: Git Bash and PowerShell. `gh` is `/c/Program Files/GitHub CLI/gh.exe`. Release key and its env file live in `%USERPROFILE%\.android\health-release\` (read the env file literally, values contain backslashes).
- Emulators: AVDs `Galaxy_S23_API_36` and `Pixel_8_API_36`. The S23 one holds a 0.1.0 debug build installed outside these sessions: do not uninstall or overwrite it; perf builds use an `applicationIdSuffix`.
- Releases install over the phone's app only when signed with the release key (`release/cert-sha256.txt`); a debug build on the phone needs backup, uninstall, install, restore.
