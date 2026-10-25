/**
 * Ask Claude about the health data in a local SQLite file (made by scripts/freddy-sync.ts --db).
 * Same engine, tools, consent and disclosure log as the app. Costs API usage on your key.
 *
 *   node --env-file=.env --import tsx scripts/freddy-sync.ts --db health.sqlite
 *   node --env-file=.env --import tsx scripts/claude-chat.ts --db health.sqlite "How did I sleep this week?"
 *   ... --allow raw,notes     also allow day-by-day series and day notes (recorded as consent in that file)
 *   ... --continue <id>       ask a follow-up in an existing conversation
 *
 * Needs ANTHROPIC_API_KEY in .env. Prints the answer, which tools ran, and what data was sent;
 * never prints the key.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { claudeCreate } from "../src/chat/client";
import { hasConsent, recordConsent, type ConsentScope } from "../src/chat/consent";
import { askClaude, startConversation, type ChatDeps } from "../src/chat/engine";
import { listDisclosures } from "../src/chat/store";
import type { SqlDriver, SqlValue } from "../src/db/driver";
import { migrate, parseMigrations } from "../src/db/migrate";
import { deviceId } from "../src/db/settings";

function openDb(path: string): SqlDriver {
  const raw = new DatabaseSync(path);
  raw.exec("PRAGMA foreign_keys = ON");
  return {
    async exec(sql) {
      raw.exec(sql);
    },
    async run(sql, params = []) {
      raw.prepare(sql).run(...(params as SqlValue[]));
    },
    async all<T>(sql: string, params: SqlValue[] = []) {
      return raw.prepare(sql).all(...params).map((r) => ({ ...r })) as T[];
    },
  };
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i > -1 ? process.argv[i + 1] : undefined;
}

async function main() {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error("ANTHROPIC_API_KEY is empty. Add it to .env and run with --env-file=.env");
  const dbPath = arg("--db");
  if (!dbPath) throw new Error("Pass --db <file> (create one with scripts/freddy-sync.ts --db)");
  const flags = new Set(["--db", "--allow", "--continue"]);
  const question = process.argv
    .slice(2)
    .filter((a, i, all) => !flags.has(a) && !flags.has(all[i - 1] ?? ""))
    .join(" ")
    .trim();
  if (!question) throw new Error('Pass a question, e.g. "How did I sleep this week?"');

  const db = openDb(dbPath);
  const dir = join(import.meta.dirname, "../src/db/migrations");
  const files: Record<string, string> = {};
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".sql"))) files[`./migrations/${f}`] = readFileSync(join(dir, f), "utf8");
  await migrate(db, parseMigrations(files));

  const dev = await deviceId(db);
  // Running this script is the consent for summaries; raw series and notes only with --allow.
  const wanted: ConsentScope[] = ["claude.aggregates"];
  const allow = (arg("--allow") ?? "").split(",");
  if (allow.includes("raw")) wanted.push("claude.raw_series");
  if (allow.includes("notes")) wanted.push("claude.notes");
  for (const scope of wanted) if (!(await hasConsent(db, scope))) await recordConsent(db, scope, true, dev);

  const deps: ChatDeps = { db, create: claudeCreate(key), deviceId: dev };
  const conv = arg("--continue");
  const res = conv ? await askClaude(deps, conv, question) : await startConversation(deps, question);

  console.log(`\n${res.text}\n`);
  console.log(`status: ${res.status}; served by ${res.servedBy}${res.fallbackUsed ? " (fallback)" : ""}; conversation ${res.conversationId}`);
  console.log(
    `requests: ${res.usage.requests}; tokens in ${res.usage.inputTokens} (cache read ${res.usage.cacheReadTokens}, write ${res.usage.cacheWriteTokens}), out ${res.usage.outputTokens}`,
  );
  for (const c of res.toolCalls) console.log(`tool ${c.name} [${c.dataClass}] ${c.allowed ? "ran" : "NOT ALLOWED"}${c.error ? `: ${c.error}` : ""}`);
  const sent = await listDisclosures(db, res.conversationId);
  console.log(`data sent in this conversation: ${sent.length} item(s), ${sent.reduce((a, d) => a + d.bytes, 0)} bytes`);
  for (const d of sent) console.log(`  - [${d.dataClass}] ${d.summary}`);
}

main().catch((e) => {
  console.error(`FAILED: ${(e as Error).message}`);
  process.exit(1);
});
