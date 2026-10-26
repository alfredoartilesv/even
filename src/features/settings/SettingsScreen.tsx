import type { SqlDriver } from "../../db/driver";
import { PageHeader, SubTabs, type Choice } from "../../ui/layout";
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
  /** Owned by the app shell, so other tabs can open a page (Edit profile, Connect Claude). */
  page: SettingsPage;
  onPage: (page: SettingsPage) => void;
  /** Called after credentials, transport or profile change, and after a restore. */
  onChanged: () => void;
}

const PAGES: Choice<SettingsPage>[] = [
  { id: "profile", label: "Profile" },
  { id: "connections", label: "Connections" },
  { id: "privacy", label: "Privacy & data" },
  { id: "logs", label: "Debug logs" },
  { id: "about", label: "About" },
];

/** Who you are, where data comes from and goes, what is kept and shared, the debug logs, and the app version. */
export function SettingsScreen({ db, secrets, isNative, page, onPage, onChanged }: Props) {
  return (
    <section>
      <PageHeader title="Settings" />
      <SubTabs items={PAGES} value={page} onChange={onPage} label="Settings pages" />
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
