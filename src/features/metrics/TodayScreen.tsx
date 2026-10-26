import { useCallback, useEffect, useState } from "react";
import type { SqlDriver } from "../../db/driver";
import { dayValues, latestSampleDay, type DayValue } from "./queries";
import { lastSync, type LastSync } from "../sync/runSync";

interface Props {
  db: SqlDriver;
  configured: boolean;
  /** Bumped after every sync so the screen reloads. */
  version: number;
}

const fmtTime = (ms: number | null) => (ms ? new Date(ms).toLocaleString() : "never");
const fmtNum = (n: number) => (Number.isInteger(n) ? n.toLocaleString() : n.toLocaleString(undefined, { maximumFractionDigits: 1 }));

export function TodayScreen({ db, configured, version }: Props) {
  const [sync, setSync] = useState<LastSync | null>(null);
  const [day, setDay] = useState<string | null>(null);
  const [values, setValues] = useState<DayValue[]>([]);

  const load = useCallback(async () => {
    setSync(await lastSync(db, "freddy"));
    const d = await latestSampleDay(db);
    setDay(d);
    setValues(d ? await dayValues(db, d) : []);
  }, [db]);

  useEffect(() => {
    void load();
  }, [load, version]);

  return (
    <section>
      {/* Syncing is the header button; failures and staleness show in the banner above every tab. */}
      {configured && <div className="muted small">Last successful sync: {fmtTime(sync?.lastOkMs ?? null)}</div>}
      {!configured && <p className="muted">Add your freddy MCP URL and key in Settings to start syncing.</p>}
      {sync?.warnings.map((w) => (
        <p key={w} className="warning small">
          {w}
        </p>
      ))}

      {day ? (
        <>
          <h2>{day}</h2>
          <table className="values">
            <tbody>
              {values.map((v) => (
                <tr key={`${v.metric}|${v.device}`}>
                  <td>
                    {v.label}
                    <div className="muted small">{v.device}</div>
                  </td>
                  <td className="num">
                    {fmtNum(v.value)} {v.unit ?? ""}
                    {v.partial && <div className="muted small">day not over</div>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      ) : (
        configured && <p className="muted">No data yet. Run a sync.</p>
      )}
    </section>
  );
}
