# Health

Personal health app: wearable data from the Garmin Connect Personal API, local encrypted SQLite, Claude on top. Android first (Samsung S23), iPhone 14 / 14 Plus second. Documentation: [docs/README.md](docs/README.md) (start there), with the [architecture decisions](docs/architecture.md), the [high-level design](docs/HLD.md) and the [low-level design](docs/LLD.md).

## Status (phase 1)

Done and tested (`npm test`, all against Node's SQLite and a fake that copies the Android plugin's behaviour):
- Schema `0001` + `0002`: samples with `local_day`, metric catalog, daily views, food/drink/manual logs, day notes, goals, Claude chat with a "what was sent" log, consents, sync history. Table guide: [docs/LLD.md section 4](docs/LLD.md#4-schema).
- Encrypted SQLite on the phone (SQLCipher), migrations at startup.
- Garmin sync in the app: personal API key in the Keystore (Settings → Connections), sync on launch and with "Sync now", native HTTP on the phone, every attempt logged.
- Encrypted backup export (share sheet) and restore (merge, newest wins).
- Android auto-backup off (`scripts/android-harden.mjs`).
- Drizzle evaluated and rejected (`npm run spike:drizzle`).

- Claude agent (`src/features/chat/`): answers questions about your data, estimates and logs meals from photos, logs saved meals and meal prep portions, saves favourites, creates meal prep recipes and shopping lists, records cooked batches, and logs drinks, measurements, notes and goals. Every change is confirmed by you, logged and undoable; what it can read depends on your permissions. Try it on a PC: `npm run chat -- --db health.sqlite --photo lunch.jpg "Log this lunch"`.

- Five tabs in a bottom bar: **Dashboard** (steps, calories burned and eaten, balance, meal prep and workouts by day, week or month, with daily averages and totals; sync and the profile with past activity at the top), **Chat** (Claude, with camera and image attach), **Meal prep** (log what you eat, stock, recipes, shopping), **Alcohol**, **Settings** (profile, connections, privacy and data, debug logs, about with the version).
- See every screen in light and dark: [docs/screens/index.html](docs/screens/index.html) (regenerate with `npm run docs:screens`); colors in [docs/screens/palette.html](docs/screens/palette.html).

**Not yet run on a device.**

## Setup

```bash
npm install
npm test
npm run build
npm run dev                         # browser: UI only, no local database (native only)
npm run import:garmin      # Garmin export ZIP in imports/garmin/ -> encrypted backup to restore on the phone
npm run sync:garmin        # real Garmin Personal API -> SQLite on this PC (GARMIN_API_KEY in .env); add -- --db file.sqlite to keep it
node --env-file=.env --import tsx scripts/garmin-probe.ts   # which Garmin endpoints work for the key, field names only
```

On the phone (needs Android Studio and the SDK):

```bash
npx cap add android        # once. android/ is git-ignored
npm run android:sync       # build + cap sync + disable Android backups. Run after every change
npx cap open android       # run on the S23 from Android Studio
```

## Next steps

1. Run it on the S23: DB opens and migrates, sync works over native HTTP, backup export/restore works (docs/architecture.md risk 7).
2. Screens for manual measurements and day notes (the chat can already log them).
