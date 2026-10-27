# syntax=docker/dockerfile:1.7
#
# The standard way to test and build the app: one pinned toolchain (Node, JDK 21, Android SDK),
# the same on this PC, another computer and CI. Development and the emulator stay native
# (docs/dev-setup.md section 4).
#
#   npm run docker:test      # health checks (format, lint, types, duplicates, tests) (docker build --target test .)
#   npm run docker:apk       # debug APK into out/app-debug.apk            (docker build --target apk --output out .)
#   npm run docker:release   # signed release APK into out/app-release.apk (target release-apk, keystore as BuildKit secrets)
#
# Stages: deps (npm ci) -> test (health checks, web build) -> android-base (SDK, android/ project)
#   -> android (debug) -> apk;  android-base -> release (signed, checked) -> release-apk.
# Base images are pinned by digest (Node 24.19.0, Temurin 21.0.12.1+1); tests/docker.test.ts keeps the versions in step with .nvmrc.

ARG NODE_VERSION=24.19.0
ARG NODE_IMAGE=node:24.19.0-bookworm-slim@sha256:a9f5f7c91a432850b2a8a7797adf5eadb6c733ceed61167806cee7ea7fbc29df
ARG JDK_IMAGE=eclipse-temurin:21-jdk-noble@sha256:ac86e53470d929299c90d00d88d914cb8194084adcfdfe9a7759040efa33ee07

# ---- Node dependencies ----
FROM ${NODE_IMAGE} AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --no-audit --no-fund

# ---- Typecheck, tests, web build ----
FROM deps AS test
COPY . .
# Formatting, lint, types (app, tests, scripts), duplicated code and every test; then the build.
RUN npm run health && npx vite build

# ---- Android SDK and the generated android/ project ----
FROM ${JDK_IMAGE} AS android-base
ARG NODE_VERSION
# Android command-line tools 19.0 (sha1 from Google's repository2-3.xml) and the SDK packages
# the app compiles against: compileSdk/targetSdk 36 (android/variables.gradle), build-tools 35
# (the Android Gradle Plugin's default) and 36.
ARG CMDLINE_TOOLS=commandlinetools-linux-13114758_latest.zip
ARG CMDLINE_TOOLS_SHA1=5fdcc763663eefb86a5b8879697aa6088b041e70
ENV ANDROID_HOME=/opt/android-sdk \
    ANDROID_SDK_ROOT=/opt/android-sdk \
    GRADLE_USER_HOME=/root/.gradle
ENV PATH=$PATH:/opt/android-sdk/cmdline-tools/latest/bin:/opt/android-sdk/platform-tools
RUN apt-get update && apt-get install -y --no-install-recommends unzip curl ca-certificates && rm -rf /var/lib/apt/lists/* \
 && curl -fsSL -o /tmp/tools.zip "https://dl.google.com/android/repository/${CMDLINE_TOOLS}" \
 && echo "${CMDLINE_TOOLS_SHA1}  /tmp/tools.zip" | sha1sum -c - \
 && mkdir -p "$ANDROID_HOME/cmdline-tools" && unzip -q /tmp/tools.zip -d /tmp/tools && mv /tmp/tools/cmdline-tools "$ANDROID_HOME/cmdline-tools/latest" && rm -rf /tmp/tools /tmp/tools.zip \
 && yes | sdkmanager --licenses > /dev/null \
 && sdkmanager --install "platform-tools" "platforms;android-36" "build-tools;35.0.0" "build-tools;36.0.0" > /dev/null
# The same Node as the test stage.
COPY --from=deps /usr/local/bin/node /usr/local/bin/node
COPY --from=deps /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -s /usr/local/lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm && ln -s /usr/local/lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx \
 && test "$(node -v)" = "v${NODE_VERSION}"
WORKDIR /app
COPY --from=test /app /app
# android/ is generated, never committed: create it, harden it (backups off, version, release
# signing from the environment), copy the web build in.
RUN npx cap add android && node scripts/android-harden.mjs && npx cap sync android

# ---- Debug APK ----
FROM android-base AS android
# The debug signing key is made once and kept in a named build cache, so every Docker build on one
# machine signs the same way and can update an installed debug build (a new key each build cannot).
# Its fingerprint is printed, to compare builds.
RUN --mount=type=cache,target=/root/.gradle --mount=type=cache,id=health-debug-key,target=/keys \
    (test -f /keys/debug.keystore || keytool -genkeypair -keystore /keys/debug.keystore -storepass android -keypass android \
       -alias androiddebugkey -keyalg RSA -keysize 2048 -validity 10000 -dname "CN=Android Debug,O=Android,C=US" 2>/dev/null) \
 && mkdir -p /root/.android && cp /keys/debug.keystore /root/.android/debug.keystore \
 && keytool -list -keystore /root/.android/debug.keystore -storepass android | grep -i "SHA-256" \
 && cd android && ./gradlew --no-daemon --console=plain assembleDebug

FROM scratch AS apk
COPY --from=android /app/android/app/build/outputs/apk/debug/app-debug.apk /app-debug.apk

# ---- Signed release APK, checked before it leaves the build ----
# The keystore and its passwords arrive as BuildKit secrets: mounted for this one step, never in a
# layer, an ENV or the build cache key. keystore_env holds HEALTH_KEYSTORE_PASSWORD, HEALTH_KEY_ALIAS
# and HEALTH_KEY_PASSWORD lines (the file scripts/docker-release.mjs and CI pass).
FROM android-base AS release
RUN --mount=type=cache,target=/root/.gradle \
    --mount=type=secret,id=keystore,target=/run/secrets/keystore.jks,required=true \
    --mount=type=secret,id=keystore_env,target=/run/secrets/keystore.env,required=true \
    set -a && . /run/secrets/keystore.env && set +a \
 && export HEALTH_KEYSTORE=/run/secrets/keystore.jks \
 && cd android && ./gradlew --no-daemon --console=plain assembleRelease \
 && cd .. && node scripts/release-check.mjs --apk android/app/build/outputs/apk/release/app-release.apk --build-tools "$ANDROID_HOME/build-tools/36.0.0"

FROM scratch AS release-apk
COPY --from=release /app/android/app/build/outputs/apk/release/app-release.apk /app-release.apk
