import test from "node:test";
import assert from "node:assert/strict";
import { configureLogging, consoleSink, createLogger, recentLogs, ringBuffer, setLogLevel, type LogRecord } from "../src/core/log";
import { logReport, reportFileName } from "../src/features/logs/report";

const ctx = { platform: "android", build: "production", timeZone: "Europe/Madrid", level: "info" as const, nowMs: Date.UTC(2026, 9, 26, 6, 13) };
const rec = (ts: number, level: LogRecord["level"], scope: string, msg: string, fields?: LogRecord["fields"]): LogRecord => ({ ts: Date.UTC(2026, 9, 26, 6, 0, ts), level, scope, msg, ...(fields ? { fields } : {}) });

test("the report gives Claude the brief, the context, problems first, then every record oldest first", () => {
  const md = logReport(
    [
      rec(30, "error", "sync", "sync failed, cursor kept", { err: { name: "Error", message: "HTTP 502" } }),
      rec(10, "info", "app", "app starting"),
      rec(20, "warn", "chat", "Claude key rejected during chat", { status: 401 }),
    ],
    ctx,
  );
  assert.match(md, /^# Health app logs\n/);
  assert.match(md, /Please find the cause of any errors or warnings/);
  assert.match(md, /- Platform: android, production build/);
  assert.match(md, /- Time zone: Europe\/Madrid/);
  assert.match(md, /- Exported: 2026-10-26 06:13:00 UTC/);
  assert.match(md, /- Span: 2026-10-26 06:00:10 to 2026-10-26 06:00:30 \(UTC\)/);
  assert.match(md, /- Records: 3 \(1 error, 1 warn, 1 info, 0 debug\)/);
  assert.match(md, /- Scopes with errors or warnings: chat, sync/);

  const problems = md.slice(md.indexOf("## Errors and warnings"), md.indexOf("## All records"));
  assert.ok(problems.indexOf("Claude key rejected") < problems.indexOf("sync failed"), "oldest first");
  assert.doesNotMatch(problems, /app starting/);
  const all = md.slice(md.indexOf("## All records"));
  assert.deepEqual(
    all.split("\n").filter((l) => /^\d\d:/.test(l)).map((l) => l.split(": ")[1].split(" {")[0]),
    ["app starting", "Claude key rejected during chat", "sync failed, cursor kept"],
  );
  assert.match(all, /"err":\{"name":"Error","message":"HTTP 502"\}/);
});

test("an empty buffer still makes a valid report; no problems section without problems", () => {
  const md = logReport([], ctx);
  assert.match(md, /- Span: no records/);
  assert.match(md, /- Records: 0 /);
  assert.doesNotMatch(md, /## Errors and warnings/);
  assert.match(md, /```text\n\(empty\)\n```/);
  assert.doesNotMatch(logReport([rec(1, "info", "app", "ok")], ctx), /Scopes with errors/);
});

test("a record holding backticks cannot break out of its code block", () => {
  const md = logReport([rec(1, "error", "chat", "bad reply ```` end")], ctx);
  assert.match(md, /`````text\n/, "the fence is longer than any run inside");
  const fences = md.split("\n").filter((l) => /^`{3,}/.test(l));
  assert.ok(fences.every((f) => f.startsWith("`````")));
});

test("file name is the local date and time, sortable", () => {
  assert.equal(reportFileName(ctx.nowMs, "Europe/Madrid"), "health-logs-2026-10-26-0713.md");
  assert.equal(reportFileName(ctx.nowMs, "America/New_York"), "health-logs-2026-10-26-0213.md");
});

test("what reaches the report went through the logger's redaction", () => {
  const buf = ringBuffer(10);
  configureLogging({ sinks: [buf.sink] });
  setLogLevel("debug");
  try {
    createLogger("sync").error("request failed", { url: "https://freddy.example/mcp?key=abc", apiKey: "sk-ant-secret", status: 500 });
    const md = logReport(buf.records(), ctx);
    assert.doesNotMatch(md, /freddy\.example|sk-ant-secret|abc/);
    assert.match(md, /"url":"\[redacted\]"/);
    assert.match(md, /"status":500/);
  } finally {
    configureLogging({ sinks: [consoleSink, recentLogs.sink] });
    setLogLevel("silent");
  }
});
