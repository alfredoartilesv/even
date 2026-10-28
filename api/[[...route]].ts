import { Hono } from "hono";
import { handle } from "hono/vercel";
import { createApp } from "../server/app";
import { postgresJs } from "../server/pg";
import { createStores } from "../server/stores";

/**
 * The sync API as one Vercel function (vercel.json routes /health and /v1/* here). DATABASE_URL is
 * Neon's pooled URL, set by the Neon integration on the free plan. Migrations run in the Vercel
 * build (npm run vercel-build), never on a request.
 */
const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is not set");
const api = createApp(createStores(postgresJs(url, { max: 1 }), process.env));
// Mounted twice: vercel.json rewrites /v1/* and /health to /api/..., and either path may arrive.
const app = new Hono().route("/api", api).route("/", api);

// Every method the API uses: Vercel answers 405 for a method the function does not export, which
// would break renaming, passphrase changes, revoking devices, deleting the account and unsharing.
const handler = handle(app);
export const GET = handler;
export const POST = handler;
export const PUT = handler;
export const DELETE = handler;
