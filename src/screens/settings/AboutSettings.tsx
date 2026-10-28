import { useEffect, useState } from "react";
import type { SqlDriver } from "../../db/driver";
import { deviceId } from "../../db/settings";
import { APP_VERSION, BUILD_TIME } from "../../platform/buildInfo";
import { platformName } from "../../platform/device";
import { CHAT_MODEL } from "../../domain/chat/engine";
import { Logo } from "../../ui/logo";

const PLATFORM: Record<string, string> = { android: "Android", ios: "iOS", web: "Browser" };

/** Which app this is: version, build, where it runs, and the facts a bug report needs. */
export function AboutSettings({ db }: { db: SqlDriver }) {
  const [schema, setSchema] = useState<number | null>(null);
  const [device, setDevice] = useState<string | null>(null);

  useEffect(() => {
    void db.all<{ user_version: number }>("PRAGMA user_version").then((r) => setSchema(Number(r[0]?.user_version ?? 0)));
    void deviceId(db).then(setDevice);
  }, [db]);

  const rows: [string, string][] = [
    ["Version", APP_VERSION],
    [
      "Build",
      `${BUILD_TIME ? new Date(BUILD_TIME).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "–"}${import.meta.env.DEV ? " (development)" : ""}`,
    ],
    ["Platform", PLATFORM[platformName] ?? platformName],
    ["Database schema", schema === null ? "–" : `v${schema}`],
    ["Chat model", CHAT_MODEL],
    ["Device id", device ? `…${device.slice(-8)}` : "–"],
  ];

  return (
    <section>
      <div className="about-head">
        <Logo size={48} decorative />
        <div>
          <h2>Even</h2>
          <div className="muted small">Version {APP_VERSION}</div>
        </div>
      </div>
      <table className="values">
        <tbody>
          {rows.map(([k, v]) => (
            <tr key={k}>
              <td>{k}</td>
              <td className="num">{v}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="muted small">
        A personal health app. Your data stays in an encrypted database on this phone. It leaves only when you sync with Garmin, ask Claude in the chat (with
        your permission for each kind of data), or export a backup or the debug logs.
      </p>
    </section>
  );
}
