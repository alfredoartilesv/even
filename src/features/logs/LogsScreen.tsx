import { useCallback, useEffect, useState } from "react";
import { createLogger, format, getLogLevel, LEVELS, recentLogs, setLogLevel, type Level, type LogRecord, type Threshold } from "../../core/log";
import type { SqlDriver } from "../../db/driver";
import { isNative, platformName, shareText } from "../../platform/device";
import { APP_VERSION } from "../../platform/buildInfo";
import { saveTextFile } from "../../platform/files";
import { failed, MsgLine, plural, timeZone, type Msg } from "../../ui/common";
import { StatusBadge } from "../../ui/controls";
import { saveLogLevel } from "../settings/logLevel";
import { logReport, reportFileName } from "./report";

const RANK: Record<Level, number> = { debug: 0, info: 1, warn: 2, error: 3 };
const log = createLogger("logs");

/**
 * The Logs tab: level, the records of this run, and ways to hand them to Claude (a Markdown
 * file through the share sheet or a download, or the same text shared or copied). Logs stay in
 * memory and are gone when the app closes; they leave the phone only through these buttons.
 *
 * Also shown when the database cannot open (db null): that is when the logs matter most. The
 * level then applies to this run only, since there is nowhere to store it.
 */
export function LogsScreen({ db }: { db: SqlDriver | null }) {
  const [level, setLevel] = useState<Threshold>(getLogLevel());
  const [show, setShow] = useState<Level>("info");
  const [all, setAll] = useState<LogRecord[]>([]);
  const [msg, setMsg] = useState<Msg>(null);
  const [confirmClear, setConfirmClear] = useState(false);

  const refresh = useCallback(() => setAll(recentLogs.records()), []);
  // New records keep arriving (sync, chat); follow them while the tab is open.
  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 2000);
    return () => clearInterval(t);
  }, [refresh]);

  const shown = all.filter((r) => RANK[r.level] >= RANK[show]).reverse();
  const errors = all.filter((r) => r.level === "error").length;
  const warnings = all.filter((r) => r.level === "warn").length;
  const report = () => logReport(recentLogs.records(), { platform: platformName, build: `${APP_VERSION}, ${import.meta.env.DEV ? "development" : "production"}`, timeZone: timeZone(), level, nowMs: Date.now() });

  async function exportFile() {
    try {
      const name = reportFileName(Date.now(), timeZone());
      await saveTextFile(name, report(), { title: "Health app logs", mimeType: "text/markdown" });
      log.info("logs exported as a file", { records: all.length });
      setMsg({ kind: "ok", text: isNative ? `Shared ${name}. Pick the Claude app to attach it.` : `Downloaded ${name}. Attach it in a Claude chat.` });
    } catch (err) {
      setMsg(failed(err, "logs"));
    }
  }

  async function shareReport() {
    try {
      const how = await shareText("Health app logs", report());
      log.info("logs shared as text", { records: all.length, how });
      setMsg({ kind: "ok", text: how === "copied" ? "Copied. Paste it into a Claude chat." : "Shared. Pick the Claude app to send it." });
    } catch (err) {
      setMsg(failed(err, "logs"));
    }
  }

  function clear() {
    const n = all.length;
    recentLogs.clear();
    log.info("logs cleared", { records: n });
    setConfirmClear(false);
    setMsg({ kind: "ok", text: `Cleared ${plural(n, "record")}.` });
    refresh();
  }

  return (
    <section className="stack">
      <div className="row" style={{ justifyContent: "flex-start" }}>
        <span className="small">{plural(all.length, "record")}</span>
        {errors > 0 && <StatusBadge status="critical">{plural(errors, "error")}</StatusBadge>}
        {warnings > 0 && <StatusBadge status="warning">{plural(warnings, "warning")}</StatusBadge>}
        {!errors && !warnings && all.length > 0 && <StatusBadge status="good">no problems</StatusBadge>}
      </div>

      <div className="actions">
        <button disabled={!all.length} onClick={exportFile}>
          Export for Claude
        </button>
        <button className="secondary" disabled={!all.length} onClick={shareReport}>
          {isNative ? "Share as text" : "Copy as text"}
        </button>
        {confirmClear ? (
          <>
            <button className="secondary danger" onClick={clear}>
              Clear {plural(all.length, "record")}
            </button>
            <button className="secondary" onClick={() => setConfirmClear(false)}>
              Keep
            </button>
          </>
        ) : (
          <button className="secondary danger" disabled={!all.length} onClick={() => setConfirmClear(true)}>
            Clear
          </button>
        )}
      </div>
      <MsgLine msg={msg} />
      <p className="muted small">
        The export is a Markdown file with the app's context and every record, ready to attach to a Claude chat. Logs say what the
        app did (counts, timings, errors), never your health values, notes or keys. They stay in memory and are cleared when the
        app closes, so export before closing it.
      </p>

      <div className="row">
        <label>
          Log level
          <select
            value={level}
            onChange={async (e) => {
              const l = e.target.value as Threshold;
              if (db) await saveLogLevel(db, l);
              else setLogLevel(l);
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
      <pre className="logs">{shown.length ? shown.map(format).join("\n") : "No log records at this level yet."}</pre>
    </section>
  );
}
