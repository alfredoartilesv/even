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
| Docker: test, Docker: build debug APK | `npm run docker:test`, `npm run docker:apk` (section 4) |
| Android: device integration test | `npm run test:device` on the running emulator or phone (section 5) |

Debugging the WebView: with the app running on the emulator or a USB phone, open `chrome://inspect` in Chrome or Edge and click *inspect* under `app.health.personal`. Settings > Debug logs in the app shows the app's own log records.

A phone instead of the emulator: enable Developer options > USB debugging, plug it in, accept the prompt, and `adb devices` lists it. The run task then offers it.

## 3. Daily loop

1. `npm run dev` for screens that do not need the database (the browser build has no SQLite).
2. `npm test` for logic: everything except `src/platform/` runs in Node.
3. "Android: run on emulator or phone" to try it for real, `chrome://inspect` to debug.
4. Before a PR: `npm run docker:test` (CI runs the same), and `npm run test:device` on the emulator when a change touches the phone side.

## 4. Docker: the standard test and build

Since 27 Oct 2026 the **standard check before a PR and the standard APK build run in Docker** (`Dockerfile`), with one pinned toolchain: Node 24.19.0 (`.nvmrc`), Temurin JDK 21.0.12.1, Android command-line tools 19.0 (checksum-verified), platform 36 and build-tools 35 and 36. The base images are pinned by digest. The same build runs on this PC, another computer and in CI (`.github/workflows/ci.yml` on every PR and push to `develop` and `master`; the APK is kept as a build artifact for 14 days).

| Command (or VS Code task) | Does | Time |
|---|---|---|
| `npm run docker:test` (*Docker: test*) | `npm ci`, typecheck, every Node test, web build, in Linux | about 20 s once cached |
| `npm run docker:apk` (*Docker: build debug APK*) | the above, then the Android project (`cap add`, hardening, `cap sync`) and `gradlew assembleDebug`; writes `out/app-debug.apk` (git-ignored) | about 3 min the first time on this PC (SDK download, Gradle), less after |

`.dockerignore` keeps `.env`, `imports/` and local databases out of the build context, so no key or health data can end up in an image layer; `tests/docker.test.ts` checks that, the digest pins, the checksum, and that the versions match `.nvmrc` and this page. When a version changes (Node, JDK, SDK), change it in `Dockerfile` and here in the same commit, and refresh the digest with `docker pull <image>` and `docker image inspect <image> --format "{{index .RepoDigests 0}}"`.

**Still native, on purpose:** day-to-day development (`npm run dev`, `npm test` in watch-free runs, VS Code), the emulator and the phone. The Android emulator needs hardware virtualization and the GPU; Docker Desktop runs containers in a WSL 2 VM without nested KVM, so an emulator in a container does not start or is unusably slow, and a USB phone is awkward to reach from a container. Install the APK from Docker on the emulator with `adb install -r out/app-debug.apk`. Docker builds sign with a debug key made once and kept in a named build cache (`health-debug-key`), so each new Docker APK updates the last one; it is not the key of the native Gradle build, so switching between the two needs an uninstall (`npm run test:device -- --install <apk> --fresh` does that). `docker build --no-cache` (or `docker builder prune`) makes a new key.

**Docker Desktop on this PC:** if `docker version` shows no server, or the backend log (`%LOCALAPPDATA%\Docker\log\host\com.docker.backend*.log`) repeats "connect tcp 192.168.65.7:2375: no route to host", the engine VM lost its network: quit Docker Desktop, run `wsl --terminate docker-desktop`, and start it again (seen on 27 Oct 2026).

## 5. Integration test on the emulator or phone

`npm run test:device` (task *Android: device integration test*) drives the installed debug build through the WebView's DevTools protocol (debug builds expose it) and checks, end to end:

1. the app opens and the encrypted database is ready;
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

First run (27 Oct 2026, `develop` at the merge of PR #21): 9/9 checks on `Galaxy_S23_API_36`, a real sync of 924 readings. It found that scheduling the 3-day reminder opened Android's *Alarms & reminders* screen after every sync (the notifications plugin asks for exact alarms by default, which Android 14+ does not grant); the reminder now asks for an inexact alarm (`pluginNotification` in `src/core/notifier.ts`) and check 6 guards it.
