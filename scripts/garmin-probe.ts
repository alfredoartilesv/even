/**
 * Which Garmin Personal API calls work for this key, and the shape of what they return.
 *
 *   node --env-file=.env --import tsx scripts/garmin-probe.ts
 *
 * Prints HTTP status and JSON field names (with value types) only: never the key, the token, or values.
 */
import { GarminApi, GarminApiError } from "../src/domain/sync/garmin";

const apiKey = process.env.GARMIN_API_KEY?.trim();
if (!apiKey) throw new Error("GARMIN_API_KEY is empty. Fill .env and run with --env-file=.env");
const api = new GarminApi({ apiKey });

/** Field names and types, a level or two deep; arrays show their first item. */
function shape(v: unknown, depth = 0): unknown {
  if (Array.isArray(v)) return v.length ? [`${v.length} items`, shape(v[0], depth)] : [];
  if (v && typeof v === "object") {
    if (depth >= 2) return "{…}";
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, shape(x, depth + 1)]));
  }
  return v === null ? "null" : typeof v;
}

const day = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
const [from, to] = [day(6), day(0)];

const calls: Array<[string, string, Record<string, string | number>?]> = [
  ["settings", "/userprofile-service/userprofile/settings"],
  ["daily summaries", "/usersummary-service/v2/dailysummaries", { startDate: from, endDate: to }],
  ["sleep", "/sleep-service/sleep/dailySleepSummariesByDate", { startDate: from, endDate: to }],
  ["hrv", `/hrv-service/hrv/daily/${from}/${to}`],
  ["weight all", `/weight-service/weight/all/${from}/${to}`],
  ["weight range", `/weight-service/weight/range/${from}/${to}`],
  ["weight all, 30 days", `/weight-service/weight/all/${day(29)}/${to}`],
  ["activities", "/activitylist-service/activities/search/activities", { startDate: from, endDate: to, start: 0, limit: 5 }],
];

for (const [name, path, query] of calls) {
  try {
    const body = await api.get(path, query);
    console.log(`OK   ${name}: ${JSON.stringify(shape(body))}`);
  } catch (e) {
    console.log(`FAIL ${name}: ${e instanceof GarminApiError ? e.message : (e as Error).message}`);
  }
}
