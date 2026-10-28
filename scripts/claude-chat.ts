/**
 * Talk to the health agent about the data in a local SQLite file (made by npm run sync:garmin -- --db).
 * Same engine, tools, consent, confirmations and logs as the app. Costs API usage on your key.
 *
 *   npm run sync:garmin -- --db health.sqlite
 *   npm run chat -- --db health.sqlite "How did I sleep this week?"
 *   npm run chat -- --db health.sqlite --photo lunch.jpg "Log this lunch"
 *   npm run chat -- --db health.sqlite --file lab.pdf "Explain this lab report"   (PDF, CSV, TXT, JSON)
 *   npm run chat -- --db health.sqlite "Plan a 5-day high-protein meal prep, 2 servings"
 *   ... --allow raw,notes,photos,files   also allow detailed records, day notes, photos, files (recorded as consent in that file)
 *   ... --continue <id>            follow-up in an existing conversation
 *   ... --yes                      save every proposed change without asking (otherwise you are asked y/n)
 *
 * Needs ANTHROPIC_API_KEY in .env. Prints the answer, tools, changes and what data was sent;
 * never prints the key.
 */
import { readFileSync } from "node:fs";
import { basename, extname } from "node:path";
import { createInterface } from "node:readline/promises";
import { listAgentActions, type ActionProposal } from "../src/domain/chat/actions";
import { claudeCreate } from "../src/domain/chat/client";
import { hasConsent, recordConsent, type ConsentScope } from "../src/domain/chat/consent";
import { askClaude, startConversation, type ChatDeps } from "../src/domain/chat/engine";
import { fileKind, toFileAttachment, type FileAttachment } from "../src/domain/chat/files";
import { toAttachment, type ImageAttachment } from "../src/domain/chat/images";
import { listDisclosures } from "../src/domain/chat/store";
import { migratedNodeDb } from "./lib/nodeDb";
import { deviceId } from "../src/db/settings";
import { setLogLevel } from "../src/core/log";

// Library logs go to stderr-ish console lines; LOG_LEVEL=debug for the detail.
setLogLevel((process.env.LOG_LEVEL as never) ?? "info");

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i > -1 ? process.argv[i + 1] : undefined;
}

const TYPES: Record<string, string> = { ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp", ".gif": "image/gif" };

async function main() {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error("ANTHROPIC_API_KEY is empty. Add it to .env and run with --env-file=.env");
  const dbPath = arg("--db");
  if (!dbPath) throw new Error("Pass --db <file> (create one with npm run sync:garmin -- --db <file>)");
  const withValue = new Set(["--db", "--allow", "--continue", "--photo", "--file"]);
  const question = process.argv
    .slice(2)
    .filter((a, i, all) => !withValue.has(a) && !withValue.has(all[i - 1] ?? "") && a !== "--yes")
    .join(" ")
    .trim();

  const images: ImageAttachment[] = [];
  const photo = arg("--photo");
  if (photo) images.push(toAttachment(readFileSync(photo).toString("base64"), TYPES[extname(photo).toLowerCase()]));
  const files: FileAttachment[] = [];
  const file = arg("--file");
  if (file) {
    const kind = fileKind(file, "");
    if (!kind) throw new Error("--file takes a PDF or a text file (CSV, TXT, JSON)");
    const raw = readFileSync(file);
    files.push(
      kind === "pdf"
        ? toFileAttachment({ kind, name: basename(file), mediaType: "application/pdf", data: raw.toString("base64") })
        : toFileAttachment({ kind, name: basename(file), mediaType: "text/plain", data: raw.toString("utf8") }),
    );
  }
  if (!question && images.length === 0 && files.length === 0) throw new Error('Pass a question, e.g. "How did I sleep this week?"');

  const { db } = await migratedNodeDb(dbPath, { foreignKeys: true });

  const dev = await deviceId(db);
  // Running this script is the consent for summaries; the rest only with --allow (photos also with --photo).
  const wanted: ConsentScope[] = ["claude.aggregates"];
  const allow = (arg("--allow") ?? "").split(",");
  if (allow.includes("raw")) wanted.push("claude.raw_series");
  if (allow.includes("notes")) wanted.push("claude.notes");
  if (allow.includes("photos") || photo) wanted.push("claude.photos");
  if (allow.includes("files") || file) wanted.push("claude.files");
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
  const res = conv ? await askClaude(deps, conv, question, { images, files }) : await startConversation(deps, question, { images, files });
  rl?.close();

  console.log(`\n${res.text}\n`);
  console.log(`status: ${res.status}; served by ${res.servedBy}${res.fallbackUsed ? " (fallback)" : ""}; conversation ${res.conversationId}`);
  console.log(
    `requests: ${res.usage.requests}; tokens in ${res.usage.inputTokens} (cache read ${res.usage.cacheReadTokens}, write ${res.usage.cacheWriteTokens}), out ${res.usage.outputTokens}`,
  );
  for (const c of res.toolCalls)
    console.log(`tool ${c.name}${c.dataClass ? ` [${c.dataClass}]` : ""} ${c.allowed ? "ran" : "NOT ALLOWED"}${c.error ? `: ${c.error}` : ""}`);
  for (const a of res.actions) console.log(`change ${a.status}: ${a.summary} (undo id ${a.id})`);
  const sent = await listDisclosures(db, res.conversationId);
  console.log(`data sent in this conversation: ${sent.length} item(s), ${sent.reduce((a, d) => a + d.bytes, 0)} bytes`);
  for (const d of sent) console.log(`  - [${d.dataClass}] ${d.summary}`);
  const all = await listAgentActions(db, res.conversationId);
  if (all.length)
    console.log(
      `changes in this conversation: ${all.filter((a) => a.status === "applied").length} saved, ${all.filter((a) => a.status === "declined").length} declined`,
    );
}

main().catch((e) => {
  console.error(`FAILED: ${(e as Error).message}`);
  process.exit(1);
});
