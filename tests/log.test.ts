import test from "node:test";
import assert from "node:assert/strict";
import { configureLogging, consoleSink, createLogger, enabled, format, getLogLevel, isLevel, ringBuffer, sanitize, setLogLevel, type LogRecord } from "../src/core/log";

function capture() {
  const records: LogRecord[] = [];
  let t = 1_000;
  configureLogging({ threshold: "debug", scopes: {}, sinks: [(r) => records.push(r)], now: () => t });
  return { records, tick: (ms: number) => (t += ms) };
}

test.afterEach(() => configureLogging({ threshold: "warn", scopes: {}, sinks: [consoleSink], now: () => Date.now() }));

test("levels filter, scopes override by prefix", () => {
  const { records } = capture();
  setLogLevel("info");
  setLogLevel("debug", "sync");
  setLogLevel("silent", "chat");
  createLogger("db").debug("hidden");
  createLogger("db").info("shown");
  createLogger("sync.freddy").debug("shown too");
  createLogger("synchro").debug("hidden: not a child of sync");
  createLogger("chat").error("hidden: silent");
  assert.deepEqual(records.map((r) => `${r.scope}:${r.msg}`), ["db:shown", "sync.freddy:shown too"]);
  assert.equal(getLogLevel(), "info");
  assert.equal(enabled("sync.freddy.http", "debug"), true);
  assert.throws(() => setLogLevel("loud" as never), /Unknown/);
  assert.equal(isLevel("warn"), true);
  assert.equal(isLevel("verbose"), false);
});

test("fields are sanitised: secrets redacted, errors flattened, long and deep values cut", () => {
  const f = sanitize({
    apiKey: "sk-123",
    freddyUrl: "https://x",
    nested: { password: "p", count: 3, deeper: { deepest: { x: 1 } } },
    err: new TypeError("boom"),
    long: "x".repeat(300),
    many: Array.from({ length: 30 }, (_, i) => i),
  });
  assert.equal(f.apiKey, "[redacted]");
  assert.equal(f.freddyUrl, "[redacted]");
  assert.deepEqual(f.nested, { password: "[redacted]", count: 3, deeper: { deepest: "[object]" } });
  assert.deepEqual(f.err, { name: "TypeError", message: "boom" });
  assert.equal((f.long as string).length, 201);
  assert.equal(f.many, "[30 items]");
});

test("child scopes, timers and the ring buffer", () => {
  const { records, tick } = capture();
  const log = createLogger("backup").child("restore");
  const done = log.time("restore finished", "info");
  tick(42);
  done({ tables: 3 });
  assert.deepEqual(records[0], { ts: 1042, level: "info", scope: "backup.restore", msg: "restore finished", fields: { tables: 3, ms: 42 } });
  assert.equal(format(records[0]), '00:00:01.042 INFO  backup.restore: restore finished {"tables":3,"ms":42}');

  const ring = ringBuffer(2);
  configureLogging({ sinks: [ring.sink, () => { throw new Error("broken sink"); }] });
  for (const m of ["a", "b", "c"]) createLogger("x").warn(m);
  assert.deepEqual(ring.records().map((r) => r.msg), ["b", "c"], "keeps the newest, a broken sink does not stop the others");
  ring.clear();
  assert.deepEqual(ring.records(), []);
});
