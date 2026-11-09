# <img src="resources/logo.svg" width="36" height="36" alt="" align="top"> Even

Even is a personal health app: wearable data from the Garmin Connect Personal API, local encrypted SQLite, Claude on top. Android first (Samsung S23), with a web app and a sync server since 0.4; iPhone 14 / 14 Plus later. Documentation: [docs/README.md](docs/README.md) (start there), with the [architecture decisions](docs/architecture.md), the [high-level design](docs/HLD.md) and the [low-level design](docs/LLD.md).

The name is about balance: calories eaten against burned, meal prep in stock against the days ahead, drinks against the weight you would be without them, this month's groceries against the last. The logo, a ring half filled around an equals sign, is [resources/logo.svg](resources/logo.svg), the source of the launcher icon, the favicon and the mark on the About page. The app was called Health until 27 Oct 2026; its Android id (`app.health.personal`) and database name stay as they were, so updates install over the existing app and keep its data, and backups made under the old name still restore.

## Status (phase 1)

Done and tested (`npm test`, all against Node's SQLite and a fake that copies the Android plugin's behaviour):
- Schema `0001` + `0002`: samples with `local_day`, metric catalog, daily views, food/drink/manual logs, day notes, goals, Claude chat with a "what was sent" log, consents, sync history. Table guide: [docs/LLD.md section 4](docs/LLD.md#4-schema).
- Encrypted SQLite on the phone (SQLCipher), migrations at startup.
- Garmin sync in the app: personal API key in the Keystore (Settings → Connections), sync on launch and with "Sync now", native HTTP on the phone, every attempt logged.
- Encrypted backup export (share sheet) and restore (merge, newest wins).
- Android auto-backup off (`scripts/android-harden.mjs`).
- Drizzle evaluated and rejected (`npm run spike:drizzle`).

- Claude agent (`src/domain/chat/`): answers questions about your data, estimates and logs meals from photos, logs saved meals and meal prep portions, saves favourites, creates meal prep recipes and shopping lists, records cooked batches, and logs drinks, measurements, notes and goals. Every change is confirmed by you, logged and undoable; what it can read depends on your permissions. Try it on a PC: `npm run chat -- --db health.sqlite --photo lunch.jpg "Log this lunch"`.

- Five tabs in a bottom bar: **Dashboard** (steps, calories burned and eaten, balance, recovery from the watch (sleep, resting heart rate, HRV, Body Battery, stress), meal prep and workouts by day, week or month, with daily averages and totals; sync and the profile with past activity at the top; the journal: daily check-in and manual measurements), **Chat** (Claude, with camera and image attach), **Meal prep** (log what you eat on any day against calorie and macro targets, eat meal prep from the log, the tupper plan (which one each day, when to defrost, what to cook next), stock, recipes you cook or shop for, and the shopping list with what the supermarket cost), **Alcohol** (favourites with a +1, one-off drinks, any logged drink can be changed), **Settings** (profile, connections, privacy and data, debug logs, about with the version).
- **Phase 2 (0.4, now 0.4.2):** a sync server (Hono + Postgres on Vercel and Neon) keeps each account's rows sealed on the device; accounts from invites with a recovery passphrase, more devices by pairing, friends who see daily summaries per shared kind, admins (also through Claude with the admin MCP server), and the web app with its own sealed copy in the browser. Settings > Sync & devices on the phone. Details: [docs/users.md](docs/users.md).
- See every screen in light and dark: [docs/screens/index.html](docs/screens/index.html) (regenerate with `npm run docs:screens`); colors in [docs/screens/palette.html](docs/screens/palette.html).

**Run on an emulator, not yet on the phone.** The debug build passes the device integration test on a Galaxy S23-shaped Android 16 emulator (`npm run test:device`: encrypted database, migrations, a real Garmin sync, restart). Tests and the APK build also run in Docker (`npm run docker:test`, `npm run docker:apk`), the same as CI. Releases: merge `develop` into `master` and GitHub builds, checks, tags and publishes the signed APK (docs/dev-setup.md section 6).

## Setup

```bash
npm install
npm test
npm run health            # format, lint, types (app, tests, scripts), duplicated code, tests: run before a PR
npm run format            # Prettier
npm run docker:test       # the same health checks in the pinned Linux toolchain (CI runs this)
npm run docker:apk        # debug APK into out/app-debug.apk, no local Android SDK needed
npm run docker:release    # signed, checked release APK into out/app-release.apk (release key outside the repo)
npm run build
npm run dev                         # browser: UI only, no local database (native only)
npm run dev:web                     # the web app with the sync server (PGlite, no Docker); npm run docker:up for the Docker version
npm run import:garmin      # on a PC: Garmin export ZIP -> encrypted backup to restore (the app imports the ZIP itself: Settings > Connections)
npm run sync:garmin        # real Garmin Personal API -> SQLite on this PC (GARMIN_API_KEY in .env); add -- --db file.sqlite to keep it
node --env-file=.env --import tsx scripts/garmin-probe.ts   # which Garmin endpoints work for the key, field names only
```

On the phone (needs Android Studio and the SDK):

```bash
npx cap add android        # once. android/ is git-ignored
npm run android:sync       # build + cap sync + disable Android backups. Run after every change
npx cap open android       # run on the S23 from Android Studio
npm run test:device -- --install android/app/build/outputs/apk/debug/app-debug.apk --fresh   # integration test on the emulator or phone
```

Emulator, VS Code tasks and Docker: [docs/dev-setup.md](docs/dev-setup.md).

## Licence

Copyright (C) 2026 Alfredo Artiles Vallecillos.

Even is free software under the [GNU Affero General Public License v3.0 or later](LICENSE) (SPDX: `AGPL-3.0-or-later`): you may use, study, change and share it, and if you share a changed version, or run one as a network service for others (the sync server, the web app), you must offer its full source under the same licence. It comes with no warranty, and it is not a medical device. Garmin and Claude are trademarks of their owners; this project is not affiliated with them.

Contributing or keeping a fork public: no secrets, no real health data. `npm run public:check` and [docs/dev-setup.md](docs/dev-setup.md) section 6b.

## Next steps

1. Run it on the real S23 (`npm run test:device` with the phone plugged in), then check backup export/share/restore by hand (docs/architecture.md risk 7).
