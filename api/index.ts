import { createApp } from "../server/app.js";
import { postgresJs } from "../server/pg.js";
import { createStores } from "../server/stores.js";
import { restorePath } from "../server/vercelPath.js";

/**
 * The sync API as one Vercel function. vercel.json rewrites /health, /v1/*, /mcp, /oauth/* and
 * /.well-known/oauth-* to /api with the original path in __path, which restorePath puts back.
 * DATABASE_URL is Neon's pooled URL, set by the Neon integration on the free plan. Migrations run
 * in the Vercel build (npm run vercel-build), never on a request.
 */
const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is not set");
const app = createApp(createStores(postgresJs(url, { max: 1 }), process.env), { publicUrl: process.env.PUBLIC_URL });

// Every method the API uses: Vercel answers 405 for a method the function does not export, which
// would break renaming, passphrase changes, revoking devices, deleting the account and unsharing.
const handler = (req: Request) => app.fetch(restorePath(req));
export const GET = handler;
export const POST = handler;
export const PUT = handler;
export const DELETE = handler;
