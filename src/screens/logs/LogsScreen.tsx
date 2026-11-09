import { useCallback, useEffect, useState } from "react";
import { createLogger, format, getLogLevel, LEVELS, recentLogs, setLogLevel, type Level, type LogRecord, type Threshold } from "../../core/log";
import type { SqlDriver } from "../../db/driver";
import { isNative, platformName, shareText } from "../../platform/device";
import { APP_VERSION } from "../../platform/buildInfo";
import { saveTextFile } from "../../platform/files";
import { failed, fmtDay, MsgLine, plural, timeZone, type Msg } from "../../ui/common";
import { ChipGroup, StatusBadge } from "../../ui/controls";
import { Icon } from "../../ui/icons";
import { localDay } from "../../core/tz";
import { LOG_KIND_LABEL, matches, needsAttention, type LogFilter } from "../../domain/logs/kinds";
import { saveLogLevel } from "../../domain/settings/logLevel";
import { logReport, reportFileName } from "../../domain/logs/report";
import { clearLogs, KEEP_RECORDS, loadLogs } from "../../domain/logs/store";

const RANK: Record<Level, number> = { debug: 0, info: 1, warn: 2, error: 3 };
const log = createLogger("logs");

/**
 * You > Admin > Debug logs: level, the stored records (this run and the ones before, as
 * each was written to log_records), and ways to hand them to Claude (a Markdown file through
 * the share sheet or a download, or the same text shared or copied). They leave the device only
 * through these buttons.
 *
 * Also shown when the database cannot open (db null): that is when the logs matter most. It then
 * shows this run's records in memory, and the level applies to this run only.
 */
export function LogsScreen({ db }: { db: SqlDriver | null }) {
  const [level, setLevel] = useState<Threshold>(getLogLevel());
  const [show, setShow] = useState<Level>("info");
  const [all, setAll] = useState<LogRecord[]>([]);
  const [msg, setMsg] = useState<Msg>(null);
  const [confirmClear, setConfirmClear] = useState(false);

  const read = useCallback(async () => (db ? loadLogs(db) : recentLogs.records()), [db]);
  const refresh = useCallback(() => void read().then(setAll, (err) => log.warn("logs not read", { err })), [read]);
  // New records keep arriving (sync, chat); follow them while the tab is open.
  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 2000);
    return () => clearInterval(t);
  }, [refresh]);

  const shown = all.filter((r) => RANK[r.level] >= RANK[show]).reverse();
  const errors = all.filter((r) => r.level === "error").length;
  const warnings = all.filter((r) => r.level === "warn").length;
  const report = async () =>
    logReport(await read(), {
      platform: platformName,
      build: `${APP_VERSION}, ${import.meta.env.DEV ? "development" : "production"}`,
      timeZone: timeZone(),
      level,
      nowMs: Date.now(),
    });

  async function exportFile() {
    try {
      const name = reportFileName(Date.now(), timeZone());
      await saveTextFile(name, await report(), { title: "Even logs", mimeType: "text/markdown" });
      log.info("logs exported as a file", { records: all.length });
      setMsg({ kind: "ok", text: isNative ? `Shared ${name}. Pick the Claude app to attach it.` : `Downloaded ${name}. Attach it in a Claude chat.` });
    } catch (err) {
      setMsg(failed(err, "logs"));
    }
  }

  async function shareReport() {
    try {
      const how = await shareText("Even logs", await report());
      log.info("logs shared as text", { records: all.length, how });
      setMsg({ kind: "ok", text: how === "copied" ? "Copied. Paste it into a Claude chat." : "Shared. Pick the Claude app to send it." });
    } catch (err) {
      setMsg(failed(err, "logs"));
    }
  }

  async function clear() {
    try {
      const n = db ? await clearLogs(db) : all.length;
      recentLogs.clear();
      log.info("logs cleared", { records: n });
      setMsg({ kind: "ok", text: `Cleared ${plural(n, "record")}.` });
    } catch (err) {
      setMsg(failed(err, "logs"));
    }
    setConfirmClear(false);
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
        The export is a Markdown file with the app's context and every record, ready to attach to a Claude chat. Logs say what the app did (counts, timings,
        errors), never your health values, notes or keys.{" "}
        {db
          ? `Each record is saved on this device as it happens, so nothing is lost when the app closes or crashes. The newest ${KEEP_RECORDS.toLocaleString("en")} are kept, never synced or put in a backup.`
          : "The database is not open, so these are this run's records in memory: export them before closing the app."}
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
      <LogList records={shown} />
    </section>
  );
}

const FILTERS: LogFilter[] = ["all", "sync", "coach", "data", "app", "problems"];
const FILTER_LABEL: Record<LogFilter, string> = { all: "All", ...LOG_KIND_LABEL, problems: "Problems" };
const clock = (ts: number) => new Date(ts).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" });

/**
 * The records, newest first, by day (handoff 0.7, Logs): search, a chip per kind with its count,
 * and each row (time, message, its scope, "Needs attention" for a warning or an error) opening to
 * its fields and Copy details.
 */
/**
 * A row's key from what it says, not where it is: new records arrive at the top every two seconds,
 * and a key by position moved under an open row and closed it (the owner's note, 9 Nov 2026).
 * Two identical records in the same millisecond are told apart by their count.
 */
const rowKey = (r: LogRecord) => `${r.ts}|${r.level}|${r.scope}|${r.msg}`;

function LogList({ records }: { records: LogRecord[] }) {
  const [filter, setFilter] = useState<LogFilter>("all");
  const [search, setSearch] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const shown = records.filter((r) => matches(r, filter, search));
  const tz = timeZone();
  const days = new Map<string, LogRecord[]>();
  for (const r of shown) {
    const day = localDay(r.ts, tz);
    days.set(day, [...(days.get(day) ?? []), r]);
  }
  const seen = new Map<string, number>();
  return (
    <div className="log-list">
      <input
        type="search"
        className="log-search"
        aria-label="Search logs"
        placeholder="Search logs"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
      />
      <ChipGroup
        label="Filter"
        value={filter}
        onChange={(f) => {
          setFilter(f);
          setOpen(null);
        }}
        options={FILTERS.map((f) => ({ id: f, label: `${FILTER_LABEL[f]} ${records.filter((r) => matches(r, f, "")).length}` }))}
      />
      {shown.length === 0 && (
        <div className="card stack tight">
          <strong>No entries match</strong>
          <span className="muted small">Try another filter or clear the search.</span>
        </div>
      )}
      {[...days].map(([day, rows]) => (
        <section key={day} aria-label={fmtDay(day)} className="log-day">
          <h3 className="log-day-title">{fmtDay(day)}</h3>
          <div className="card log-rows">
            {rows.map((r) => {
              const base = rowKey(r);
              const n = seen.get(base) ?? 0;
              seen.set(base, n + 1);
              const key = `${base}#${n}`;
              const isOpen = open === key;
              return (
                <div key={key} className="log-row">
                  <button type="button" className="log-row-head" aria-expanded={isOpen} onClick={() => setOpen(isOpen ? null : key)}>
                    <span className="log-time">{clock(r.ts)}</span>
                    <span className="grow log-msg">
                      <span>{r.msg}</span>
                      <span className="log-tags">
                        <span className="log-tag">{r.scope}</span>
                        {needsAttention(r) && <span className={`log-tag ${r.level}`}>{r.level === "error" ? "Error" : "Needs attention"}</span>}
                      </span>
                    </span>
                    <Icon name="chevron" size={18} />
                  </button>
                  {isOpen && (
                    <div className="log-detail">
                      <dl>
                        <div>
                          <dt>Level</dt>
                          <dd>{r.level}</dd>
                        </div>
                        {Object.entries(r.fields ?? {}).map(([k, v]) => (
                          <div key={k}>
                            <dt>{k}</dt>
                            <dd>{typeof v === "string" ? v : JSON.stringify(v)}</dd>
                          </div>
                        ))}
                      </dl>
                      <button
                        type="button"
                        className="secondary"
                        onClick={() =>
                          void navigator.clipboard?.writeText(format(r)).then(
                            () => setCopied(key),
                            () => setCopied(null),
                          )
                        }
                      >
                        {copied === key ? "Copied" : "Copy details"}
                      </button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </section>
      ))}
    </div>
  );
}
