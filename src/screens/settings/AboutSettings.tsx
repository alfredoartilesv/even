import { useEffect, useState } from "react";
import type { SqlDriver } from "../../db/driver";
import { deviceId } from "../../db/settings";
import { dataInventory, type InventoryRow } from "../../domain/settings/dataInventory";
import { APP_VERSION, BUILD_TIME } from "../../platform/buildInfo";
import { platformName } from "../../platform/device";
import { CHAT_MODEL } from "../../domain/chat/engine";
import { SectionHeader, Segmented, type Choice } from "../../ui/layout";
import { saveTheme, storedTheme, type Theme } from "../../ui/theme";
import { Logo } from "../../ui/logo";
import { InventoryGrid, PLATFORM } from "./summary";

const THEMES: Choice<Theme>[] = [
  { id: "system", label: "System" },
  { id: "light", label: "Light" },
  { id: "dark", label: "Dark" },
];

/** Where the owner's data goes, one line each. */
const FLOWS: [string, string][] = [
  ["Stays here", "An encrypted database on this phone."],
  ["Garmin", "Read only, when you sync."],
  ["Claude", "Only what you allow for each kind of data, every send listed in Privacy and data."],
  ["Backups and debug logs", "Only when you export them."],
];

/** Which app this is: version, build, where it runs, the facts a bug report needs, where data goes and what is stored. */
export function AboutSettings({ db, onPrivacy }: { db: SqlDriver; onPrivacy: () => void }) {
  const [theme, setTheme] = useState<Theme>(storedTheme);
  const [schema, setSchema] = useState<number | null>(null);
  const [device, setDevice] = useState<string | null>(null);
  const [inventory, setInventory] = useState<InventoryRow[]>([]);

  useEffect(() => {
    void db.all<{ user_version: number }>("PRAGMA user_version").then((r) => setSchema(Number(r[0]?.user_version ?? 0)));
    void deviceId(db).then(setDevice);
    void dataInventory(db).then(setInventory);
  }, [db]);

  const platform = PLATFORM[platformName] ?? platformName;
  const facts: [string, string, boolean?][] = [
    ["Version", APP_VERSION, true],
    [
      "Build",
      `${BUILD_TIME ? new Date(BUILD_TIME).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "–"}${import.meta.env.DEV ? " (development)" : ""}`,
    ],
    ["Platform", platform, true],
    ["Database schema", schema === null ? "–" : `v${schema}`],
    ["Chat model", CHAT_MODEL],
    ["Device id", device ? `…${device.slice(-8)}` : "–"],
  ];

  return (
    <div className="wide-grid">
      <section className="card span-12 theme-pick" aria-label="Appearance">
        <span className="grow">
          <strong>Appearance</strong>
          <span className="muted small block">Light is the look of the design; dark follows the same colours. System matches this device.</span>
        </span>
        <Segmented items={THEMES} value={theme} onChange={(t) => (saveTheme(t), setTheme(t))} label="Appearance" />
      </section>
      <section className="card span-12">
        <div className="about-head">
          <Logo size={48} decorative />
          <div>
            <h2>Even</h2>
            <div className="muted small">
              Version {APP_VERSION} · {platform}
            </div>
          </div>
        </div>
        <dl className="facts">
          {facts.map(([k, v, wideOnly]) => (
            <div key={k} className={wideOnly ? "wide-only" : undefined}>
              <dt className="muted small">{k}</dt>
              <dd>{v}</dd>
            </div>
          ))}
        </dl>
      </section>
      <section className="card span-12 about-flows">
        <h3>Where your data goes</h3>
        <ul className="plain flows">
          {FLOWS.map(([k, v]) => (
            <li key={k}>
              <strong>{k}</strong>
              <span className="muted small">{v}</span>
            </li>
          ))}
        </ul>
      </section>
      <section className="card span-12">
        <SectionHeader title="On this phone" action="Privacy" onAction={onPrivacy} />
        <InventoryGrid rows={inventory} />
      </section>
    </div>
  );
}
