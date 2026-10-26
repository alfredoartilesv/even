import { useEffect, useState } from "react";
import { format, getLogLevel, LEVELS, recentLogs, type Level, type LogRecord, type Threshold } from "../../core/log";
import type { SqlDriver } from "../../db/driver";
import { shareText } from "../../platform/device";
import { saveLogLevel } from "./logLevel";

const RANK: Record<Level, number> = { debug: 0, info: 1, warn: 2, error: 3 };

/** Log level picker and the last records of this run. Logs never leave the phone unless copied. */
export function LogsPanel({ db }: { db: SqlDriver }) {
  const [level, setLevel] = useState<Threshold>(getLogLevel());
  const [show, setShow] = useState<Level>("info");
  const [records, setRecords] = useState<LogRecord[]>([]);
  const [note, setNote] = useState<string | null>(null);

  const refresh = () => setRecords(recentLogs.records().filter((r) => RANK[r.level] >= RANK[show]).reverse());
  useEffect(refresh, [show]);

  return (
    <div className="stack">
      <div className="row">
        <label>
          Log level
          <select
            value={level}
            onChange={async (e) => {
              const l = e.target.value as Threshold;
              await saveLogLevel(db, l);
              setLevel(l);
              refresh();
            }}
          >
            {LEVELS.map((l) => (
              <option key={l} value={l}>
                {l}
              </option>
            ))}
          </select>
        </label>
        <label>
          Show
          <select value={show} onChange={(e) => setShow(e.target.value as Level)}>
            {LEVELS.filter((l): l is Level => l !== "silent").map((l) => (
              <option key={l} value={l}>
                {l} and above
              </option>
            ))}
          </select>
        </label>
      </div>
      <p className="muted small">
        Logs say what the app did (counts, timings, errors), never your health values, notes or keys. They stay in memory and are
        cleared when the app closes.
      </p>
      <div className="actions">
        <button className="secondary" onClick={refresh}>
          Refresh
        </button>
        <button
          className="secondary"
          disabled={!records.length}
          onClick={async () => {
            const how = await shareText("Health app logs", [...records].reverse().map(format).join("\n"));
            setNote(how === "copied" ? "Copied to the clipboard." : null);
          }}
        >
          Copy logs
        </button>
        <button
          className="secondary"
          onClick={() => {
            recentLogs.clear();
            refresh();
          }}
        >
          Clear
        </button>
      </div>
      {note && <p className="muted small">{note}</p>}
      <pre className="logs">{records.length ? records.map(format).join("\n") : "No log records at this level yet."}</pre>
    </div>
  );
}
