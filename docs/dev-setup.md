# Developer setup (Windows, VS Code, Android)

Everything installs per user, under `%LOCALAPPDATA%`; no Android Studio needed. Checked on 27 Oct 2026 with Windows 11, VS Code, Node 24.

## 1. Toolchain

| Piece | Version | Where | Why |
|---|---|---|---|
| Node.js | 24 | `C:\Program Files\nodejs` | Vite, tests, Capacitor CLI |
| JDK | Temurin 21 | `%LOCALAPPDATA%\Programs\Java\jdk-21*` | Capacitor 8 / Android Gradle Plugin 8.13 need Java 21 |
| Android SDK command-line tools | 23 (Android CLI) | `%LOCALAPPDATA%\Android\Sdk\cmdline-tools\latest` | Installs the rest. In 23, `sdkmanager` is replaced by `android sdk ...` and package names use `/` |
| Platform 36, build-tools 35 and 36, platform-tools, emulator | from the Android CLI | `%LOCALAPPDATA%\Android\Sdk` | `compileSdk` and `targetSdk` 36 (`android/variables.gradle`) |
| System image | `system-images/android-36/google_apis/x86_64` | same | Emulator with Google Play services (needed for Google sign-in) |

User environment variables: `JAVA_HOME` (the JDK), `ANDROID_HOME` and `ANDROID_SDK_ROOT` (the SDK), and on the user `Path`: `%JAVA_HOME%\bin`, `platform-tools`, `emulator`, `cmdline-tools\latest\bin`. Restart VS Code after changing them.

The SDK packages, from a terminal:

```powershell
$sdk = "$env:LOCALAPPDATA\Android\Sdk"
android --sdk=$sdk sdk install platform-tools emulator platforms/android-36 build-tools/35.0.0 build-tools/36.0.0 system-images/android-36/google_apis/x86_64
avdmanager create avd -n Pixel_8_API_36 -k "system-images;android-36;google_apis;x86_64" -d pixel_8
```

A system-wide Oracle Java 17 earlier on the `Path` is harmless: Gradle uses `JAVA_HOME`, and the VS Code user settings point the Java and Gradle extensions at JDK 21 (`java.jdt.ls.java.home`, `java.import.gradle.java.home`).

**Emulator acceleration.** With Hyper-V on (Docker Desktop and WSL 2 turn it on), the emulator uses the **Windows Hypervisor Platform** (WHPX). Check with `emulator -accel-check`: it must say "WHPX ... is installed and usable" (it does on this PC). If it does not, enable the feature once as administrator and reboot:

```powershell
Enable-WindowsOptionalFeature -Online -FeatureName HypervisorPlatform -All
```

The AVD `Pixel_8_API_36` has 4 GB of RAM, the host GPU (`hw.gpu.mode=host`) and the PC keyboard enabled (`hw.keyboard=yes`), set in `%USERPROFILE%\.android\avd\Pixel_8_API_36.avd\config.ini`.

## 2. VS Code

Recommended extensions (offered when the folder opens, `.vscode/extensions.json`):

- **Android iOS Emulator** (`diemasmichiels.emulate`): the phone icon in the editor title bar, or "Emulator" in the command palette, lists the AVDs and starts one. User setting `emulator.emulatorPathWindows` = `%LOCALAPPDATA%\Android\Sdk\emulator`; `emulator.androidColdBoot` offers a cold boot.
- Gradle for Java and Language Support for Java: browse and run Gradle tasks in `android/`.
- Prettier, Claude Code.

Tasks (Terminal > Run Task, `.vscode/tasks.json`):

| Task | Does |
|---|---|
| Android: create native project | `npx cap add android` and the backup hardening. Once after cloning: `android/` is generated, not committed |
| Android: sync | `npm run android:sync`: web build, copy into `android/`, hardening |
| Android: build debug APK (default build, Ctrl+Shift+B) | sync, then `gradlew assembleDebug` -> `android/app/build/outputs/apk/debug/app-debug.apk` |
| Android: start emulator | `emulator -avd <name>` (asks for the name, default `Pixel_8_API_36`) |
| Android: run on emulator or phone | sync, then `npx cap run android`: build, install, launch; asks which device if several |
| Android: logcat (app only) | `adb logcat` filtered to the app's process |
| Test, Typecheck | `npm test`, `npm run typecheck` |
| Docker: test, Docker: build debug APK | `npm run docker:test`, `npm run docker:apk` (section 4); the release build is `npm run docker:release` (section 6) |
| Android: device integration test | `npm run test:device` on the running emulator or phone (section 5) |

Debugging the WebView: with the app running on the emulator or a USB phone, open `chrome://inspect` in Chrome or Edge and click *inspect* under `app.health.personal`. Settings > Debug logs in the app shows the app's own log records.

A phone instead of the emulator: enable Developer options > USB debugging, plug it in, accept the prompt, and `adb devices` lists it. The run task then offers it.

## 3. Daily loop

1. `npm run dev` for screens that do not need the database (the browser build has no SQLite).
2. `npm test` for logic: everything except `src/platform/` runs in Node.
3. "Android: run on emulator or phone" to try it for real, `chrome://inspect` to debug.
4. Before a PR: `npm run health` (or `npm run docker:test`, which CI runs, with the same checks inside), and `npm run test:device` on the emulator when a change touches the phone side.

**Health checks** (`npm run health`, also the Docker test stage and so CI):

| Script | Checks |
|---|---|
| `npm run format:check` | Prettier style (`.prettierrc.json`: print width 160, LF). `npm run format` fixes it. Line endings are LF in the repo whatever the checkout (`.gitattributes`). |
| `npm run lint` | oxlint (`.oxlintrc.json`): correctness, React Hooks, TypeScript and import rules, no warnings allowed. typescript-eslint does not support TypeScript 7 yet; oxlint does not need the TypeScript package. |
| `npm run typecheck` | the app (`tsconfig.json`) and the tests and scripts (`tsconfig.node.json`). |
| `npm run dupes` | copied blocks of 8+ lines in `src/` and `scripts/` (`scripts/dupes.mjs`), at most 1%. Tests are left out on purpose. |
| `npm test` | every Node test. |
| `npm run audit` | known vulnerabilities in runtime dependencies (network, so not in `health`). |

**Start-up timings** (`npm run perf:device`, `scripts/perf-device.mjs`): compares two debug builds on the emulator. Build each with `VITE_PERF_SEED=1` (about 42,000 readings, `src/shell/perfSeed.ts`) and an `applicationIdSuffix ".perf"` for the debug build type in the generated `android/app/build.gradle`, so it installs next to the normal app. Then `npm run perf:device -- --apk <apk> --label before --out before.json`, the same for the other build, and `npm run perf:device -- --compare before.json after.json`. It reads Android's launch time, first paint, and the app's marks (`even:db-open`, `even:dashboard-ready`, one per step of the database open) through the WebView's DevTools socket.

## 4. Docker: the standard test and build

Since 27 Oct 2026 the **standard check before a PR and the standard APK build run in Docker** (`Dockerfile`), with one pinned toolchain: Node 24.19.0 (`.nvmrc`), Temurin JDK 21.0.12.1, Android command-line tools 19.0 (checksum-verified), platform 36 and build-tools 35 and 36. The base images are pinned by digest. The same build runs on this PC, another computer and in CI. CI runs only for releases: `release.yml` builds, checks and publishes the signed release when `develop` is merged into `master` (section 6). PRs run nothing in CI, so run `npm run docker:test` before merging.

| Command (or VS Code task) | Does | Time |
|---|---|---|
| `npm run docker:test` (*Docker: test*) | `npm ci`, the health checks (format, lint, types, duplicates, every Node test), web build, in Linux | about 30 s once cached |
| `npm run docker:apk` (*Docker: build debug APK*) | the above, then the Android project (`cap add`, hardening, `cap sync`) and `gradlew assembleDebug`; writes `out/app-debug.apk` (git-ignored) | about 3 min the first time on this PC (SDK download, Gradle), less after |
| `npm run docker:release` | the signed release APK, checked in the build; writes `out/app-release.apk` (section 6) | about 1.5 min once the SDK is cached |

`.dockerignore` keeps `.env`, `imports/` and local databases out of the build context, so no key or health data can end up in an image layer; `tests/docker.test.ts` checks that, the digest pins, the checksum, and that the versions match `.nvmrc` and this page. When a version changes (Node, JDK, SDK), change it in `Dockerfile` and here in the same commit, and refresh the digest with `docker pull <image>` and `docker image inspect <image> --format "{{index .RepoDigests 0}}"`.

**Still native, on purpose:** day-to-day development (`npm run dev`, `npm test` in watch-free runs, VS Code), the emulator and the phone. The Android emulator needs hardware virtualization and the GPU; Docker Desktop runs containers in a WSL 2 VM without nested KVM, so an emulator in a container does not start or is unusably slow, and a USB phone is awkward to reach from a container. Install the APK from Docker on the emulator with `adb install -r out/app-debug.apk`. Docker builds sign with a debug key made once and kept in a named build cache (`health-debug-key`), so each new Docker APK updates the last one; it is not the key of the native Gradle build, so switching between the two needs an uninstall (`npm run test:device -- --install <apk> --fresh` does that). `docker build --no-cache` (or `docker builder prune`) makes a new key.

**Docker Desktop on this PC:** if `docker version` shows no server, or the backend log (`%LOCALAPPDATA%\Docker\log\host\com.docker.backend*.log`) repeats "connect tcp 192.168.65.7:2375: no route to host", the engine VM lost its network: quit Docker Desktop, run `wsl --terminate docker-desktop`, and start it again (seen on 27 Oct 2026).

## 4b. Sync environment: Postgres, the sync server, the web app

Since 28 Oct 2026 (phase 2, for 0.4; decisions in [architecture.md section 6](architecture.md#6-phase-2-server-sync-web)), `docker-compose.yml` runs the server side on this PC, as it will later run for free on Vercel and Neon:

| Container | What | Here | Later, free |
|---|---|---|---|
| `db` | Postgres 17, volume `even_db-data` | `127.0.0.1:5432`, user and database `even` | Neon free plan (Vercel's Neon integration sets `DATABASE_URL`) |
| `sync` | the sync API (`server/`, Dockerfile target `sync`): accounts, devices, pairing, sync, friends; migrates the database at start | `http://127.0.0.1:8787` (`/health`, `/v1/...`) | the Vercel function `api/index.ts` |
| `web` | the web app (target `web`), its database in the browser (sql.js, sealed in IndexedDB); `/v1` goes on to `sync` | `http://127.0.0.1:4173` | Vercel static hosting (`vercel.json`, `dist/`) |

| Command | Does |
|---|---|
| `npm run docker:up` | builds and starts all three, waits until each is healthy |
| `docker compose run --rm sync npm run test:sync` | the end-to-end check: two throwaway devices, two fresh phone databases, a write and an edit synced both ways through the real server, then cleanup (CI job *Sync environment* runs it on every PR) |
| `docker compose run --rm sync npm run sync:invite -- --email you@example.com` | an invite code for one account, printed once (14 days); the account is then made in the app or on the web ([users.md](users.md) section 2.1) |
| `docker compose run --rm sync npm run sync:accounts` | accounts with device counts and storage; no data |
| `docker compose run --rm sync npm run sync:admin -- --email you@example.com` | makes that account an admin (`--remove` takes it away): Settings > Admin then appears on its devices. Only the CLI grants admin |
| `npm run sync:phone -- --db out/phone-a.sqlite` | a phone database on the PC (node:sqlite, the app's migrations and sync code) synced with the server, signed in with `SYNC_EMAIL` and `SYNC_PASSPHRASE` from `.env` |
| `npm run docker:down` | stops everything; the database stays in its volume (`docker compose down -v` wipes it) |

**Without Docker** (Docker Desktop's engine would not start on this PC on 28 Oct 2026): `npm run dev:web` runs the sync server on :8787 and the web app on http://localhost:5173 (Vite sends `/v1` to the server, as Vercel does). With no `DATABASE_URL` the server uses PGlite, real Postgres in WebAssembly, saved in `.data/pglite` (git-ignored); `npm run sync:invite -- --email ...` works on it too, with the dev server stopped (one process at a time). With `DATABASE_URL` it uses that Postgres. `npm test` covers the server without Docker as well: `tests/users.test.ts` and `tests/cloudSync.test.ts` run the real Hono app on in-memory PGlite.

**On the phone**, Settings > Sync & devices takes the server address (`VITE_SYNC_URL` at build time fills it in). The emulator reaches this PC at `http://10.0.2.2:8787`. Android blocks plain HTTP by default (targetSdk 28+, and the app does not turn cleartext on), so expect that address to be refused until a debug-only network security config allows it; a real phone uses the Vercel HTTPS address (typed with or without `https://`).

**The admin MCP server** ([users.md section 9](users.md#9-the-admin-mcp-server-decided-28-oct-2026)) is at `/mcp` on the sync server. Locally, with `npm run dev:web` running: `claude mcp add --transport http even-admin http://localhost:8787/mcp` in Claude Code, then sign in with an admin account's email and passphrase (`npm run sync:admin` first). claude.ai needs the deployed, public address.

**Deploying to Vercel** (done for 0.4; the steps, for a new project): import the repo in Vercel (Hobby plan), add the Neon integration (free plan) so `DATABASE_URL` is set, deploy. `npm run vercel-build` applies `server/migrations` and builds the web app; `vercel.json` rewrites `/v1/*`, `/health`, `/mcp`, `/oauth/*` and the OAuth `/.well-known/*` paths to the one function `api/index.ts`, with the original path in `__path` (`server/vercelPath.ts` puts it back). Relative imports under `server/` and `api/` name `.js` files, or the function fails with `ERR_MODULE_NOT_FOUND` (`tests/vercelFunction.test.ts` catches it). Set `SERVER_SECRET` (a long random string) and, to link Google accounts, `GOOGLE_CLIENT_ID` (the Web OAuth client id) in Vercel's environment. Then make invites with `DATABASE_URL=<Neon URL> npm run sync:invite -- --email ...` and check with `SYNC_URL=https://<app>.vercel.app DATABASE_URL=<Neon URL> npm run test:sync`.

## 5. Integration test on the emulator or phone

`npm run test:device` (task *Android: device integration test*) drives the installed debug build through the WebView's DevTools protocol (debug builds expose it) and checks, end to end:

1. the app opens and the encrypted database is ready;
1. the header clears a reported 48 px status bar (edge to edge, see below);
1. with `--fresh` (no key yet): the sync button (the ⟳ symbol, labelled "Set up Garmin sync") opens Settings > Connections;
2. the schema is the latest migration (Settings > About);
3. the database file has no plain SQLite header (SQLCipher);
4. the Garmin key from `GARMIN_API_KEY` in `.env` saves in Settings > Connections;
5. a real Garmin sync succeeds;
6. the app is still in front afterwards (no system screen opened, see below);
7. readings are stored (Settings > Privacy & data);
8. the dashboard's steps ring has a value;
9. the data is still there after the app is killed and reopened.

```bash
npm run test:device -- --install android/app/build/outputs/apk/debug/app-debug.apk --fresh   # first launch
npm run test:device -- --serial emulator-5554 --skip-sync --out shots                         # no Garmin call
```

It prints check names and counts, never the key or health values; screenshots of each step (which do show health values) go to `--out`, default a temp folder. Without `GARMIN_API_KEY` the sync checks are skipped.

**Galaxy S23 emulator.** The AVD `Galaxy_S23_API_36` copies the Pixel 8 AVD with the S23's screen: 1080 x 2340 at density 420 (the S23's 6.1" panel is about 425 ppi), Android 16 (API 36, One UI 8 on the real phone), 4 GB RAM, host GPU. Its `config.ini` sets `hw.device.name=galaxy_s23`, `hw.lcd.width=1080`, `hw.lcd.height=2340`, `hw.lcd.density=420`, `showDeviceFrame=no`. Start it with the task *Android: start emulator* (name `Galaxy_S23_API_36`) or the emulator extension. It is not Samsung's One UI: Samsung-specific behaviour (battery optimisation, Secure Folder, One UI permission screens) still needs the real phone.

**Edge to edge.** Android 15+ draws the app under the status and navigation bars. With WebView 140 or newer (current phones, updated from the Play Store) Capacitor leaves the bars over the page and reports their size as `env(safe-area-inset-*)` and `--safe-area-inset-*`; with an older WebView it pads the app natively and both read 0. The CSS takes the larger (`--safe-top`, `--safe-bottom` in `src/shell/styles.css`). The API 36 emulator image ships WebView 133, so it never shows the edge-to-edge case: the device test reports a 48 px bar itself and measures the header. Found on the real S23 on 27 Oct 2026, where the title ran into the clock.

First run (27 Oct 2026, `develop` at the merge of PR #21): 9/9 checks on `Galaxy_S23_API_36`, a real sync of 924 readings. It found that scheduling the 3-day reminder opened Android's *Alarms & reminders* screen after every sync (the notifications plugin asks for exact alarms by default, which Android 14+ does not grant); the reminder now asks for an inexact alarm (`pluginNotification` in `src/core/notifier.ts`) and check 6 guards it.

## 6. Releases

A release is a merge of `develop` into `master`. The push to `master` runs `.github/workflows/release.yml`:

1. **Version gate.** The version is `package.json`'s. If the tag `v<version>` already exists, the release stops: bump the version on `develop` first (a PR like any other change).
2. **Build.** `docker build --target release-apk`, the same as `npm run docker:release` here. It is signed with the release key, which reaches the build only as BuildKit secrets, and it is checked inside the build (`scripts/release-check.mjs`):
   - signed (v2/v3) with the key whose SHA-256 is in `release/cert-sha256.txt`, and not with a debug key;
   - package `app.health.personal`, with `versionName` and `versionCode` matching `package.json`;
   - not debuggable;
   - min SDK 24 and target SDK 36;
   - Android backups off;
   - the web app inside.
3. **Publish.** `gh release create v<version>` tags the merge commit and publishes a GitHub release. It attaches `even-v<version>.apk` and its `.sha256`, with notes generated from the merged PRs.

PRs (to `develop` or `master`) run nothing in CI (removed 30 Oct 2026 to save Actions minutes, along with the release emulator check); test locally with `npm run docker:test`. The emulator check can still be run locally with `node scripts/release-check.mjs --device`. `develop` is the repo's default branch, so GitHub never deletes it when it is merged into `master`, even with "delete head branches" on.

**Version code.** `versionCode` comes from the version: `MAJOR*10000 + MINOR*100 + PATCH`, so 0.1.0 is 100. Android only installs an update with a higher code, so versions only go up, and minor and patch stay below 100 (`scripts/android-gradle.mjs`, tested).

**The release key** was made on 27 Oct 2026. It is RSA 4096, alias `health`, PKCS12, valid 30 years. It lives outside the repo:
- `%USERPROFILE%\.android\health-release\health-release.jks`, the keystore;
- `%USERPROFILE%\.android\health-release\health-release.env`, with `HEALTH_KEYSTORE`, `HEALTH_KEYSTORE_PASSWORD`, `HEALTH_KEY_ALIAS` and `HEALTH_KEY_PASSWORD`.

**Back both files up somewhere safe**, such as a password manager. Every update to an installed app must be signed with the same key. If the key is lost, the phone can only get a new install, and a new install starts with empty data unless you restore a backup. `*.jks` and `*.keystore` are ignored by git and Docker.

**GitHub secrets** (Settings > Secrets and variables > Actions), set once from the files above:

```bash
base64 -w0 ~/.android/health-release/health-release.jks | gh secret set HEALTH_KEYSTORE_BASE64
for k in HEALTH_KEYSTORE_PASSWORD HEALTH_KEY_ALIAS HEALTH_KEY_PASSWORD; do
  grep "^$k=" ~/.android/health-release/health-release.env | cut -d= -f2- | tr -d '\r\n' | gh secret set $k
done
```

**Local release** (the same build as CI): `npm run docker:release` writes `out/app-release.apk`. `npm run release:check -- --apk out/app-release.apk --device` checks it and installs it on the running emulator or phone. A release build has no WebView debugging, so the deeper checks (sync, database) are `npm run test:device` on a debug build of the same commit.

First release build (27 Oct 2026, 0.1.0): 81 s in Docker; release check 9/9 on the Galaxy S23 emulator; the image holds no secret files or variables, and the password is in neither the files nor the layer history.

## 7. iOS

**Parked (28 Oct 2026):** iOS is a later phase, so the workflow lives in `scripts/ci/ios.yml`, where GitHub does not run it. To bring it back, move it to `.github/workflows/ios.yml`, update the check in `tests/ios.test.ts`, and add `src/apps/ios/` with its Vite mode ([phases.md](phases.md)). Nothing iOS blocks a PR meanwhile; the iOS scripts, `@capacitor/ios` and the Apple Health code stay, unused. The rest of this section describes it as it runs from there.

iOS builds need macOS with Xcode, so on this Windows PC they run on GitHub's Macs: `.github/workflows/ios.yml` (macOS 15, the runner's default Xcode). It runs on demand (Actions > iOS > Run workflow, once the workflow is on `master`) and on PRs to `develop` or `master` that touch the native side (`package.json`, `capacitor.config.json`, `resources/`, `src/platform/`, the palette, the iOS scripts). The repo is private, so macOS minutes count 10x against the plan's allowance; pure web changes do not trigger it.

The run:

1. builds the web app, generates `ios/` with `npx cap add ios --packagemanager SPM` (Swift Package Manager, no CocoaPods; every plugin ships a `Package.swift`), applies `scripts/ios-harden.mjs` and syncs;
2. compiles for the simulator (Debug) and for devices (Release, `generic/platform=iOS`, unsigned);
3. runs `scripts/ios-sim.mjs` on an iPhone simulator with the newest iOS:
   - fresh install, light mode: the app logs `app starting` with `native: true`, creates its database secret in the Keychain, opens the encrypted database and reaches the sync check, logs no error and is still running after 20 s;
   - relaunch, Dark Mode: still no error, and the secret is not created again (the Keychain kept it);
4. uploads `ios-simulator`: a screenshot per launch, the app logs, and `Even-simulator.app.zip` (drag it onto a booted simulator on any Mac to try the build).

`ios-harden.mjs` does for `ios/` what `android-harden.mjs` does for `android/`: `MARKETING_VERSION` from `package.json` and `CURRENT_PROJECT_VERSION` equal to Android's `versionCode`, the name from `capacitor.config.json`, the app icon and launch logo from `resources/ios/`, and a launch screen with the logo on the palette's `--bg` (a `LaunchBackground` color with a Dark Mode value). `resources/ios/AppIcon-1024.png` (opaque, full bleed: iOS rounds it) and `Splash.png` (120 pt @3x) are rendered from `resources/logo.svg` by `npm run ios:icons` with Chrome or Edge; run it after changing the logo.

On a Mac: `npm ci`, `npx cap add ios --packagemanager SPM`, `npm run ios:sync`, then `npx cap open ios` (Xcode) or `npx cap run ios`. To check a simulator build the way CI does: `node scripts/ios-sim.mjs --app <App.app>`.

**Apple Health.** Settings > Connections > Apple Health asks iOS for read access; after that every sync also reads the recent days from HealthKit. `ios-harden.mjs` adds the HealthKit entitlement (`App/App.entitlements`) and the request text (`NSHealthShareUsageDescription`), and the simulator check fails if the built app lacks either. The simulator cannot press "Allow" on the permission sheet, so reading real Health data has to be checked on an iPhone. Installing on one with HealthKit needs signing: a paid Apple Developer account works; a free Apple ID personal team may not offer the HealthKit capability.

**Not yet on iOS:**
- **Installing on an iPhone** needs signing with an Apple Developer account (99 USD a year), plus TestFlight or a registered device. The device build in CI is unsigned and proves only that it compiles.
- **Google sign-in** is hidden on iOS (`googleSignInAvailable`) until there is an iOS OAuth client and its URL scheme in `Info.plist`.
- **iCloud backup.** The database lives in the app's Library folder, which iOS backs up. It is SQLCipher-encrypted, but Android turns backups off entirely, so iOS should exclude it from backup too.
