import type { LogRecord } from "../../core/log";

/**
 * The filter chips on the Debug logs page (handoff 0.7, Logs): what part of the app wrote a
 * record, from its scope, and whether it needs attention. Pure.
 */
export type LogKind = "sync" | "coach" | "data" | "app";
export type LogFilter = "all" | LogKind | "problems";

export const LOG_KIND_LABEL: Record<LogKind, string> = { sync: "Sync", coach: "Coach", data: "Data", app: "App" };

export function logKind(scope: string): LogKind {
  const top = scope.split(".")[0];
  if (top === "sync" || top === "cloudsync" || top === "import" || top === "http") return "sync";
  if (top === "chat") return "coach";
  if (top === "db" || top === "backup") return "data";
  return "app";
}

export const needsAttention = (r: Pick<LogRecord, "level">) => r.level === "warn" || r.level === "error";

export function matches(r: LogRecord, filter: LogFilter, search: string): boolean {
  if (filter === "problems" ? !needsAttention(r) : filter !== "all" && logKind(r.scope) !== filter) return false;
  const q = search.trim().toLowerCase();
  return !q || r.msg.toLowerCase().includes(q) || r.scope.toLowerCase().includes(q);
}
