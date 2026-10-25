import { useCallback, useEffect, useRef, useState } from "react";
import { Capacitor, CapacitorHttp } from "@capacitor/core";
import type { SqlDriver } from "./db/driver";
import { openDatabase } from "./db/open";
import { SettingsScreen } from "./screens/SettingsScreen";
import { TodayScreen } from "./screens/TodayScreen";
import { loadFreddyCredentials } from "./settings/secrets";
import { secretStore } from "./settings/secureStore";
import { freddySource, loadTransport } from "./sync/freddyClient";
import { runSync } from "./sync/runSync";

type DbStatus = { state: "opening" } | { state: "ready"; db: SqlDriver } | { state: "error"; message: string };
type Tab = "today" | "settings";

const isNative = Capacitor.isNativePlatform();

export function App() {
  const [dbStatus, setDbStatus] = useState<DbStatus>({ state: "opening" });
  const [tab, setTab] = useState<Tab>("today");
  const [configured, setConfigured] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [version, setVersion] = useState(0);
  const autoSynced = useRef(false);

  useEffect(() => {
    openDatabase().then(
      ({ db }) => setDbStatus({ state: "ready", db }),
      (err: Error) => setDbStatus({ state: "error", message: err.message }),
    );
  }, []);

  const db = dbStatus.state === "ready" ? dbStatus.db : null;

  const sync = useCallback(async () => {
    if (!db) return;
    const creds = await loadFreddyCredentials(secretStore);
    setConfigured(Boolean(creds));
    if (!creds) return;
    setSyncing(true);
    try {
      const source = freddySource(creds, await loadTransport(db, isNative), (o) => CapacitorHttp.request(o));
      await runSync(db, source); // never throws; the outcome is in sync_runs
    } finally {
      setSyncing(false);
      setVersion((v) => v + 1);
    }
  }, [db]);

  // Sync on open: the free plan only keeps 7 days, so every launch is a chance not to lose data.
  useEffect(() => {
    if (!db || autoSynced.current) return;
    autoSynced.current = true;
    void sync();
  }, [db, sync]);

  if (dbStatus.state !== "ready") {
    return (
      <main className="shell">
        <h1>Health</h1>
        <p className={dbStatus.state === "error" ? "error" : "muted"}>
          {dbStatus.state === "opening" ? "Opening local database…" : `Database unavailable: ${dbStatus.message}`}
        </p>
      </main>
    );
  }

  return (
    <main className="shell">
      <header className="row">
        <h1>Health</h1>
        <nav className="tabs">
          <button className={tab === "today" ? "active" : ""} onClick={() => setTab("today")}>
            Today
          </button>
          <button className={tab === "settings" ? "active" : ""} onClick={() => setTab("settings")}>
            Settings
          </button>
        </nav>
      </header>
      {tab === "today" ? (
        <TodayScreen db={dbStatus.db} configured={configured} syncing={syncing} onSync={sync} version={version} />
      ) : (
        <SettingsScreen
          db={dbStatus.db}
          secrets={secretStore}
          isNative={isNative}
          onChanged={() => {
            void loadFreddyCredentials(secretStore).then((c) => setConfigured(Boolean(c)));
            setVersion((v) => v + 1);
          }}
        />
      )}
    </main>
  );
}
