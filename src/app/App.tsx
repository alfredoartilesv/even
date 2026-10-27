import { useCallback, useEffect, useRef, useState } from "react";
import { deviceFetch, isNative } from "../platform/device";
import type { SqlDriver } from "../db/driver";
import { openDatabase } from "../platform/openDatabase";
import { AlcoholScreen } from "../features/alcohol/ui/AlcoholScreen";
import { ChatScreen } from "../features/chat/ui/ChatScreen";
import { DashboardScreen } from "../features/dashboard/DashboardScreen";
import { MealPrepScreen, type MealPrepView } from "../features/mealprep/ui/MealPrepScreen";
import { SettingsScreen, type SettingsPage } from "../features/settings/SettingsScreen";
import { LogsScreen } from "../features/logs/LogsScreen";
import { MeScreen } from "../features/me/MeScreen";
import { ProfileButton } from "../features/dashboard/ProfileButton";
import { JournalScreen, type JournalView } from "../features/journal/ui/JournalScreen";
import { loadGarminKey, removeLegacySecrets } from "../features/settings/secrets";
import { secretStore } from "../platform/secureStore";
import { GARMIN_SOURCE, GarminApi, GarminSource } from "../features/sync/garmin";
import { combineSyncs, lastSync, runSync, type LastSync } from "../features/sync/runSync";
import { APPLE_HEALTH_SOURCE, AppleHealthSource, appleHealthEnabled } from "../features/sync/appleHealth";
import { appleHealthSupported, healthStore } from "../platform/health";
import { refreshSyncReminder, RESYNC_ON_RESUME_MS } from "../features/sync/reminder";
import { SyncBanner, SyncButton } from "../features/sync/SyncStatus";
import { notifier } from "../platform/notifications";
import { applyStoredLogLevel } from "../features/settings/logLevel";
import { createLogger } from "../core/log";
import { DEFAULT_LOG_LEVEL } from "./logging";
import { TabBar, type Tab } from "./TabBar";
import { PageHeader } from "../ui/layout";
import "../ui/ui.css";

type DbStatus = { state: "opening" } | { state: "ready"; db: SqlDriver } | { state: "error"; message: string };

const log = createLogger("app");

export function App() {
  const [dbStatus, setDbStatus] = useState<DbStatus>({ state: "opening" });
  const [tab, setTab] = useState<Tab>("dashboard");
  // The profile opens over the Dashboard, with a way back.
  // A page over the Dashboard (the profile or the journal), with a way back.
  const [overlay, setOverlay] = useState<{ page: "profile" } | { page: "journal"; view: JournalView; day?: string } | null>(null);
  const [mealPrepView, setMealPrepView] = useState<MealPrepView>("log");
  const [settingsPage, setSettingsPage] = useState<SettingsPage | null>(null);
  const [configured, setConfigured] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [version, setVersion] = useState(0);
  const [status, setStatus] = useState<LastSync | null>(null);
  const [now, setNow] = useState(Date.now());
  const autoSynced = useRef(false);

  useEffect(() => {
    openDatabase().then(
      async ({ db }) => {
        await applyStoredLogLevel(db, DEFAULT_LOG_LEVEL);
        void removeLegacySecrets(secretStore).catch((err) => log.warn("old secrets not removed", { err }));
        setDbStatus({ state: "ready", db });
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
    setConfigured(garmin || apple);
    setStatus(combineSyncs([garmin ? await lastSync(db, GARMIN_SOURCE) : null, apple ? await lastSync(db, APPLE_HEALTH_SOURCE) : null]));
    setNow(Date.now());
    // The reminder is about the Garmin key expiring; Apple Health has no key.
    await refreshSyncReminder(db, notifier, { configured: garmin, source: GARMIN_SOURCE });
  }, [db]);

  const sync = useCallback(async () => {
    if (!db) return;
    const apiKey = await loadGarminKey(secretStore);
    const apple = appleHealthSupported && (await appleHealthEnabled(db));
    setConfigured(Boolean(apiKey) || apple);
    if (!apiKey) log.info("sync skipped: Garmin not configured");
    if (!apiKey && !apple) return;
    setSyncing(true);
    try {
      // runSync never throws; each outcome is in sync_runs.
      if (apiKey) {
        // Native HTTP on the phone: no WebView CORS in the way.
        const api = new GarminApi({ apiKey, fetch: deviceFetch({ connectTimeoutMs: 15_000, readTimeoutMs: 30_000 }) });
        await runSync(db, new GarminSource({ api }));
      }
      if (apple) await runSync(db, new AppleHealthSource({ store: healthStore }));
    } finally {
      setSyncing(false);
      setVersion((v) => v + 1);
      await refreshStatus();
    }
  }, [db, refreshStatus]);

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
    if (!db || autoSynced.current) return;
    autoSynced.current = true;
    void refreshStatus().then(sync);
  }, [db, sync, refreshStatus]);

  if (dbStatus.state !== "ready") {
    return (
      <main className="shell">
        <PageHeader title="Even" />
        <p className={dbStatus.state === "error" ? "error" : "muted"}>
          {dbStatus.state === "opening" ? "Opening local database…" : `Database unavailable: ${dbStatus.message}`}
        </p>
        {dbStatus.state === "error" && (
          <>
            <h2>Logs</h2>
            <LogsScreen db={null} />
          </>
        )}
      </main>
    );
  }

  const ready = dbStatus.db;
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
  const screenKey = tab === "dashboard" ? `dashboard|${overlay?.page ?? ""}|${overlay?.page === "journal" ? overlay.view : ""}` : tab === "settings" ? `settings|${settingsPage}` : tab === "mealprep" ? `mealprep|${mealPrepView}` : tab;

  return (
    <>
      <main className="shell with-tabbar">
        <SyncBanner status={status} configured={configured} syncing={syncing} nowMs={now} onSync={() => void sync()} />
        <div key={screenKey} className="screen">
        {tab === "dashboard" ? (
          !overlay ? (
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
                profile: () => open({ page: "profile" }),
                checkIn: (day) => open({ page: "journal", view: "checkin", day }),
                measurements: () => open({ page: "journal", view: "measurements" }),
              }}
            />
          ) : (
            <section>
              <PageHeader title={overlay.page === "profile" ? "Profile" : "Journal"} onBack={() => setOverlay(null)} backLabel="Dashboard" />
              {overlay.page === "profile" ? (
                <MeScreen db={ready} version={version} onEditProfile={() => openSettings("profile")} />
              ) : (
                <JournalScreen db={ready} version={version} view={overlay.view} initialDay={overlay.day} onView={(view) => setOverlay({ page: "journal", view })} onChanged={changed} />
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
            page={settingsPage}
            onPage={setSettingsPage}
            onChanged={() => {
              void refreshStatus();
              changed();
            }}
          />
        )}
        </div>
      </main>
      <TabBar
        tab={tab}
        onTab={(t) => {
          // Tapping a tab goes to its top level: the Dashboard closes the profile or journal, Settings shows its menu.
          if (t === "dashboard") setOverlay(null);
          if (t === "settings") setSettingsPage(null);
          go(t);
        }}
      />
    </>
  );
}
