import test from "node:test";
import assert from "node:assert/strict";
import type { LogRecord } from "../src/core/log";
import { logKind, matches } from "../src/domain/logs/kinds";

const rec = (scope: string, level: LogRecord["level"], msg: string): LogRecord => ({ ts: 0, level, scope, msg });

test("log kinds: sync, Coach and data come from the scope, everything else is the app", () => {
  assert.equal(logKind("sync.garmin"), "sync");
  assert.equal(logKind("cloudsync.session"), "sync");
  assert.equal(logKind("import.garmin"), "sync");
  assert.equal(logKind("chat.consent"), "coach");
  assert.equal(logKind("db.migrate"), "data");
  assert.equal(logKind("backup"), "data");
  assert.equal(logKind("mealprep"), "app");
});

test("log filters: a kind, problems (warnings and errors) and a search on the message or scope", () => {
  const r = [rec("sync", "info", "sync finished"), rec("chat", "warn", "Claude key rejected"), rec("db", "error", "database unavailable")];
  assert.deepEqual(
    r.filter((x) => matches(x, "problems", "")).map((x) => x.scope),
    ["chat", "db"],
  );
  assert.deepEqual(
    r.filter((x) => matches(x, "sync", "")).map((x) => x.msg),
    ["sync finished"],
  );
  assert.deepEqual(
    r.filter((x) => matches(x, "all", "KEY")).map((x) => x.scope),
    ["chat"],
  );
  assert.equal(matches(r[0], "all", "chat"), false);
});
