import { format, type Level, type LogRecord, type Threshold } from "../../core/log";

/**
 * The log buffer as a Markdown report to hand to Claude (or anyone debugging): a short brief,
 * the context needed to read the lines, a summary, then every record oldest first.
 *
 * Records are already sanitized by core/log (no health values, notes, keys or URLs), so the
 * report adds nothing that is not on screen in the Logs tab.
 */

export interface ReportContext {
  /** "android", "ios" or "web". */
  platform: string;
  /** "development" or "production". */
  build: string;
  timeZone: string;
  level: Threshold;
  nowMs: number;
}

const LEVEL_ORDER: Level[] = ["error", "warn", "info", "debug"];

/** "health-logs-2026-10-26-0713.md" in local time, so files sort and never clash within a minute. */
export function reportFileName(nowMs: number, timeZone: string): string {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
      .formatToParts(new Date(nowMs))
      .map((x) => [x.type, x.value]),
  );
  return `health-logs-${p.year}-${p.month}-${p.day}-${p.hour}${p.minute}.md`;
}

export function logReport(records: LogRecord[], ctx: ReportContext): string {
  const sorted = [...records].sort((a, b) => a.ts - b.ts);
  const counts = Object.fromEntries(LEVEL_ORDER.map((l) => [l, sorted.filter((r) => r.level === l).length])) as Record<Level, number>;
  const problemScopes = [...new Set(sorted.filter((r) => r.level === "error" || r.level === "warn").map((r) => r.scope))];
  const span = sorted.length ? `${iso(sorted[0].ts)} to ${iso(sorted[sorted.length - 1].ts)} (UTC)` : "no records";

  const lines = [
    "# Health app logs",
    "",
    "Logs from my personal health app (React + Capacitor, local SQLite, Garmin sync, Claude agent).",
    "Please find the cause of any errors or warnings, explain it, and suggest a fix.",
    "",
    "## Context",
    "",
    `- Exported: ${iso(ctx.nowMs)} UTC`,
    `- Platform: ${ctx.platform}, ${ctx.build} build`,
    `- Time zone: ${ctx.timeZone}`,
    `- Log level: ${ctx.level} (records below it were not kept)`,
    `- Span: ${span}`,
    `- Records: ${sorted.length} (${LEVEL_ORDER.map((l) => `${counts[l]} ${l}`).join(", ")})`,
    ...(problemScopes.length ? [`- Scopes with errors or warnings: ${problemScopes.join(", ")}`] : []),
    "- Only what the app did is logged (counts, timings, statuses, errors); health values, notes, keys and URLs never are.",
    "",
  ];

  // Fenced with more backticks than any line holds, so a record can never close the block early.
  const fence = "`".repeat(Math.max(3, ...sorted.map((r) => longestRun(format(r)) + 1)));
  const problems = sorted.filter((r) => r.level === "error" || r.level === "warn");
  if (problems.length) {
    lines.push("## Errors and warnings", "", `${fence}text`, ...problems.map(format), fence, "");
  }
  lines.push("## All records, oldest first", "", `${fence}text`, ...(sorted.length ? sorted.map(format) : ["(empty)"]), fence, "");
  return lines.join("\n");
}

const iso = (ms: number) => new Date(ms).toISOString().replace("T", " ").slice(0, 19);

function longestRun(s: string): number {
  let best = 0;
  for (const m of s.matchAll(/`+/g)) best = Math.max(best, m[0].length);
  return best;
}
