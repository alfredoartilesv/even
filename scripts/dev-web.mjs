/**
 * The web app and its sync server on this PC, without Docker (docs/dev-setup.md section 4b):
 *
 *   npm run dev:web     sync server on :8787 (PGlite in .data/pglite, or DATABASE_URL), web app on :5173
 *
 * Vite sends /v1 and /health to the sync server (vite.config.ts), so the browser talks to one
 * origin, as on Vercel. Make an invite first: npm run sync:invite -- --email you@example.com
 * (with the dev server stopped when on PGlite). Ctrl+C stops both.
 */
import { spawn } from "node:child_process";

const children = [];
function run(name, args, env = {}) {
  const child = spawn(process.execPath, args, { stdio: "inherit", env: { ...process.env, ...env } });
  child.on("exit", (code) => {
    if (code !== 0 && code !== null) process.stderr.write(`${name} stopped (exit ${code})\n`);
    stop(code ?? 0);
  });
  children.push(child);
}

let stopping = false;
function stop(code) {
  if (stopping) return;
  stopping = true;
  for (const c of children) if (c.exitCode === null) c.kill();
  process.exit(code);
}
process.on("SIGINT", () => stop(0));
process.on("SIGTERM", () => stop(0));

run("sync server", ["--env-file-if-exists=.env", "--import", "tsx", "server/node.ts"], { PORT: process.env.SYNC_PORT ?? "8787" });
run("vite", ["node_modules/vite/bin/vite.js", "--port", process.env.WEB_PORT ?? "5173", "--strictPort"]);
