# Developer setup (Windows, VS Code, Android)

Everything installs per user, under `%LOCALAPPDATA%`; no Android Studio needed. Checked on 26 Oct 2026 with Windows 11, VS Code, Node 24.

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

Debugging the WebView: with the app running on the emulator or a USB phone, open `chrome://inspect` in Chrome or Edge and click *inspect* under `app.health.personal`. Settings > Logs in the app shows the app's own log records.

A phone instead of the emulator: enable Developer options > USB debugging, plug it in, accept the prompt, and `adb devices` lists it. The run task then offers it.

## 3. Daily loop

1. `npm run dev` for screens that do not need the database (the browser build has no SQLite).
2. `npm test` for logic: everything except `src/platform/` runs in Node.
3. "Android: run on emulator or phone" to try it for real, `chrome://inspect` to debug.

## 4. Docker: when it helps and when it does not

**Not for the emulator or day-to-day work.** The Android emulator needs hardware virtualization and the GPU. Docker Desktop on Windows runs containers inside a WSL 2 VM with no nested KVM, so an emulator in a container either does not start or is unusably slow, and reaching a USB phone from a container is awkward. This project also has no servers or databases to run: the data lives in SQLite on the phone, and tests use Node's built-in SQLite. A container would add a layer between VS Code and the tools without removing any.

**Useful for repeatable builds.** One image pins Node 24, JDK 21 and the exact SDK packages, so a release APK or the test suite builds the same on any machine, a new laptop, or CI, without this page's setup. The shape of it:

```dockerfile
# Dockerfile.android (sketch)
FROM eclipse-temurin:21-jdk
RUN apt-get update && apt-get install -y curl unzip git && curl -fsSL https://deb.nodesource.com/setup_24.x | bash - && apt-get install -y nodejs
ENV ANDROID_HOME=/opt/android-sdk
# download the command-line tools zip, then install the same packages as section 1, minus emulator and system image
WORKDIR /app
```

```powershell
docker build -f Dockerfile.android -t health-android .
docker run --rm -v ${PWD}:/app -v health-node-modules:/app/node_modules health-android bash -c "npm ci && npm test && npm run android:sync && cd android && ./gradlew assembleDebug"
```

The named volume for `node_modules` matters: Windows bind mounts are slow for thousands of small files, and Linux-built native modules must not mix with the Windows ones.

**Recommendation:** develop natively as set up above. Add Docker, or simply a GitHub Actions workflow (its runners already have the Android SDK and Java), when there is a need for CI or signed release builds that do not depend on this PC. A VS Code Dev Container is only worth it to work on the TypeScript code from another computer without installing Node; Android builds and the emulator stay on the host either way.
