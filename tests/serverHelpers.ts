import { createApp } from "../server/app";
import { AuthError } from "../server/accounts";
import { migrateServer } from "../server/migrate";
import { pglitePg } from "../server/db";
import { createStores } from "../server/stores";

/** Google stands in: a token "google:<subject>:<email>" is valid, anything else is not. */
async function fakeGoogle(idToken: string) {
  const [tag, subject, email] = idToken.split(":");
  if (tag !== "google" || !subject || !email) throw new AuthError(401, "Google did not confirm this account");
  return { subject, email };
}

/** A migrated server: the Hono app, its stores, and a fetch that calls the app in-process. Rate limits off unless asked for; Garmin is garminFetch. */
export async function testServer(opts: { rateLimits?: boolean; garminFetch?: typeof fetch } = {}) {
  const pg = await pglitePg(); // in memory
  await migrateServer(pg);
  const stores = createStores(pg, { SERVER_SECRET: "test-secret" }, { google: fakeGoogle, rateLimits: opts.rateLimits ?? false });
  const app = createApp(stores, { garminFetch: opts.garminFetch });
  const fetchFn = ((input: string, init?: RequestInit) => app.request(input, init)) as typeof fetch;
  return { pg, stores, app, fetchFn, base: "http://sync.test" };
}
