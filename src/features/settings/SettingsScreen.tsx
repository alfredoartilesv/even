import { useState } from "react";
import type { SqlDriver } from "../../db/driver";
import { ConnectionSettings } from "./ConnectionSettings";
import { PrivacySettings } from "./PrivacySettings";
import { ProfileSettings } from "./ProfileSettings";
import type { SecretStore } from "./secrets";

interface Props {
  db: SqlDriver;
  secrets: SecretStore;
  isNative: boolean;
  /** Called after credentials, transport or profile change, and after a restore. */
  onChanged: () => void;
}

type Page = "profile" | "connections" | "privacy";

const PAGES: { id: Page; label: string }[] = [
  { id: "profile", label: "Profile" },
  { id: "connections", label: "Connections" },
  { id: "privacy", label: "Privacy & data" },
];

/** Settings in three pages: who you are, where data comes from and goes, and what is kept and shared. */
export function SettingsScreen({ db, secrets, isNative, onChanged }: Props) {
  const [page, setPage] = useState<Page>("profile");
  return (
    <section>
      <nav className="tabs sub" aria-label="Settings pages">
        {PAGES.map((p) => (
          <button key={p.id} className={page === p.id ? "active" : ""} aria-current={page === p.id ? "page" : undefined} onClick={() => setPage(p.id)}>
            {p.label}
          </button>
        ))}
      </nav>
      {page === "profile" ? (
        <ProfileSettings db={db} onChanged={onChanged} />
      ) : page === "connections" ? (
        <ConnectionSettings db={db} secrets={secrets} isNative={isNative} onChanged={onChanged} />
      ) : (
        <PrivacySettings db={db} onChanged={onChanged} />
      )}
    </section>
  );
}
