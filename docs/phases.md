# Even: phases and targets

Agreed 28 Oct 2026. Even ships to more than one target: the **Android app** (now), the **web app** (phase 2, shipped in 0.4, now 0.4.2: [users.md](users.md), [architecture.md section 6](architecture.md)) and the **iPhone app** (a later phase). Their UIs will grow apart, so the code splits at the top and shares everything below.

## How the code is split

| Shared by every target, never forked | Per target |
|---|---|
| `domain/` (logic and SQL per feature), `db/` (schema, migrations), the backup format, the sync wire format (`core/syncWire.ts`), metric names and sources, `core/`, `ui/` (the kit), `platform/` (adapters; the OS is picked at runtime) | `apps/<target>/`: the entry and whatever only that target needs: its start, later its own shell, its own copy of a screen that has diverged |

- `shell/` (App, the five sections, lazy screens; each target brings its own navigation as `Target.Frame`) and `screens/` are shared **for now**. When a target needs something different, the different part moves into `apps/<target>/`. Small differences stay as props on the shared code; a whole screen is copied only when it really differs.
- A backup made on one target restores on any other, and every target syncs the same rows.
- The Vite mode picks the target: `npm run build` is Android, `npm run build:web` (`--mode web`) the web app. The built `index.html` names its target, and `scripts/android-harden.mjs` stops a web build from going into the APK.
- `tests/architecture.test.ts` enforces the layers, that no target imports another, and that every build path names the right target.

## Android

### Step A: the split (this change)

Code moved into `apps/`, `shell/`, `screens/`, `domain/`; moves only, no behaviour change. iOS was already parked out of CI (PR #54).

**Done when:** `npm run health` is green, both builds work (bundle sizes as before), and CI's Docker test and sync-environment jobs pass.

### Step B: on the real phone

- `npm run test:device` on the S23. Backup export, share and restore by hand. One UI battery settings ([architecture.md section 9](architecture.md#9-next-steps)).
- The Chat tab on the phone: camera, consent, confirmations, undo.
- Settings > Sync & devices against the sync server (users.md section 2.1).

### Step C: Android-specific work

What diverges first goes in `apps/android/` (or `platform/` when it is native), never in `domain/`:
- the system back button and predictive back across tabs and pages;
- background sync (WorkManager) as well as sync on open;
- a home screen widget and notification actions;
- Health Connect as a source, if wanted (needs min SDK 26 and its own permissions; a decision for then).

### Step D: delivery (optional)

Releases are a signed APK on GitHub, sideloaded ([dev-setup section 6](dev-setup.md#6-releases)). Play Console internal testing (AAB, Play App Signing, a second SHA-1 for Google sign-in) only if sideloading gets in the way.

## Web app (phase 2, 0.4)

Shipped in 0.4.0 and deployed on Vercel; 0.4.2 adds the web Dashboard's macro split, two-week trends and Alcohol section, *Sign out* in the side menu, clearer connect screens, and a softer look on wide screens (`--lift`).

Order of work as in [users.md section 5](users.md#5-order-of-work-for-04). For the structure:

1. **Split the shell (done 28 Oct 2026).** The web's connect gate lives in `apps/web/connectGate.tsx` and reaches the shared shell as `Target.gate` (`shell/target.ts`); Android's entry passes none. What a target adds to the shell goes through `Target`, never through `isNative` checks in `shell/`. The remaining `isNative` checks in screens are capabilities (share or copy, where a key is kept) and stay.
2. **Web-only screens** (the web has no Garmin key, no notifications, no camera picker) go in `apps/web/`. They are not flags inside the shared screens.
3. **Before the first Vercel deploy** (done) ([dev-setup section 4b](dev-setup.md#4b-sync-environment-postgres-the-sync-server-the-web-app)): the Vercel project (Hobby) with the Neon integration, `SERVER_SECRET`, `PUBLIC_URL` (for the admin MCP) and the other server variables set in Vercel, never in the repo. Production branch `master`, so the web app and the APK release ship from the same merge. `vercel-build` already builds the web target.
4. **Done when:** a phone and the web app sync through the deployed server (`npm run test:sync` against it), and a fresh browser connects with the passphrase.

## iPhone app (later phase)

Starts once Android and the web app are stable. Needs an Apple Developer account first (signing, the HealthKit capability, TestFlight).

1. `src/apps/ios/` and an `ios` Vite mode (`vite.config.ts` `targetOf`), with `ios:sync` building it. Then a guard like Android's in `ios-harden.mjs`.
2. CI back: `scripts/ci/ios.yml` to `.github/workflows/` ([dev-setup section 7](dev-setup.md#7-ios)).
3. Signed builds and TestFlight. Apple Health on a real iPhone.
4. App Attest for Claude, an iOS Google OAuth client, the database excluded from iCloud backup.
5. A backup and a sync from the Android phone arrive intact on the iPhone.

## Rules for every release

- Bump `package.json` on `develop` before merging into `master`: the release stops on a version that is already tagged.
- Merging into `master` releases the APK (`release.yml`) and, once Vercel is connected, deploys the web app. Both come from the same commit, so phone and web always speak the same sync format.
- A release installs over the phone's current app (release key only). Make a backup on the phone before installing.
- Never fork `domain/`, `db/`, the backup format or the sync wire format per target. A migration is shared by every target, and the server's migrations ship before any client that needs them.
