# Health

Personal health app: wearable data via freddy, local encrypted SQLite, Claude on top. Android first (Samsung S23), iPhone 14 / 14 Plus second. Decisions and open risks: [docs/architecture.md](docs/architecture.md).

## Status (phase 1)

Done and tested (`npm test`, 11 tests):
- UUIDv7 ids, SQL driver interface, migration runner (`PRAGMA user_version`, one transaction per migration, rollback on failure)
- `0001_init.sql`: `health_samples`, `sync_state`, `food_entries`, `drink_entries`, `app_settings`
- `Source` interface and a `FreddySource` stub

Written but **not yet built or run** (needs `npm install`): the React/Vite shell and `capacitor.config.ts`.

Not started: Capacitor SQLite driver, freddy adapter, screens, Claude chat.

## First-time setup

```bash
npm install react react-dom @capacitor/core @capacitor-community/sqlite zod
npm install -D vite @vitejs/plugin-react typescript tsx @types/react @types/react-dom @types/node @capacitor/cli
npm test          # 11 tests should pass
npm run build     # typecheck + vite build
npm run dev       # browser dev server
```

Then, for Android (needs Android Studio):

```bash
npx cap add android
npm run build && npx cap sync android
npx cap open android
```

## Next steps

1. **freddy spike** (see docs/architecture.md section 4): can a third-party app read freddy data, and how?
2. Implement `SqlDriver` on `@capacitor-community/sqlite` (SQLCipher, key in Android Keystore), run `migrate()` at startup.
3. Pick the 2-3 daily screens, then build the freddy adapter against them.
4. Disable Android auto-backup for the database; add manual encrypted export/restore.
