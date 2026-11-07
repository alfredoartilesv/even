import { useEffect, useState, type ReactNode } from "react";
import type { SqlDriver } from "../../db/driver";
import { sessionApi, type SyncSession } from "../../domain/cloudsync/session";
import { deviceFetch } from "../../platform/device";
import { AdminSettings } from "../admin/AdminSettings";
import { FriendsSettings } from "../cloudsync/FriendsSettings";
import { SyncSettings } from "../cloudsync/SyncSettings";
import { MenuList, PageHeader, type MenuItem } from "../../ui/layout";
import { LogsScreen } from "../logs/LogsScreen";
import { Avatar } from "../me/avatar";
import { AboutSettings } from "./AboutSettings";
import { ConnectionSettings } from "./ConnectionSettings";
import { PrivacySettings } from "./PrivacySettings";
import { rememberAdmin, wasAdmin } from "../../domain/settings/adminFlag";
import { ProfileSettings } from "./ProfileSettings";
import { backupDue, hints, useSettingsSummary } from "./summary";
import { SettingsOverview } from "./SettingsOverview";
import type { SecretStore } from "../../domain/settings/secrets";

export type SettingsPage = "targets" | "profile" | "sync" | "friends" | "connections" | "privacy" | "logs" | "about" | "admin";

/** Rows in You that open another section (Activity, Journal) rather than a page of You. */
export type YouLink = "activity" | "journal";

interface Props {
  db: SqlDriver;
  secrets: SecretStore;
  isNative: boolean;
  /** Bumped when data changes, so the menu shows a new profile picture. */
  version: number;
  /** The open page, or null for the menu. Owned by the app shell, so other tabs can open a page (Edit profile, Connect Claude). */
  page: SettingsPage | null;
  onPage: (page: SettingsPage | null) => void;
  /** Called after credentials, transport or profile change, and after a restore. */
  onChanged: () => void;
  /** Sync now (after Garmin is connected, or from Settings > Sync); resolves when done. */
  onSync: () => Promise<void>;
  /** This device's sync connection, or null (docs/users.md). */
  session: SyncSession | null;
  onSession: (s: SyncSession | null) => void;
  /** Activity and Journal are sections of their own; their rows here open them. */
  onLink: (to: YouLink) => void;
  /** The goals as You > Targets (MeScreen with only its goals). */
  targets: ReactNode;
  /** You > Connections' Coach switch changed: the shell shows or hides Coach. */
  onCoach: () => void;
}

export const SETTINGS_MENU: { title: string; items: MenuItem<SettingsPage | YouLink>[] }[] = [
  {
    title: "Your health",
    items: [
      { id: "profile", label: "Profile", description: "Picture, name, body, units", icon: "user" },
      { id: "targets", label: "Targets", description: "Calories, protein, steps, drinks and your other goals", icon: "flame" },
      { id: "friends", label: "Friends", description: "Who sees which daily numbers", icon: "user" },
      { id: "activity", label: "Activity and sleep", description: "Workouts, steps and sleep from Garmin", icon: "pulse" },
      { id: "journal", label: "Journal", description: "Check-ins and measurements", icon: "book" },
    ],
  },
  {
    title: "Data",
    items: [
      { id: "connections", label: "Connections", description: "Garmin, Coach and Claude", icon: "link" },
      { id: "sync", label: "Sync & devices", description: "Account, phones, passphrase", icon: "sync" },
      { id: "privacy", label: "Privacy and data", description: "What Claude may see, backup", icon: "shield" },
    ],
  },
  {
    title: "App",
    items: [{ id: "about", label: "About", description: "Version, build and platform", icon: "info" }],
  },
];

/**
 * Only for an admin account (docs/users.md section 2.6); the server checks it on every request too.
 * Debug logs are this install's own records, offered offline too once the account was seen as admin.
 */
export const ADMIN_MENU: { title: string; items: MenuItem<SettingsPage | YouLink>[] } = {
  title: "Admin",
  items: [
    { id: "admin", label: "Admin", description: "Invites, accounts, devices and the audit log. Never anyone's data", icon: "settings" },
    { id: "logs", label: "Debug logs", description: "What the app did on this device, kept across runs, export them for Claude", icon: "bug" },
  ],
};

const LABEL = Object.fromEntries([...SETTINGS_MENU, ADMIN_MENU].flatMap((g) => g.items.map((i) => [i.id, i.label]))) as Record<SettingsPage | YouLink, string>;
const isLink = (id: SettingsPage | YouLink): id is YouLink => id === "activity" || id === "journal";

/**
 * A menu of pages: who you are, where data comes from and goes, what is kept and shared, the app
 * version, and for an admin, Admin and the debug logs. Each row says where its page stands, and a
 * missing backup gets a nudge. A phone shows the menu or one page; a wide screen keeps the menu on
 * the left, with the open page, or an overview of them all, beside it.
 */
export function SettingsScreen({ db, secrets, isNative, version, page, onPage, onChanged, onSync, session, onSession, onLink, targets, onCoach }: Props) {
  const summary = useSettingsSummary(db, secrets, version);
  const [admin, setAdmin] = useState(false);
  // Whether to offer Admin: asked of the server once per connection and remembered, so offline the
  // menu shows what the server said last. Not connected, it is never shown.
  useEffect(() => {
    setAdmin(false);
    if (!session) return;
    let live = true;
    void wasAdmin(db, session.accountId).then((was) => live && was && setAdmin(true));
    void sessionApi(session, deviceFetch({ connectTimeoutMs: 10_000, readTimeoutMs: 15_000 }))
      .me()
      .then(
        async (me) => {
          await rememberAdmin(db, session.accountId, me.account.isAdmin);
          if (live) setAdmin(me.account.isAdmin);
        },
        () => {},
      );
    return () => void (live = false);
  }, [db, session]);

  // The Profile row shows the picture (or initials) once there is either, and every row where it stands.
  const menu = admin ? [...SETTINGS_MENU, ADMIN_MENU] : SETTINGS_MENU;
  const status = summary ? (hints(summary) as Partial<Record<SettingsPage | YouLink, string>>) : {};
  const groups = menu.map((g) => ({
    ...g,
    items: g.items.map((i) => ({
      ...i,
      hint: status[i.id],
      picture: i.id === "profile" && summary && (summary.photo || summary.name) ? <Avatar photo={summary.photo} name={summary.name} size={36} /> : undefined,
    })),
  }));
  const nudge = summary && backupDue(summary) && (
    <div className="backup-nudge">
      <span className="small">{summary.lastBackupMs ? "Last backup over a month ago." : "No backup yet."} Notes, logs and chats exist only on this phone.</span>
      <button type="button" className="secondary" onClick={() => onPage("privacy")}>
        Back up
      </button>
    </div>
  );

  return (
    <section className="settings-layout">
      <div className={page === null ? "settings-menu" : "settings-menu wide-only"}>
        <PageHeader title="You" />
        {nudge}
        <MenuList groups={groups} onOpen={(id) => (isLink(id) ? onLink(id) : onPage(id))} current={page} />
      </div>
      <div className={page === null ? "settings-page wide-only" : "settings-page"}>
        {page === null ? (
          // A wide screen opens You on Targets beside the menu (handoff 0.7); the overview follows.
          <>
            <h2 className="settings-page-title">Targets</h2>
            {targets}
            {summary && <SettingsOverview summary={summary} onPage={onPage} />}
          </>
        ) : (
          <>
            <div className="narrow-only">
              <PageHeader title={LABEL[page]} onBack={() => onPage(null)} backLabel="You" />
            </div>
            <h2 className="settings-page-title wide-only">{LABEL[page]}</h2>
            {pageBody()}
          </>
        )}
      </div>
    </section>
  );

  // A plain function, not a component: a component declared here would remount the page on every render.
  function pageBody() {
    return page === "targets" ? (
      targets
    ) : page === "profile" ? (
      <ProfileSettings db={db} onChanged={onChanged} connected={session !== null} onOpenSync={() => onPage("sync")} />
    ) : page === "sync" ? (
      <SyncSettings db={db} secrets={secrets} isNative={isNative} session={session} onSession={onSession} onSync={onSync} version={version} />
    ) : page === "friends" ? (
      <FriendsSettings session={session} onConnect={() => onPage("sync")} onSync={onSync} />
    ) : page === "connections" ? (
      <ConnectionSettings
        db={db}
        secrets={secrets}
        isNative={isNative}
        session={session}
        onChanged={onChanged}
        onConnected={() => void onSync()}
        onSync={onSync}
        onOpenSync={() => onPage("sync")}
        onCoach={onCoach}
        version={version}
      />
    ) : page === "privacy" ? (
      <PrivacySettings db={db} onChanged={onChanged} syncAccountId={session?.accountId ?? null} />
    ) : page === "logs" ? (
      admin && <LogsScreen db={db} />
    ) : page === "admin" ? (
      admin && session && <AdminSettings session={session} />
    ) : (
      <AboutSettings db={db} onPrivacy={() => onPage("privacy")} />
    );
  }
}
