# Health

Personal health app: wearable data via freddy, local encrypted SQLite, Claude on top. Android first (Samsung S23), iPhone 14 / 14 Plus second. Documentation: [docs/README.md](docs/README.md) (start there), with the [architecture decisions](docs/architecture.md), the [high-level design](docs/HLD.md) and the [low-level design](docs/LLD.md).

## Status (phase 1)

Done and tested (`npm test`, all against Node's SQLite and a fake that copies the Android plugin's behaviour):
- Schema `0001` + `0002`: samples with `local_day`, metric catalog, daily views, food/drink/manual logs, day notes, goals, Claude chat with a "what was sent" log, consents, sync history. Table guide: [docs/LLD.md section 4](docs/LLD.md#4-schema).
- Encrypted SQLite on the phone (SQLCipher), migrations at startup.
- freddy sync in the app: URL + key in the Keystore (Settings), sync on launch and with "Sync now", native HTTP by default, every attempt logged.
- Encrypted backup export (share sheet) and restore (merge, newest wins).
- Android auto-backup off (`scripts/android-harden.mjs`).
- Drizzle evaluated and rejected (`npm run spike:drizzle`).

**Not yet run on a device.** Not started: the daily screens beyond the "latest day" list, Claude chat.

## Setup

```bash
npm install
npm test
npm run build
npm run dev                         # browser: UI only, no local database (native only)
node --env-file=.env --import tsx scripts/freddy-sync.ts   # real freddy -> SQLite on this PC
```

On the phone (needs Android Studio and the SDK):

```bash
npx cap add android        # once. android/ is git-ignored
npm run android:sync       # build + cap sync + disable Android backups. Run after every change
npx cap open android       # run on the S23 from Android Studio
```

## Next steps

1. Run it on the S23: DB opens and migrates, sync works over native HTTP, backup export/restore works. Then try the "WebView fetch" transport once (CORS question, docs/architecture.md section 4b).
2. Choose the 2-3 daily screens (docs section 8) and build them on the existing schema.
3. Claude chat.