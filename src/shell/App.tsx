import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { SpeedInsights } from "@vercel/speed-insights/react";
import { Analytics } from "@vercel/analytics/react";
import { deviceFetch, garminFetch, isNative } from "../platform/device";
import type { SqlDriver } from "../db/driver";
import { openDatabase } from "../platform/openDatabase";
import { DashboardScreen } from "../screens/dashboard/DashboardScreen";
import type { MealPrepView } from "../screens/mealprep/MealPrepScreen";
import type { FoodView } from "../screens/food/FoodScreen";
import type { SettingsPage } from "../screens/settings/SettingsScreen";
import { ProfileButton } from "../screens/dashboard/ProfileButton";
import type { JournalView } from "../screens/journal/JournalScreen";
import { Loading } from "../screens/start/Loading";
import {
  ChatScreen,
  FirstRun,
  FoodScreen,
  TargetsPage,
  JournalScreen,
  LogsScreen,
  MealPrepScreen,
  MeScreen,
  preloadScreens,
  QuickAdd,
  QuickLog,
  SettingsScreen,
} from "./screens";
import type { AddActions, Target } from "./target";
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
import { coachOn } from "../domain/chat/mode";
import { needsFirstRun } from "../domain/settings/onboarding";
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
  const [tab, setTab] = useState<Tab>("today");
  const [foodView, setFoodView] = useState<FoodView>("log");
  const [mealPrepView, setMealPrepView] = useState<MealPrepView>("plan");
  const [journal, setJournal] = useState<{ view: JournalView; day?: string }>({ view: "checkin" });
  // Text from Today's quick add that Coach opens with, ready to send.
  const [coachDraft, setCoachDraft] = useState<string | undefined>(undefined);
  const [settingsPage, setSettingsPage] = useState<SettingsPage | null>(null);
  // First run (Connect, About you, Targets): null until it is known whether this install needs it.
  const [firstRun, setFirstRun] = useState<boolean | null>(null);
  // The Loading screen only once the start takes long enough to notice (docs/LLD.md, start-up).
  const [slowStart, setSlowStart] = useState(false);
  const [configured, setConfigured] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [version, setVersion] = useState(0);
  // Coach, once this device has its own API key saved and it is not switched off (domain/chat/mode.ts).
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

  // Read again after every change, so saving or removing the key, or the switch, shows or hides Coach.
  useEffect(() => {
    if (db) void coachOn(db, secretStore).then(setChatOn, (err) => log.warn("Claude mode not read", { err }));
  }, [db, version]);
  useEffect(() => {
    if (!chatOn && tab === "coach") setTab("today");
  }, [chatOn, tab]);
  // The open section's colour for the whole page, the page wash behind the shell included (ui/areas.css).
  useEffect(() => {
    document.body.dataset.area = firstRun || dbStatus.state !== "ready" ? "today" : tab;
  }, [tab, firstRun, dbStatus.state]);
  useEffect(() => {
    const t = setTimeout(() => setSlowStart(true), 400);
    return () => clearTimeout(t);
  }, []);
  // On the phone only: the web app's first run is its connect gate, and its data comes from the account.
  useEffect(() => {
    if (!db) return;
    if (!isNative) return setFirstRun(false);
    void needsFirstRun(db, secretStore).then(setFirstRun, (err) => {
      log.warn("first run not checked", { err });
      setFirstRun(false);
    });
  }, [db]);

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

  // While the database opens and the account is read: nothing for a quick start (Today comes up
  // directly), the Loading screen once it takes longer than about 400 ms.
  const starting = dbStatus.state === "opening" || (dbStatus.state === "ready" && (session === undefined || firstRun === null));
  if (starting) {
    if (!slowStart)
      return (
        <main className="shell" aria-busy="true">
          <span className="sr-only">Loading</span>
        </main>
      );
    return (
      <Loading
        steps={[
          { label: "Unlocking your data on this device", done: dbStatus.state === "ready" },
          { label: isNative ? "Reading your account and connections" : "Opening your account", done: dbStatus.state === "ready" && session !== undefined },
          { label: "Ready", done: false },
        ]}
      />
    );
  }
  if (dbStatus.state === "error") {
    return (
      <Loading steps={[{ label: "Unlocking your data on this device", done: false }]}>
        <section className="card loading-error" role="alert">
          <h2>Your data could not be opened</h2>
          <p className="muted">Nothing was changed or deleted. {dbStatus.message}</p>
          <Suspense>
            <h3>Logs</h3>
            <LogsScreen db={null} />
          </Suspense>
        </section>
      </Loading>
    );
  }
  if (dbStatus.state !== "ready") return null;

  const ready = dbStatus.db;
  const connect = (s: SyncSession | null) => {
    sessionRef.current = s;
    setSession(s);
    void (s ? sync() : refreshStatus());
  };

  /** Leaves the account, as You > Sync & devices does: the phone keeps its data, a browser's copy is removed. */
  const signOut = async (s: SyncSession) => {
    await disconnect(secretStore, s, { fetchFn: deviceFetch({ connectTimeoutMs: 15_000, readTimeoutMs: 60_000 }) });
    if (!isNative) return (await import("../platform/webDatabase")).forgetWebData();
    connect(null);
  };

  // A target may hold the app back, as the web app does until it is connected (apps/web).
  const gate = target.gate?.({ session, connect });
  if (gate) return gate;
  const changed = () => setVersion((v) => v + 1);

  if (firstRun) {
    return (
      <Suspense>
        <FirstRun
          db={ready}
          secrets={secretStore}
          isNative={isNative}
          session={session ?? null}
          onChanged={() => {
            void refreshStatus();
            changed();
            pushSettings();
          }}
          onConnected={() => void sync()}
          onDone={() => {
            setFirstRun(false);
            setTab("today");
            changed();
          }}
        />
      </Suspense>
    );
  }

  const go = (t: Tab) => {
    setTab(t);
    window.scrollTo(0, 0);
  };
  const openYou = (page: SettingsPage | null) => {
    setSettingsPage(page);
    go("you");
  };
  const openFood = (view: FoodView) => {
    setFoodView(view);
    go("food");
  };
  const openPrep = (view: MealPrepView) => {
    setMealPrepView(view);
    go("prep");
  };
  const openJournal = (view: JournalView, day?: string) => {
    setJournal({ view, day });
    go("journal");
  };
  const syncButton = (
    <SyncButton status={status} configured={configured} syncing={syncing} nowMs={now} onSync={() => void sync()} onSetup={() => openYou("connections")} />
  );
  // Changes with every screen, so the new one animates in.
  const screenKey =
    tab === "you"
      ? `you|${settingsPage}`
      : tab === "prep"
        ? `prep|${mealPrepView}`
        : tab === "food"
          ? `food|${foodView}`
          : tab === "journal"
            ? `journal|${journal.view}`
            : tab;

  // Coach with text to start from (quick add, Today); undefined while Coach is off.
  const askCoach = chatOn
    ? (draft?: string) => {
        setCoachDraft(draft);
        go("coach");
      }
    : undefined;
  const { Frame } = target;
  // What the phone's Add button offers (apps/android/AddSheet.tsx).
  const add: AddActions = {
    food: () => openFood("log"),
    drink: () => openFood("drinks"),
    checkIn: () => openJournal("checkin"),
    weight: () => openJournal("measurements"),
    here: {
      food: <QuickLog db={ready} kind="food" version={version} onChanged={changed} onMore={() => openFood("log")} />,
      drink: <QuickLog db={ready} kind="drink" version={version} onChanged={changed} onMore={() => openFood("drinks")} />,
      checkIn: <QuickLog db={ready} kind="checkIn" version={version} onChanged={changed} onMore={() => openJournal("checkin")} />,
      weight: <QuickLog db={ready} kind="weight" version={version} onChanged={changed} onMore={() => openJournal("measurements")} />,
    },
    coach: chatOn ? () => go("coach") : undefined,
    quick: <QuickAdd db={ready} version={version} onChanged={changed} onCoach={askCoach} />,
  };

  return (
    <Frame
      tab={tab}
      tabs={visibleTabs(chatOn)}
      add={add}
      account={session ? { email: session.email, signOut: () => signOut(session) } : null}
      onTab={(t) => {
        // A section goes to its top level: You shows its menu, Coach opens without a quick add's text.
        if (t === "you") setSettingsPage(null);
        setCoachDraft(undefined);
        go(t);
      }}
    >
      {/* data-area: the section's own accent (ui/palette.css). "wide": a wide screen may spread every page into columns (the web app's styles). */}
      <main className="shell with-nav wide" data-area={tab}>
        <SyncBanner status={status} configured={configured} syncing={syncing} nowMs={now} onSync={() => void sync()} />
        <div key={screenKey} className="screen">
          <Suspense>
            {tab === "today" ? (
              // Pulling Today down syncs, as the button does (without a Garmin key it just reloads the numbers).
              <PullToRefresh onRefresh={configured ? () => void sync() : changed} busy={syncing} label={configured ? "sync" : "refresh"}>
                <DashboardScreen
                  db={ready}
                  version={version}
                  configured={configured}
                  syncWarnings={status?.warnings ?? []}
                  profile={<ProfileButton db={ready} version={version} onOpen={() => openYou(null)} />}
                  sync={syncButton}
                  onChanged={changed}
                  quickAdd={
                    <Suspense>
                      <QuickAdd db={ready} version={version} onChanged={changed} onCoach={askCoach} compact />
                    </Suspense>
                  }
                  go={{
                    logFood: () => openFood("log"),
                    logDrink: () => openFood("drinks"),
                    askClaude: askCoach,
                    mealPrep: () => openPrep("stock"),
                    profile: () => go("activity"),
                    checkIn: (day) => openJournal("checkin", day),
                    measurements: () => openJournal("measurements"),
                  }}
                />
              </PullToRefresh>
            ) : tab === "activity" ? (
              <section>
                <PageHeader title="Activity" subtitle="Workouts, steps and sleep from Garmin." />
                <MeScreen db={ready} version={version} only="activity" onEditProfile={() => openYou("profile")} onChanged={changed} />
              </section>
            ) : tab === "journal" ? (
              <section>
                <PageHeader title="Journal" subtitle="A minute a day is plenty." />
                <JournalScreen
                  db={ready}
                  version={version}
                  view={journal.view}
                  initialDay={journal.day}
                  onView={(view) => setJournal({ view })}
                  onChanged={changed}
                />
              </section>
            ) : tab === "coach" ? (
              <ChatScreen
                db={ready}
                secrets={secretStore}
                version={version}
                onChanged={changed}
                onConnect={() => openYou("connections")}
                onPrivacy={() => openYou("privacy")}
                draft={coachDraft}
              />
            ) : tab === "food" ? (
              <FoodScreen db={ready} view={foodView} onView={setFoodView} version={version} onChanged={changed} onStock={() => openPrep("stock")} />
            ) : tab === "prep" ? (
              <MealPrepScreen db={ready} view={mealPrepView} onView={setMealPrepView} version={version} onChanged={changed} />
            ) : (
              <SettingsScreen
                db={ready}
                secrets={secretStore}
                isNative={isNative}
                navListsAll={target.navListsAll}
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
                onLink={(to) => go(to)}
                onCoach={changed}
                targets={
                  <TargetsPage
                    db={ready}
                    version={version}
                    onChanged={changed}
                    ask={askCoach ? () => askCoach("Suggest daily targets for me from my weight and activity.") : undefined}
                    goals={<MeScreen db={ready} version={version} only="goals" onEditProfile={() => setSettingsPage("profile")} onChanged={changed} />}
                  />
                }
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
