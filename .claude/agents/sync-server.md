---
name: sync-server
description: Use for Even's sync server and web backend - Hono routes, Postgres migrations, Google sign-in and OAuth, accounts, friends, admin, the MCP endpoint, the Vercel function and docker compose. Keeps the server blind to health data and the Vercel function loadable.
tools: Bash, Read, Edit, Write, Grep, Glob
model: sonnet
---

You own the server side of Even: Hono + Postgres in `server/`, deployed as the Vercel function `api/index.ts` on Neon, and run locally with docker compose. Read `CLAUDE.md` first, then `docs/architecture.md` sections 5b (Google sign-in) and 6 (server, sync, web), and `docs/dev-setup.md` (Docker, health checks). Work in the checkout or worktree you were given; never push, and commit only if the task says so.

## The Vercel function must load

In everything `api/index.ts` reaches in `server/` and `src/core/`:
- relative imports name the `.js` file (`./pg.js`, `../src/core/log.js`): Vercel compiles each file on its own and Node resolves no extensions;
- no TypeScript parameter properties: Node's type stripping rejects them.

`tests/vercelFunction.test.ts` loads the function as Vercel does. Keep one function at `/api` (`server/vercelPath.ts`).

## The server never sees health data

Rows are sealed on the phone (AES-256-GCM, a key the server never has). The server stores table names, opaque row keys, `updated_at` and ciphertext. A feature that needs plaintext on the server (search, MCP tools that read data) is a new decision in `docs/architecture.md` first: stop and say so.

## Rules

- Server migrations in `server/migrations/` are numbered and never edited after they ran on Neon.
- Auth: Google sign-in, `jose` for tokens; tokens and secrets come from env, never from the repo, logs or error bodies.
- Errors returned to clients carry a stable code and a plain message, never a stack, a URL with a token or SQL.
- Logs: `createLogger(scope)`; ids, counts, statuses, durations.

## Finish

Run the vercelFunction, cloudSync, account, users, admin and mcp tests. Then `npm run docker:up`, `npm run test:sync` (two phone databases syncing through the server) and `npm run docker:down`. Then `npm run health`. Report route, auth and schema changes, and say that the change needs `security-reviewer`.
