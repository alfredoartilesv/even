import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { SpeedInsights } from "@vercel/speed-insights/react";
import { Analytics } from "@vercel/analytics/react";
import { deviceFetch, garminFetch, isNative } from "../platform/device";
import type { SqlDriver } from "../db/driver";
import { openDatabase } from "../platform/openDatabase";
import { DashboardScreen } from "../screens/dashboard/DashboardScreen";
import type { MealPrepView } from "../screens/mealprep/MealPrepScreen";
import type { MeView } from "../screens/me/MeScreen";
import type { SettingsPage } from "../screens/settings/SettingsScreen";
import { ProfileButton } from "../screens/dashboard/ProfileButton";
import type { JournalView } from "../screens/journal/JournalScreen";
import { AlcoholScreen, ChatScreen, JournalScreen, LogsScreen, MealPrepScreen, MeScreen, preloadScreens, SettingsScreen } from "./screens";
import type { Target } from "./target";
import { disconnect, loadSession, type SyncSession } from "../domain/cloudsync/session";
import { today } from "../ui/common";
import { loadGarminKey, removeLegacySecrets } from "../domain/settings/secrets";
import { secretStore } from "../platform/secureStore";
import { GARMIN_SOURCE, GarminApi, GarminSource } from "../domain/sync/garmin";
import { combineSyncs, lastSync, runSync, type LastSync } from "../domain/sync/runSync";
import { APPLE_HEALTH_SOURCE, AppleHealthSource, appleHealthEnabled } from "../domain/sync/appleHealth";
import { appleHealthSupported, healthStore } from "../platform/health";
import { refreshSyncReminder, RESYNC_ON_RESUME_MS } from "../domain/sync/reminder";
import { SyncBanner, SyncButton } from "../screens/sync/SyncStatus";
import { notifier } from "../platform/notifications";
import { applyStoredLogLevel } from "../domain/settings/logLevel";
import { createLogger, recentLogs } from "../core/log";
import { throttle } from "../core/throttle";
import { persistLogs } from "../domain/logs/store";
import { DEFAULT_LOG_LEVEL } from "./logging";
import { visibleTabs, type Tab } from "./tabs";
import { chatAvailable } from "../domain/chat/mode";
import { PageHeader } from "../ui/layout";
import { PullToRefresh } from "../ui/PullToRefresh";
import "../ui/ui.css";

type DbStatus = { state: "opening" } | { state: "ready"; db: SqlDriver } | { state: "error"; message: string };

const log = createLogger("app");
/** How soon a change made here is pushed, at most. */
const PUSH_SOON_MS = 5_000;
/** How often the other devices' changes are pulled while the app stays in front, and the least time between two pulls on coming back. */
const LIGHT_PULL_EVERY_MS = 2 * 60_000;
const LIGHT_PULL_MIN_MS = 15_000;

export function App({ target }: { target: Target }) {
  const [dbStatus, setDbStatus] = useState<DbStatus>({ state: "opening" });
  const [tab, setTab] = useState<Tab>("dashboard");
  // The profile opens over the Dashboard, with a way back.
  // A page over the Dashboard (the profile or the journal), with a way back.
  const [overlay, setOverlay] = useState<{ page: "profile"; view?: MeView } | { page: "journal"; view: JournalView; day?: string } | null>(null);
  const [mealPrepView, setMealPrepView] = useState<MealPrepView>("log");
  const [settingsPage, setSettingsPage] = useState<SettingsPage | null>(null);
  const [configured, setConfigured] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [version, setVersion] = useState(0);
  // The Chat tab, once this device has its own API key saved (domain/chat/mode.ts).
  const [chatOn, setChatOn] = useState(false);
  const [status, setStatus] = useState<LastSync | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const autoSynced = useRef(false);
  // This device's sync connection (docs/users.md): undefined while it loads, null when not connected.
  const [session, setSession] = useState<SyncSession | null | undefined>(undefined);
  // What the syncs read, so a sync started right after connecting already sees the new session.
  const sessionRef = useRef<SyncSession | null>(null);

  useEffect(() => {
    openDatabase().then(
      async ({ db }) => {
        // Timing builds only (scripts/perf-device.mjs); normal builds drop this branch and the module.
        if (import.meta.env.VITE_PERF_SEED) await (await import("./perfSeed")).seedForPerf(db);
        performance.mark("even:db-open");
        // From here every record is written as it is logged, starting with those of the start-up.
        persistLogs(db, { earlier: recentLogs.records() });
        // Not awaited: the Dashboard's queries need not wait for the log level.
        void applyStoredLogLevel(db, DEFAULT_LOG_LEVEL);
        void removeLegacySecrets(secretStore).catch((err) => log.warn("old secrets not removed", { err }));
        void loadSession(secretStore).then(
          (s) => {
            sessionRef.current = s;
            setSession(s);
          },
          (err) => {
            log.warn("sync session not read", { err });
            setSession(null);
          },
        );
        setDbStatus({ state: "ready", db });
        preloadScreens();
      },
      (err: Error) => {
        log.error("database unavailable", { err });
        setDbStatus({ state: "error", message: err.message });
      },
    );
  }, []);

  const db = dbStatus.state === "ready" ? dbStatus.db : null;

  // Read again after every change, so saving or removing the key shows or hides Chat.
  useEffect(() => {
    if (db) void chatAvailable(secretStore).then(setChatOn, (err) => log.warn("Claude mode not read", { err }));
  }, [db, version]);
  useEffect(() => {
    if (!chatOn && tab === "chat") setTab("dashboard");
  }, [chatOn, tab]);

  /** Reload the header status and move the "not synced for 3 days" reminder to match. */
  const refreshStatus = useCallback(async () => {
    if (!db) return;
    const garmin = Boolean(await loadGarminKey(secretStore));
    const apple = appleHealthSupported && (await appleHealthEnabled(db));
    const connected = sessionRef.current;
    const cloud = connected ? await (await import("../domain/cloudsync/syncNow")).cloudSyncStatus(db) : null;
    setConfigured(garmin || apple || Boolean(connected));
    setStatus(combineSyncs([garmin ? await lastSync(db, GARMIN_SOURCE) : null, apple ? await lastSync(db, APPLE_HEALTH_SOURCE) : null, cloud]));
    setNow(Date.now());
    // The reminder is about the Garmin key expiring; Apple Health has no key.
    await refreshSyncReminder(db, notifier, { configured: garmin, source: GARMIN_SOURCE });
  }, [db]);

  /**
   * One sync, or settings push, at a time: a second one (Sync now during the one on open, a
   * resume) opened its transactions on the same connection as the first and failed with "Already
   * in transaction". `queue` runs them in turn; `running` lets a sync asked for during one join it.
   */
  const queue = useRef<Promise<void>>(Promise.resolve());
  const inTurn = useCallback((fn: () => Promise<void>) => (queue.current = queue.current.then(fn, fn)), []);
  const running = useRef<Promise<void> | null>(null);
  const sync = useCallback(() => {
    running.current ??= inTurn(runAll).finally(() => (running.current = null));
    return running.current;
    // runAll is redefined each render with the same db and refreshStatus.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [db, refreshStatus]);

  /** Reload the screens as a sync stores rows, so what came first is seen first; at most every 1.5 s. */
  const [show] = useState(() => throttle(() => setVersion((v) => v + 1), 1_500));

  /** A profile or photo change goes to the other devices now, not with the next sync. */
  const pushSettings = () => {
    const cloud = sessionRef.current;
    if (!db || !cloud) return;
    void inTurn(async () => {
      const { pushSettingsNow } = await import("../domain/cloudsync/syncNow");
      await pushSettingsNow(db, cloud, { fetchFn: deviceFetch({ connectTimeoutMs: 15_000, readTimeoutMs: 60_000 }) }).catch((err) =>
        log.warn("settings not sent", { err }),
      );
    });
  };

  async function runAll() {
    if (!db) return;
    const cloud = sessionRef.current;
    const apiKey = await loadGarminKey(secretStore);
    const apple = appleHealthSupported && (await appleHealthEnabled(db));
    setConfigured(Boolean(apiKey) || apple || Boolean(cloud));
    if (!apiKey) log.info("sync skipped: Garmin not configured");
    if (!apiKey && !apple && !cloud) return;
    setSyncing(true);
    const fetchFn = deviceFetch({ connectTimeoutMs: 15_000, readTimeoutMs: 60_000 });
    try {
      const cloudSync = cloud ? await import("../domain/cloudsync/syncNow") : null;
      // First what the other devices wrote: settings, then rows newest first, shown as they come.
      if (cloud && cloudSync) await cloudSync.pullFirst(db, cloud, { fetchFn, onProgress: show }).catch((err) => log.warn("cloud pull failed", { err }));
      // runSync never throws; each outcome is in sync_runs.
      if (apiKey) {
        // Native HTTP on the phone; the sync server's relay in the browser (no CORS from Garmin).
        const api = new GarminApi({ apiKey, fetch: garminFetch(cloud, { connectTimeoutMs: 15_000, readTimeoutMs: 30_000 }) });
        if ((await runSync(db, new GarminSource({ api }))).samplesWritten > 0) show();
      }
      if (apple && (await runSync(db, new AppleHealthSource({ store: healthStore }))).samplesWritten > 0) show();
      // Last, so what Garmin just brought in goes up in the same sync. A failure is kept for Settings > Sync.
      if (cloud && cloudSync) {
        await cloudSync.syncNow(db, cloud, { fetchFn, today: today(), onProgress: show }).catch((err) => log.warn("cloud sync failed", { err }));
      }
    } finally {
      setSyncing(false);
      setVersion((v) => v + 1);
      await refreshStatus();
    }
  }

  // Keep "Synced 5 min ago" current.
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(t);
  }, []);

  // Back in front (the app can sit in memory for days): reload the screen, and sync again after a while.
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      // A new render also moves the Dashboard to a new day; the version makes every screen reload.
      setNow(Date.now());
      setVersion((v) => v + 1);
      const lastOk = status?.lastOkMs ?? 0;
      if (configured && !syncing && Date.now() - lastOk > RESYNC_ON_RESUME_MS) {
        log.info("app resumed, syncing", { sinceLastOkMin: lastOk ? Math.round((Date.now() - lastOk) / 60_000) : null });
        void sync();
      }
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [configured, syncing, status, sync]);

  /**
   * Between full syncs (on open, and an hour after the last one), keep the devices in step: what
   * changed here goes up within seconds and when the app is left, and what the others changed
   * comes down when it is back in front and every few minutes while it stays there. A delete
   * that waited for the next full sync was still shown on the other device, where the owner
   * deleted or logged it again, and it came back twice.
   */
  useEffect(() => {
    if (!db || !session) return;
    const fetchFn = deviceFetch({ connectTimeoutMs: 15_000, readTimeoutMs: 60_000 });
    let busy = false;
    let lastPullMs = Date.now();
    const light = (pull: boolean) => {
      // A full sync running or queued does both already.
      if (busy || running.current || !navigator.onLine) return;
      busy = true;
      void inTurn(async () => {
        const cloudSync = await import("../domain/cloudsync/syncNow");
        await cloudSync.pushPending(db, session, { fetchFn }).catch((err) => log.warn("changes not pushed", { err }));
        if (!pull) return;
        lastPullMs = Date.now();
        await cloudSync.pullFirst(db, session, { fetchFn, onProgress: show }).catch((err) => log.warn("cloud pull failed", { err }));
      }).finally(() => (busy = false));
    };
    const tick = setInterval(() => {
      if (document.visibilityState === "visible") light(Date.now() - lastPullMs > LIGHT_PULL_EVERY_MS);
    }, PUSH_SOON_MS);
    const onVisibility = () => {
      if (document.visibilityState === "hidden") light(false);
      else light(Date.now() - lastPullMs > LIGHT_PULL_MIN_MS);
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      clearInterval(tick);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [db, session, inTurn, show]);

  // Sync on open, so the latest day (Garmin, Apple Health) is there when the app is.
  useEffect(() => {
    if (!db || session === undefined || autoSynced.current) return;
    autoSynced.current = true;
    void refreshStatus().then(() => sync());
  }, [db, session, sync, refreshStatus]);

  // While the database opens the page stays empty, so the Dashboard is the first thing the owner sees, not a loading line.
  if (dbStatus.state === "opening") {
    return (
      <main className="shell" aria-busy="true">
        <span className="sr-only">Loading</span>
      </main>
    );
  }
  if (dbStatus.state === "error") {
    return (
      <main className="shell">
        <PageHeader title="Even" />
        <p className="error">Database unavailable: {dbStatus.message}</p>
        <Suspense>
          <h2>Logs</h2>
          <LogsScreen db={null} />
        </Suspense>
      </main>
    );
  }

  const ready = dbStatus.db;
  const connect = (s: SyncSession | null) => {
    sessionRef.current = s;
    setSession(s);
    void (s ? sync() : refreshStatus());
  };

  /** Leaves the account, as Settings > Sync does: the phone keeps its data, a browser's copy is removed. */
  const signOut = async (s: SyncSession) => {
    await disconnect(secretStore, s, { fetchFn: deviceFetch({ connectTimeoutMs: 15_000, readTimeoutMs: 60_000 }) });
    if (!isNative) return (await import("../platform/webDatabase")).forgetWebData();
    connect(null);
  };

  // A target may hold the app back, as the web app does until it is connected (apps/web).
  const gate = target.gate?.({ session, connect });
  if (gate) return gate;
  const changed = () => setVersion((v) => v + 1);
  const go = (t: Tab) => {
    setTab(t);
    window.scrollTo(0, 0);
  };
  const open = (o: NonNullable<typeof overlay>) => {
    setOverlay(o);
    window.scrollTo(0, 0);
  };
  const openSettings = (page: SettingsPage) => {
    setSettingsPage(page);
    go("settings");
  };
  const syncButton = (
    <SyncButton status={status} configured={configured} syncing={syncing} nowMs={now} onSync={() => void sync()} onSetup={() => openSettings("connections")} />
  );
  // Changes with every screen, so the new one animates in.
  const screenKey =
    tab === "dashboard"
      ? `dashboard|${overlay?.page ?? ""}|${overlay?.page === "journal" ? overlay.view : ""}`
      : tab === "settings"
        ? `settings|${settingsPage}`
        : tab === "mealprep"
          ? `mealprep|${mealPrepView}`
          : tab;

  const { Frame } = target;

  return (
    <Frame
      tab={tab}
      tabs={visibleTabs(chatOn)}
      account={session ? { email: session.email, signOut: () => signOut(session) } : null}
      onTab={(t) => {
        // A section goes to its top level: the Dashboard closes the profile or journal, Settings shows its menu.
        if (t === "dashboard") setOverlay(null);
        if (t === "settings") setSettingsPage(null);
        go(t);
      }}
    >
      {/* "wide": a wide screen may spread every page into columns (the web app's styles). */}
      <main className="shell with-nav wide">
        <SyncBanner status={status} configured={configured} syncing={syncing} nowMs={now} onSync={() => void sync()} />
        <div key={screenKey} className="screen">
          <Suspense>
            {tab === "dashboard" ? (
              !overlay ? (
                // Pulling the Dashboard down syncs, as the button does (without a Garmin key it just reloads the numbers).
                <PullToRefresh onRefresh={configured ? () => void sync() : changed} busy={syncing} label={configured ? "sync" : "refresh"}>
                  <DashboardScreen
                    db={ready}
                    version={version}
                    configured={configured}
                    syncWarnings={status?.warnings ?? []}
                    profile={<ProfileButton db={ready} version={version} onOpen={() => open({ page: "profile" })} />}
                    sync={syncButton}
                    go={{
                      logFood: () => {
                        setMealPrepView("log");
                        go("mealprep");
                      },
                      logDrink: () => go("alcohol"),
                      askClaude: chatOn ? () => go("chat") : undefined,
                      mealPrep: () => {
                        setMealPrepView("stock");
                        go("mealprep");
                      },
                      profile: () => open({ page: "profile", view: "activity" }),
                      checkIn: (day) => open({ page: "journal", view: "checkin", day }),
                      measurements: () => open({ page: "journal", view: "measurements" }),
                    }}
                  />
                </PullToRefresh>
              ) : (
                <section>
                  <PageHeader title={overlay.page === "profile" ? "Profile" : "Journal"} onBack={() => setOverlay(null)} backLabel="Dashboard" />
                  {overlay.page === "profile" ? (
                    <MeScreen db={ready} version={version} view={overlay.view} onEditProfile={() => openSettings("profile")} onChanged={changed} />
                  ) : (
                    <JournalScreen
                      db={ready}
                      version={version}
                      view={overlay.view}
                      initialDay={overlay.day}
                      onView={(view) => setOverlay({ page: "journal", view })}
                      onChanged={changed}
                    />
                  )}
                </section>
              )
            ) : tab === "chat" ? (
              <ChatScreen
                db={ready}
                secrets={secretStore}
                version={version}
                onChanged={changed}
                onConnect={() => openSettings("connections")}
                onPrivacy={() => openSettings("privacy")}
              />
            ) : tab === "mealprep" ? (
              <MealPrepScreen db={ready} view={mealPrepView} onView={setMealPrepView} version={version} onChanged={changed} />
            ) : tab === "alcohol" ? (
              <AlcoholScreen db={ready} version={version} onChanged={changed} />
            ) : (
              <SettingsScreen
                db={ready}
                secrets={secretStore}
                isNative={isNative}
                version={version}
                page={settingsPage}
                onPage={setSettingsPage}
                onChanged={() => {
                  void refreshStatus();
                  changed();
                  pushSettings();
                }}
                onSync={() => sync()}
                session={session ?? null}
                onSession={connect}
              />
            )}
          </Suspense>
        </div>
      </main>
      <SpeedInsights />
      <Analytics />
    </Frame>
  );
}
