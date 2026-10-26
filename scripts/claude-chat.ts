/**
 * Talk to the health agent about the data in a local SQLite file (made by scripts/freddy-sync.ts --db).
 * Same engine, tools, consent, confirmations and logs as the app. Costs API usage on your key.
 *
 *   node --env-file=.env --import tsx scripts/freddy-sync.ts --db health.sqlite
 *   npm run chat -- --db health.sqlite "How did I sleep this week?"
 *   npm run chat -- --db health.sqlite --photo lunch.jpg "Log this lunch"
 *   npm run chat -- --db health.sqlite "Plan a 5-day high-protein meal prep, 2 servings"
 *   ... --allow raw,notes,photos   also allow detailed records, day notes, photos (recorded as consent in that file)
 *   ... --continue <id>            follow-up in an existing conversation
 *   ... --yes                      save every proposed change without asking (otherwise you are asked y/n)
 *
 * Needs ANTHROPIC_API_KEY in .env. Prints the answer, tools, changes and what data was sent;
 * never prints the key.
 */
import { readdirSync, readFileSync } from "node:fs";
import { extname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { DatabaseSync } from "node:sqlite";
import { listAgentActions, type ActionProposal } from "../src/features/chat/actions";
import { claudeCreate } from "../src/features/chat/client";
import { hasConsent, recordConsent, type ConsentScope } from "../src/features/chat/consent";
import { askClaude, startConversation, type ChatDeps } from "../src/features/chat/engine";
import { toAttachment, type ImageAttachment } from "../src/features/chat/images";
import { listDisclosures } from "../src/features/chat/store";
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

const TYPES: Record<string, string> = { ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp", ".gif": "image/gif" };

async function main() {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error("ANTHROPIC_API_KEY is empty. Add it to .env and run with --env-file=.env");
  const dbPath = arg("--db");
  if (!dbPath) throw new Error("Pass --db <file> (create one with scripts/freddy-sync.ts --db)");
  const withValue = new Set(["--db", "--allow", "--continue", "--photo"]);
  const question = process.argv
    .slice(2)
    .filter((a, i, all) => !withValue.has(a) && !withValue.has(all[i - 1] ?? "") && a !== "--yes")
    .join(" ")
    .trim();

  const images: ImageAttachment[] = [];
  const photo = arg("--photo");
  if (photo) images.push(toAttachment(readFileSync(photo).toString("base64"), TYPES[extname(photo).toLowerCase()]));
  if (!question && images.length === 0) throw new Error('Pass a question, e.g. "How did I sleep this week?"');

  const db = openDb(dbPath);
  const dir = join(import.meta.dirname, "../src/db/migrations");
  const files: Record<string, string> = {};
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".sql"))) files[`./migrations/${f}`] = readFileSync(join(dir, f), "utf8");
  await migrate(db, parseMigrations(files));

  const dev = await deviceId(db);
  // Running this script is the consent for summaries; the rest only with --allow (photos also with --photo).
  const wanted: ConsentScope[] = ["claude.aggregates"];
  const allow = (arg("--allow") ?? "").split(",");
  if (allow.includes("raw")) wanted.push("claude.raw_series");
  if (allow.includes("notes")) wanted.push("claude.notes");
  if (allow.includes("photos") || photo) wanted.push("claude.photos");
  for (const scope of wanted) if (!(await hasConsent(db, scope))) await recordConsent(db, scope, true, dev);

  const yes = process.argv.includes("--yes");
  const rl = yes ? null : createInterface({ input: process.stdin, output: process.stdout });
  const confirmAction = async (p: ActionProposal) => {
    console.log(`\nThe assistant wants to: ${p.summary}`);
    for (const l of p.lines) console.log(`  - ${l}`);
    if (yes) return true;
    return /^y(es)?$/i.test((await rl!.question("Save this? [y/N] ")).trim());
  };

  const deps: ChatDeps = { db, create: claudeCreate(key), deviceId: dev, confirmAction };
  const conv = arg("--continue");
  const res = conv ? await askClaude(deps, conv, question, { images }) : await startConversation(deps, question, { images });
  rl?.close();

  console.log(`\n${res.text}\n`);
  console.log(`status: ${res.status}; served by ${res.servedBy}${res.fallbackUsed ? " (fallback)" : ""}; conversation ${res.conversationId}`);
  console.log(
    `requests: ${res.usage.requests}; tokens in ${res.usage.inputTokens} (cache read ${res.usage.cacheReadTokens}, write ${res.usage.cacheWriteTokens}), out ${res.usage.outputTokens}`,
  );
  for (const c of res.toolCalls) console.log(`tool ${c.name}${c.dataClass ? ` [${c.dataClass}]` : ""} ${c.allowed ? "ran" : "NOT ALLOWED"}${c.error ? `: ${c.error}` : ""}`);
  for (const a of res.actions) console.log(`change ${a.status}: ${a.summary} (undo id ${a.id})`);
  const sent = await listDisclosures(db, res.conversationId);
  console.log(`data sent in this conversation: ${sent.length} item(s), ${sent.reduce((a, d) => a + d.bytes, 0)} bytes`);
  for (const d of sent) console.log(`  - [${d.dataClass}] ${d.summary}`);
  const all = await listAgentActions(db, res.conversationId);
  if (all.length) console.log(`changes in this conversation: ${all.filter((a) => a.status === "applied").length} saved, ${all.filter((a) => a.status === "declined").length} declined`);
}

main().catch((e) => {
  console.error(`FAILED: ${(e as Error).message}`);
  process.exit(1);
});
