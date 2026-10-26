import type { SqlDriver } from "../../db/driver";
import { MenuList, PageHeader, type MenuItem } from "../../ui/layout";
import { LogsScreen } from "../logs/LogsScreen";
import { AboutSettings } from "./AboutSettings";
import { ConnectionSettings } from "./ConnectionSettings";
import { PrivacySettings } from "./PrivacySettings";
import { ProfileSettings } from "./ProfileSettings";
import type { SecretStore } from "./secrets";

export type SettingsPage = "profile" | "connections" | "privacy" | "logs" | "about";

interface Props {
  db: SqlDriver;
  secrets: SecretStore;
  isNative: boolean;
  /** The open page, or null for the menu. Owned by the app shell, so other tabs can open a page (Edit profile, Connect Claude). */
  page: SettingsPage | null;
  onPage: (page: SettingsPage | null) => void;
  /** Called after credentials, transport or profile change, and after a restore. */
  onChanged: () => void;
}

export const SETTINGS_MENU: { title: string; items: MenuItem<SettingsPage>[] }[] = [
  { title: "You", items: [{ id: "profile", label: "Profile", description: "Name, body, activity and weight goal, and the estimates they give", icon: "user" }] },
  {
    title: "Data",
    items: [
      { id: "connections", label: "Connections", description: "Garmin sync, the Claude key, Garmin history import", icon: "link" },
      { id: "privacy", label: "Privacy & data", description: "What Claude may see, what was sent, backups", icon: "shield" },
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
export function SettingsScreen({ db, secrets, isNative, page, onPage, onChanged }: Props) {
  if (page === null) {
    return (
      <section>
        <PageHeader title="Settings" />
        <MenuList groups={SETTINGS_MENU} onOpen={onPage} />
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
