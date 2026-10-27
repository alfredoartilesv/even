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
4. Before a PR: `npm run docker:test` (CI runs the same), and `npm run test:device` on the emulator when a change touches the phone side.

## 4. Docker: the standard test and build

Since 27 Oct 2026 the **standard check before a PR and the standard APK build run in Docker** (`Dockerfile`), with one pinned toolchain: Node 24.19.0 (`.nvmrc`), Temurin JDK 21.0.12.1, Android command-line tools 19.0 (checksum-verified), platform 36 and build-tools 35 and 36. The base images are pinned by digest. The same build runs on this PC, another computer and in CI: `.github/workflows/ci.yml` runs the test stage on every PR (no APK), and `release.yml` builds, checks and publishes the signed release when `develop` is merged into `master` (section 6).

| Command (or VS Code task) | Does | Time |
|---|---|---|
| `npm run docker:test` (*Docker: test*) | `npm ci`, typecheck, every Node test, web build, in Linux | about 20 s once cached |
| `npm run docker:apk` (*Docker: build debug APK*) | the above, then the Android project (`cap add`, hardening, `cap sync`) and `gradlew assembleDebug`; writes `out/app-debug.apk` (git-ignored) | about 3 min the first time on this PC (SDK download, Gradle), less after |
| `npm run docker:release` | the signed release APK, checked in the build; writes `out/app-release.apk` (section 6) | about 1.5 min once the SDK is cached |

`.dockerignore` keeps `.env`, `imports/` and local databases out of the build context, so no key or health data can end up in an image layer; `tests/docker.test.ts` checks that, the digest pins, the checksum, and that the versions match `.nvmrc` and this page. When a version changes (Node, JDK, SDK), change it in `Dockerfile` and here in the same commit, and refresh the digest with `docker pull <image>` and `docker image inspect <image> --format "{{index .RepoDigests 0}}"`.

**Still native, on purpose:** day-to-day development (`npm run dev`, `npm test` in watch-free runs, VS Code), the emulator and the phone. The Android emulator needs hardware virtualization and the GPU; Docker Desktop runs containers in a WSL 2 VM without nested KVM, so an emulator in a container does not start or is unusably slow, and a USB phone is awkward to reach from a container. Install the APK from Docker on the emulator with `adb install -r out/app-debug.apk`. Docker builds sign with a debug key made once and kept in a named build cache (`health-debug-key`), so each new Docker APK updates the last one; it is not the key of the native Gradle build, so switching between the two needs an uninstall (`npm run test:device -- --install <apk> --fresh` does that). `docker build --no-cache` (or `docker builder prune`) makes a new key.

**Docker Desktop on this PC:** if `docker version` shows no server, or the backend log (`%LOCALAPPDATA%\Docker\log\host\com.docker.backend*.log`) repeats "connect tcp 192.168.65.7:2375: no route to host", the engine VM lost its network: quit Docker Desktop, run `wsl --terminate docker-desktop`, and start it again (seen on 27 Oct 2026).

## 5. Integration test on the emulator or phone

`npm run test:device` (task *Android: device integration test*) drives the installed debug build through the WebView's DevTools protocol (debug builds expose it) and checks, end to end:

1. the app opens and the encrypted database is ready;
1. the header clears a reported 48 px status bar (edge to edge, see below);
1. with `--fresh` (no key yet): the sync button says "Set up sync" and opens Settings > Connections;
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

**Edge to edge.** Android 15+ draws the app under the status and navigation bars. With WebView 140 or newer (current phones, updated from the Play Store) Capacitor leaves the bars over the page and reports their size as `env(safe-area-inset-*)` and `--safe-area-inset-*`; with an older WebView it pads the app natively and both read 0. The CSS takes the larger (`--safe-top`, `--safe-bottom` in `src/app/styles.css`). The API 36 emulator image ships WebView 133, so it never shows the edge-to-edge case: the device test reports a 48 px bar itself and measures the header. Found on the real S23 on 27 Oct 2026, where the title ran into the clock.

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
3. **Emulator.** An Android 15 emulator on the runner gets a clean install, then the check confirms the app launches, stays alive and in front, and leaves nothing in the crash log. A screenshot is kept as an artifact.
4. **Publish.** `gh release create v<version>` tags the merge commit and publishes a GitHub release. It attaches `health-v<version>.apk` and its `.sha256`, with notes generated from the merged PRs.

PRs (to `develop` or `master`) only run the tests, with no APK (`ci.yml`). `develop` is the repo's default branch, so GitHub never deletes it when it is merged into `master`, even with "delete head branches" on.

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
