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
import { loadGarminKey } from "../features/settings/secrets";
import { secretStore } from "../platform/secureStore";
import { GARMIN_SOURCE, GarminApi, GarminSource } from "../features/sync/garmin";
import { lastSync, runSync, type LastSync } from "../features/sync/runSync";
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
  const [profileOpen, setProfileOpen] = useState(false);
  const [mealPrepView, setMealPrepView] = useState<MealPrepView>("log");
  const [settingsPage, setSettingsPage] = useState<SettingsPage>("profile");
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
    const isConfigured = Boolean(await loadGarminKey(secretStore));
    setConfigured(isConfigured);
    setStatus(await lastSync(db, GARMIN_SOURCE));
    setNow(Date.now());
    await refreshSyncReminder(db, notifier, { configured: isConfigured, source: GARMIN_SOURCE });
  }, [db]);

  const sync = useCallback(async () => {
    if (!db) return;
    const apiKey = await loadGarminKey(secretStore);
    setConfigured(Boolean(apiKey));
    if (!apiKey) return log.info("sync skipped: Garmin not configured");
    setSyncing(true);
    try {
      // Native HTTP on the phone: no WebView CORS in the way.
      const api = new GarminApi({ apiKey, fetch: deviceFetch({ connectTimeoutMs: 15_000, readTimeoutMs: 30_000 }) });
      const source = new GarminSource({ api });
      await runSync(db, source); // never throws; the outcome is in sync_runs
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

  // Back in front after a while (the app can sit in memory for days): sync again.
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      setNow(Date.now());
      const lastOk = status?.lastOkMs ?? 0;
      if (configured && !syncing && Date.now() - lastOk > RESYNC_ON_RESUME_MS) {
        log.info("app resumed, syncing", { sinceLastOkMin: lastOk ? Math.round((Date.now() - lastOk) / 60_000) : null });
        void sync();
      }
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [configured, syncing, status, sync]);

  // Sync on open, so the latest Garmin day is there when the app is.
  useEffect(() => {
    if (!db || autoSynced.current) return;
    autoSynced.current = true;
    void refreshStatus().then(sync);
  }, [db, sync, refreshStatus]);

  if (dbStatus.state !== "ready") {
    return (
      <main className="shell">
        <PageHeader title="Health" />
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
  const openSettings = (page: SettingsPage) => {
    setSettingsPage(page);
    setTab("settings");
  };
  const syncButton = <SyncButton status={status} configured={configured} syncing={syncing} nowMs={now} onSync={() => void sync()} />;

  return (
    <>
      <main className="shell with-tabbar">
        <SyncBanner status={status} configured={configured} syncing={syncing} nowMs={now} onSync={() => void sync()} />
        {tab === "dashboard" ? (
          !profileOpen ? (
            <DashboardScreen
              db={ready}
              version={version}
              configured={configured}
              syncWarnings={status?.warnings ?? []}
              profile={<ProfileButton db={ready} version={version} onOpen={() => setProfileOpen(true)} />}
              sync={syncButton}
              onLogFood={() => {
                setMealPrepView("log");
                setTab("mealprep");
              }}
            />
          ) : (
            <section>
              <PageHeader title="Profile" onBack={() => setProfileOpen(false)} backLabel="Dashboard" />
              <MeScreen db={ready} version={version} onEditProfile={() => openSettings("profile")} />
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
      </main>
      <TabBar
        tab={tab}
        onTab={(t) => {
          // Tapping Dashboard again closes the profile.
          if (t === "dashboard") setProfileOpen(false);
          setTab(t);
          window.scrollTo(0, 0);
        }}
      />
    </>
  );
}
