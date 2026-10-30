import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { deviceFetch, isNative } from "../platform/device";
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
import { loadSession, type SyncSession } from "../domain/cloudsync/session";
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
import { createLogger } from "../core/log";
import { DEFAULT_LOG_LEVEL } from "./logging";
import type { Tab } from "./tabs";
import { PageHeader } from "../ui/layout";
import { PullToRefresh } from "../ui/PullToRefresh";
import "../ui/ui.css";

type DbStatus = { state: "opening" } | { state: "ready"; db: SqlDriver } | { state: "error"; message: string };

const log = createLogger("app");

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
   * Garmin and Apple Health into this device, then the cloud sync. One at a time: a second sync
   * (Sync now during the one on open, a resume) opened its transactions on the same connection as
   * the first and failed with "Already in transaction"; it now waits for the running one instead.
   */
  const running = useRef<Promise<void> | null>(null);
  const sync = useCallback(() => {
    running.current ??= runAll().finally(() => (running.current = null));
    return running.current;
    // runAll is redefined each render with the same db and refreshStatus.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [db, refreshStatus]);

  async function runAll() {
    if (!db) return;
    const cloud = sessionRef.current;
    const apiKey = await loadGarminKey(secretStore);
    const apple = appleHealthSupported && (await appleHealthEnabled(db));
    setConfigured(Boolean(apiKey) || apple || Boolean(cloud));
    if (!apiKey) log.info("sync skipped: Garmin not configured");
    if (!apiKey && !apple && !cloud) return;
    setSyncing(true);
    try {
      // runSync never throws; each outcome is in sync_runs.
      if (apiKey) {
        // Native HTTP on the phone: no WebView CORS in the way.
        const api = new GarminApi({ apiKey, fetch: deviceFetch({ connectTimeoutMs: 15_000, readTimeoutMs: 30_000 }) });
        await runSync(db, new GarminSource({ api }));
      }
      if (apple) await runSync(db, new AppleHealthSource({ store: healthStore }));
      // Last, so what Garmin just brought in goes up in the same sync. A failure is kept for Settings > Sync.
      if (cloud) {
        const { syncNow } = await import("../domain/cloudsync/syncNow");
        await syncNow(db, cloud, { fetchFn: deviceFetch({ connectTimeoutMs: 15_000, readTimeoutMs: 60_000 }), today: today() }).catch((err) =>
          log.warn("cloud sync failed", { err }),
        );
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

  // Sync on open, so the latest day (Garmin, Apple Health) is there when the app is.
  useEffect(() => {
    if (!db || session === undefined || autoSynced.current) return;
    autoSynced.current = true;
    void refreshStatus().then(() => sync());
  }, [db, session, sync, refreshStatus]);

  if (dbStatus.state !== "ready") {
    return (
      <main className="shell">
        <PageHeader title="Even" />
        <p className={dbStatus.state === "error" ? "error" : "muted"}>
          {dbStatus.state === "opening" ? "Opening local database…" : `Database unavailable: ${dbStatus.message}`}
        </p>
        {dbStatus.state === "error" && (
          <Suspense>
            <h2>Logs</h2>
            <LogsScreen db={null} />
          </Suspense>
        )}
      </main>
    );
  }

  const ready = dbStatus.db;
  const connect = (s: SyncSession | null) => {
    sessionRef.current = s;
    setSession(s);
    void (s ? sync() : refreshStatus());
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

  // Marks the page a wide screen may spread into columns (the web app's styles); other screens keep a readable width.
  const wide = tab === "dashboard" && !overlay;
  const { Frame } = target;

  return (
    <Frame
      tab={tab}
      onTab={(t) => {
        // A section goes to its top level: the Dashboard closes the profile or journal, Settings shows its menu.
        if (t === "dashboard") setOverlay(null);
        if (t === "settings") setSettingsPage(null);
        go(t);
      }}
    >
      <main className={`shell with-nav${wide ? " wide" : ""}`}>
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
                      askClaude: () => go("chat"),
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
              <ChatScreen db={ready} secrets={secretStore} version={version} onChanged={changed} onConnect={() => openSettings("connections")} />
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
                }}
                onSync={() => sync()}
                session={session ?? null}
                onSession={connect}
              />
            )}
          </Suspense>
        </div>
      </main>
    </Frame>
  );
}
