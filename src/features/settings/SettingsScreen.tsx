import { useEffect, useState } from "react";
import type { SqlDriver } from "../../db/driver";
import { MenuList, PageHeader, type MenuItem } from "../../ui/layout";
import { LogsScreen } from "../logs/LogsScreen";
import { Avatar } from "../me/ui/avatar";
import { AboutSettings } from "./AboutSettings";
import { ConnectionSettings } from "./ConnectionSettings";
import { PrivacySettings } from "./PrivacySettings";
import { loadProfile, loadProfilePhoto } from "./profile";
import { ProfileSettings } from "./ProfileSettings";
import type { SecretStore } from "./secrets";

export type SettingsPage = "profile" | "connections" | "privacy" | "logs" | "about";

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
}

export const SETTINGS_MENU: { title: string; items: MenuItem<SettingsPage>[] }[] = [
  { title: "You", items: [{ id: "profile", label: "Profile", description: "Picture, name, body, activity and weight goal, and the estimates they give", icon: "user" }] },
  {
    title: "Data",
    items: [
      { id: "connections", label: "Connections", description: "Garmin sync, Garmin history import, the Claude key", icon: "link" },
      { id: "privacy", label: "Privacy & data", description: "What Claude may see and was sent, what is stored, backup and restore", icon: "shield" },
    ],
  },
  {
    title: "App",
    items: [
      { id: "logs", label: "Debug logs", description: "This run's records, export them for Claude", icon: "bug" },
      { id: "about", label: "About", description: "Version, build and platform", icon: "info" },
    ],
  },
];

const LABEL = Object.fromEntries(SETTINGS_MENU.flatMap((g) => g.items.map((i) => [i.id, i.label]))) as Record<SettingsPage, string>;

/** A menu of pages: who you are, where data comes from and goes, what is kept and shared, the debug logs, and the app version. */
export function SettingsScreen({ db, secrets, isNative, version, page, onPage, onChanged }: Props) {
  const [who, setWho] = useState<{ photo: string | null; name: string | null } | null>(null);
  useEffect(() => {
    if (page === null) void Promise.all([loadProfilePhoto(db), loadProfile(db)]).then(([photo, p]) => setWho({ photo, name: p.name }));
  }, [db, page, version]);

  if (page === null) {
    // The Profile row shows the picture (or initials) once there is either.
    const groups = who && (who.photo || who.name)
      ? SETTINGS_MENU.map((g) => ({ ...g, items: g.items.map((i) => (i.id === "profile" ? { ...i, picture: <Avatar photo={who.photo} name={who.name} size={36} /> } : i)) }))
      : SETTINGS_MENU;
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
        <ProfileSettings db={db} onChanged={onChanged} />
      ) : page === "connections" ? (
        <ConnectionSettings db={db} secrets={secrets} isNative={isNative} onChanged={onChanged} />
      ) : page === "privacy" ? (
        <PrivacySettings db={db} onChanged={onChanged} />
      ) : page === "logs" ? (
        <LogsScreen db={db} />
      ) : (
        <AboutSettings db={db} />
      )}
    </section>
  );
}
