# Even: phases

Agreed 28 Oct 2026. Phase 1 is phone only and local ([architecture.md section 1](architecture.md#1-product-summary)); phase 2 adds a server and a web app ([section 6](architecture.md#6-phase-2-parking-lot-noted-not-built)). Inside phase 1 the work now goes Android first, step by step, with iOS as its own later phase.

## How the code is split for it

The UI of each platform will grow apart, so the code splits at the shell ([LLD section 1](LLD.md#1-repository-layout)):

| Shared by every target, never forked | Per target |
|---|---|
| `domain/` (logic and SQL per feature), `db/` (schema, migrations), the backup format, metric names and sources, `core/`, `ui/` (the kit), `platform/` (adapters, OS picked at runtime) | `apps/<target>/`: entry, shell, tab bar, which screens exist, and its own copy of any screen that has diverged |

`screens/` holds the screens every target uses until one diverges; a target then keeps its own version in `apps/<target>/`. A backup made on one platform restores on the other. `tests/architecture.test.ts` enforces the layers and that no target imports another; `EVEN_TARGET` in `vite.config.ts` picks the target (default `android`).

## Phase 1, Android

### Step A: structure and iOS out of CI (0.3.1), now

- Code split into `apps/android/`, `screens/`, `domain/`; moves only, no behaviour change.
- iOS workflow removed; iOS code, scripts and dependency kept, dormant ([dev-setup section 7](dev-setup.md#7-ios-later-phase)).
- **Done when:** `npm run health` green, screen captures unchanged, bundle sizes unchanged, the release workflow builds and checks 0.3.1, and 0.3.1 installs over the phone's 0.3.0 with its data intact (make a backup first).

### Step B: Android on the real phone

- `npm run test:device` on the S23, backup export, share and restore by hand, One UI battery settings ([architecture.md section 9](architecture.md#9-next-steps)).
- Chat tab on the phone: camera, consent, confirmations, undo.

### Step C: Android-specific work

What is likely to diverge first lands in `apps/android/` (or `platform/` when it is native), never in `domain/`:
- Android navigation: the system back button and predictive back across tabs and pages.
- Background sync (WorkManager) instead of only on open; the reminder stays.
- Home screen widget, notification actions.
- Health Connect as a source, if wanted: needs min SDK 26 and its own permissions (a decision for then).

A screen is copied into `apps/android/` only when Android really needs a different one; small differences stay as props on the shared screen.

### Step D: delivery (optional)

Today a release is a signed APK on GitHub, sideloaded ([dev-setup section 6](dev-setup.md#6-releases)). Play Console internal testing (AAB, Play App Signing, a second SHA-1 for Google sign-in) only when sideloading gets in the way.

## iOS phase (later)

Starts when Android is stable. Before it: an Apple Developer account (signing, HealthKit capability, TestFlight).

1. `src/apps/ios/`: start from a copy of the Android shell, then change what iOS needs (navigation, safe areas, gestures).
2. Bring CI back: restore `.github/workflows/ios.yml` and its test ([dev-setup section 7](dev-setup.md#7-ios-later-phase)); `ios:sync` builds with `EVEN_TARGET=ios`.
3. Signed builds and TestFlight; Apple Health on a real iPhone.
4. App Attest for Claude (no API key on the phone), an iOS Google OAuth client, the database excluded from iCloud backup.
5. A backup from the Android phone restores on the iPhone (the shared contract).

## Phase 2, server and web

As in [architecture.md section 6](architecture.md#6-phase-2-parking-lot-noted-not-built). The web app becomes a third target, `apps/web/`, on the same `domain/` and `db/` with SQLite WASM. Today the browser build is only a dev and test harness (`npm run dev`, `docs:screens`) and is never deployed.

## Rules for every step

- Bump `package.json` on `develop` before merging into `master`: the release stops on an already tagged version.
- A step ships as its own release and must install over the phone's current one (release key only).
- Never fork `domain/`, `db/` or the backup format per platform; a migration is shared by all targets.
