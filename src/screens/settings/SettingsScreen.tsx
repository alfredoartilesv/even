import { useEffect, useState } from "react";
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
import { loadIdentity } from "../../domain/settings/profile";
import { rememberAdmin, wasAdmin } from "../../domain/settings/adminFlag";
import { ProfileSettings } from "./ProfileSettings";
import type { SecretStore } from "../../domain/settings/secrets";

export type SettingsPage = "profile" | "sync" | "friends" | "connections" | "privacy" | "logs" | "about" | "admin";

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
}

export const SETTINGS_MENU: { title: string; items: MenuItem<SettingsPage>[] }[] = [
  {
    title: "You",
    items: [
      { id: "profile", label: "Profile", description: "Picture, name, body, activity and weight goal, and the estimates they give", icon: "user" },
      { id: "friends", label: "Friends", description: "Who sees which of your daily numbers, and what they share with you", icon: "user" },
    ],
  },
  {
    title: "Data",
    items: [
      { id: "sync", label: "Sync & devices", description: "Your account, the phones and browsers it syncs with, the recovery passphrase", icon: "sync" },
      {
        id: "connections",
        label: "Connections",
        description: "Garmin sync, Garmin history import, and Claude: your API key or the Claude connector",
        icon: "link",
      },
      { id: "privacy", label: "Privacy & data", description: "What Claude may see and was sent, what is stored, backup and restore", icon: "shield" },
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
export const ADMIN_MENU: { title: string; items: MenuItem<SettingsPage>[] } = {
  title: "Admin",
  items: [
    { id: "admin", label: "Admin", description: "Invites, accounts, devices and the audit log. Never anyone's data", icon: "settings" },
    { id: "logs", label: "Debug logs", description: "What the app did on this device, kept across runs, export them for Claude", icon: "bug" },
  ],
};

const LABEL = Object.fromEntries([...SETTINGS_MENU, ADMIN_MENU].flatMap((g) => g.items.map((i) => [i.id, i.label]))) as Record<SettingsPage, string>;

/** A menu of pages: who you are, where data comes from and goes, what is kept and shared, the app version, and for an admin, Admin and the debug logs. */
export function SettingsScreen({ db, secrets, isNative, version, page, onPage, onChanged, onSync, session, onSession }: Props) {
  const [who, setWho] = useState<{ photo: string | null; name: string | null } | null>(null);
  const [admin, setAdmin] = useState(false);
  useEffect(() => {
    if (page === null) void loadIdentity(db).then(setWho);
  }, [db, page, version]);
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

  if (page === null) {
    // The Profile row shows the picture (or initials) once there is either.
    const menu = admin ? [...SETTINGS_MENU, ADMIN_MENU] : SETTINGS_MENU;
    const groups =
      who && (who.photo || who.name)
        ? menu.map((g) => ({
            ...g,
            items: g.items.map((i) => (i.id === "profile" ? { ...i, picture: <Avatar photo={who.photo} name={who.name} size={36} /> } : i)),
          }))
        : menu;
    return (
      <section>
        <PageHeader title="Settings" />
        <MenuList groups={groups} onOpen={onPage} />
      </section>
    );
  }
  return (
    <section>
      <PageHeader title={LABEL[page]} onBack={() => onPage(null)} backLabel="Settings" />
      {page === "profile" ? (
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
          version={version}
        />
      ) : page === "privacy" ? (
        <PrivacySettings db={db} onChanged={onChanged} syncAccountId={session?.accountId ?? null} />
      ) : page === "logs" ? (
        admin && <LogsScreen db={db} />
      ) : page === "admin" ? (
        admin && session && <AdminSettings session={session} />
      ) : (
        <AboutSettings db={db} />
      )}
    </section>
  );
}
