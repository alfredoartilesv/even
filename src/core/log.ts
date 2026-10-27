/**
 * Small structured logger with levels and scopes. Pure TypeScript: runs in the app, in Node
 * tests and in PC scripts.
 *
 * Privacy rules (docs/architecture.md section 3): log what happened, never the data itself.
 * Use counts, ids, durations and statuses; no health values, notes, chat text, URLs or keys.
 * Fields whose name looks secret are redacted here as a second line of defence.
 */

export type Level = "debug" | "info" | "warn" | "error";
export type Threshold = Level | "silent";

export const LEVELS: Threshold[] = ["debug", "info", "warn", "error", "silent"];
const RANK: Record<Threshold, number> = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };

export type Fields = Record<string, unknown>;

export interface LogRecord {
  ts: number;
  level: Level;
  scope: string;
  msg: string;
  fields?: Fields;
}

export type Sink = (r: LogRecord) => void;

export interface Logger {
  debug(msg: string, fields?: Fields): void;
  info(msg: string, fields?: Fields): void;
  warn(msg: string, fields?: Fields): void;
  error(msg: string, fields?: Fields): void;
  /** Logs `msg` with ms elapsed (and any extra fields) when the returned function is called. */
  time(msg: string, level?: Level): (fields?: Fields) => void;
  child(scope: string): Logger;
}

const SECRET_KEY = /(key|token|secret|password|passphrase|authorization|cookie|url)/i;
const MAX_STRING = 200;

/** Copy of fields that is safe to print: secrets redacted, errors flattened, long strings cut. */
export function sanitize(fields: Fields): Fields {
  const out: Fields = {};
  for (const [k, v] of Object.entries(fields)) out[k] = SECRET_KEY.test(k) ? "[redacted]" : clean(v, 0);
  return out;
}

function clean(v: unknown, depth: number): unknown {
  if (v instanceof Error) {
    // Validation errors (zod) carry a JSON dump as message: keep just "path: message" per issue.
    const issues = (v as { issues?: { path?: (string | number)[]; message?: string }[] }).issues;
    const message = Array.isArray(issues) ? issues.map((i) => `${i.path?.join(".") || "input"}: ${i.message}`).join("; ") : v.message;
    return { name: v.name, message: message.slice(0, MAX_STRING) };
  }
  if (typeof v === "string") return v.length > MAX_STRING ? `${v.slice(0, MAX_STRING)}…` : v;
  if (v === null || typeof v !== "object") return v;
  if (depth >= 2) return Array.isArray(v) ? `[${v.length} items]` : "[object]";
  if (Array.isArray(v)) return v.length > 20 ? `[${v.length} items]` : v.map((x) => clean(x, depth + 1));
  const o: Fields = {};
  for (const [k, x] of Object.entries(v as Fields)) o[k] = SECRET_KEY.test(k) ? "[redacted]" : clean(x, depth + 1);
  return o;
}

/** One line: "12:00:01.234 INFO  sync: run finished {"samples":10}". */
export function format(r: LogRecord): string {
  const t = new Date(r.ts).toISOString().slice(11, 23);
  const f = r.fields && Object.keys(r.fields).length ? ` ${JSON.stringify(r.fields)}` : "";
  return `${t} ${r.level.toUpperCase().padEnd(5)} ${r.scope}: ${r.msg}${f}`;
}

export const consoleSink: Sink = (r) => {
  const line = format(r);
  if (r.level === "error") console.error(line);
  else if (r.level === "warn") console.warn(line);
  else if (r.level === "info") console.info(line);
  else console.debug(line);
};

/** Keeps the last `size` records in memory, for the in-app log viewer. Never written to disk. */
export function ringBuffer(size = 500): { sink: Sink; records: () => LogRecord[]; clear: () => void } {
  const buf: LogRecord[] = [];
  return {
    sink: (r) => {
      buf.push(r);
      if (buf.length > size) buf.splice(0, buf.length - size);
    },
    records: () => [...buf],
    clear: () => void buf.splice(0),
  };
}

interface Config {
  threshold: Threshold;
  /** Per-scope overrides by prefix, e.g. { "sync": "debug" } also covers "sync.garmin". */
  scopes: Record<string, Threshold>;
  sinks: Sink[];
  now: () => number;
}

/** The last records of this run, shown in the Logs tab and exported from there. Memory only, gone on restart. */
export const recentLogs = ringBuffer(500);

/** Process-wide defaults: warn and above, to the console and recentLogs. The app sets the level at start. */
const config: Config = { threshold: "warn", scopes: {}, sinks: [consoleSink, recentLogs.sink], now: () => Date.now() };

export function configureLogging(c: Partial<Config>): void {
  Object.assign(config, c);
}

export function setLogLevel(threshold: Threshold, scope?: string): void {
  if (!LEVELS.includes(threshold)) throw new RangeError(`Unknown log level ${threshold}`);
  if (scope) config.scopes[scope] = threshold;
  else config.threshold = threshold;
}

export const getLogLevel = (): Threshold => config.threshold;

export function isLevel(s: string | null | undefined): s is Threshold {
  return s != null && (LEVELS as string[]).includes(s);
}

function thresholdFor(scope: string): Threshold {
  let best: string | null = null;
  for (const s of Object.keys(config.scopes)) {
    if ((scope === s || scope.startsWith(`${s}.`)) && (!best || s.length > best.length)) best = s;
  }
  return best ? config.scopes[best] : config.threshold;
}

export function enabled(scope: string, level: Level): boolean {
  return RANK[level] >= RANK[thresholdFor(scope)];
}

function emit(scope: string, level: Level, msg: string, fields?: Fields): void {
  if (!enabled(scope, level)) return;
  const r: LogRecord = { ts: config.now(), level, scope, msg, ...(fields ? { fields: sanitize(fields) } : {}) };
  for (const s of config.sinks) {
    try {
      s(r);
    } catch {
      // A broken sink must never break the app.
    }
  }
}

export function createLogger(scope: string): Logger {
  const log: Logger = {
    debug: (m, f) => emit(scope, "debug", m, f),
    info: (m, f) => emit(scope, "info", m, f),
    warn: (m, f) => emit(scope, "warn", m, f),
    error: (m, f) => emit(scope, "error", m, f),
    time(msg, level = "debug") {
      const start = config.now();
      return (f) => emit(scope, level, msg, { ...f, ms: config.now() - start });
    },
    child: (sub) => createLogger(`${scope}.${sub}`),
  };
  return log;
}
