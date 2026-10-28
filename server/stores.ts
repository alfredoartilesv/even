import { accountStore } from "./accounts";
import { adminStore } from "./admin";
import { oauthStore } from "./oauth";
import type { Stores } from "./app";
import { friendStore } from "./friends";
import { googleVerifier, type GoogleVerifier } from "./google";
import type { Pg } from "./pg";
import { syncStore } from "./store";

/**
 * Every store on one database. SERVER_SECRET makes the made-up salts for unknown emails (so emails
 * cannot be probed); it must be set on Vercel. GOOGLE_CLIENT_ID is the Web OAuth client id, for
 * linking Google accounts; without it that one endpoint says Google is not set up.
 */
export function createStores(
  pg: Pg,
  env: { SERVER_SECRET?: string; GOOGLE_CLIENT_ID?: string; VERCEL?: string; VERCEL_GIT_COMMIT_SHA?: string },
  opts: { google?: GoogleVerifier; rateLimits?: boolean } = {},
): Stores {
  const serverSecret = env.SERVER_SECRET ?? (env.VERCEL ? undefined : "even-local-only");
  if (!serverSecret) throw new Error("SERVER_SECRET is not set");
  return {
    sync: syncStore(pg),
    accounts: accountStore(pg, { serverSecret, rateLimits: opts.rateLimits }),
    friends: friendStore(pg),
    admin: adminStore(pg, { build: env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) }),
    oauth: oauthStore(pg),
    google: opts.google ?? googleVerifier(env.GOOGLE_CLIENT_ID),
  };
}
