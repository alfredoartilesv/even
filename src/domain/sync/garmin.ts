import { addDays, localDay, localDayStart } from "../../core/tz";
import { createLogger } from "../../core/log";
import { catalogFor } from "../import/garmin";
import { sampleCollector, type SampleInput, type Source, type SyncResult } from "./types";

const log = createLogger("sync.garmin");

/**
 * Garmin Connect Personal API: your own Garmin data, read-only, with a personal API key made in
 * Garmin Connect (Settings → Personal API Key, https://connect.garmin.com/app/settings/personalApiToken).
 * The key is traded for a short-lived access token (about 24 h, no refresh token: ask again).
 * Endpoints and fields are from Garmin's OpenAPI document (developer.garmin.com, personal
 * swagger-docs, read 26 Oct 2026).
 *
 * Metric names are the ones the Garmin export importer (and freddy, the earlier sync) use, so the
 * export history and the live days form one series per metric. Units differ from the export:
 * here activity distance is metres and durations are seconds.
 *
 * Errors never contain the key or the token.
 */

export const GARMIN_SOURCE = "garmin";
export const GARMIN_API_URL = "https://personal.connectapi.garmin.com";
export const GARMIN_KEY_PAGE = "https://connect.garmin.com/app/settings/personalApiToken";
const TOKEN_PATH = "/personalapitoken-service/personal-api/personal-api-key/token";
const DEVICE = "Garmin";

/** The tightest per-call range of the endpoints read (steps and stress: 28 days). */
const CHUNK_DAYS = 28;
const ACTIVITY_PAGE = 99;
/** Re-ask for a token this long before it runs out. */
const TOKEN_MARGIN_MS = 5 * 60_000;
/** When the token reply has no expiry: Garmin documents 24 h. */
const DEFAULT_TOKEN_MS = 23 * 3_600_000;

/** How a rejected key starts its message: the connection card asks for a new key on this, not on a network failure. */
export const KEY_REJECTED = "Garmin rejected the personal API key";

export class GarminApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "GarminApiError";
  }
}

export interface GarminApiOptions {
  apiKey: string;
  /** Inject for tests, or a native-HTTP fetch on the phone. Defaults to global fetch. */
  fetch?: typeof fetch;
  baseUrl?: string;
  now?: () => number;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const inRange = (v: number | null, min: number, max: number) => (v !== null && v >= min && v <= max ? v : null);

/** The access token out of the token reply. Garmin does not document the reply, so several shapes are accepted. */
export function parseTokenReply(text: string, nowMs: number): { token: string; expiresAtMs: number } | null {
  const t = text.trim();
  let body: unknown;
  try {
    body = JSON.parse(t);
  } catch {
    // A bare token (JWT or opaque string) as the whole body.
    return /^[\w.~+/=-]{20,}$/.test(t) ? { token: t, expiresAtMs: nowMs + DEFAULT_TOKEN_MS } : null;
  }
  if (typeof body === "string" && body.length >= 20) return { token: body, expiresAtMs: nowMs + DEFAULT_TOKEN_MS };
  if (!isObj(body)) return null;
  const token = [body.access_token, body.accessToken, body.token].find((v) => typeof v === "string" && v.length > 0) as string | undefined;
  if (!token) return null;
  const inS = num(body.expires_in) ?? num(body.expiresIn);
  const at = num(body.expiresAt) ?? num(body.expires_at);
  // expiresAt may be in seconds or milliseconds since the epoch.
  const expiresAtMs = inS !== null ? nowMs + inS * 1000 : at !== null ? (at < 1e12 ? at * 1000 : at) : nowMs + DEFAULT_TOKEN_MS;
  return { token, expiresAtMs };
}

/** Minimal client: trade the key for a token, then GET JSON with it. */
export class GarminApi {
  private readonly doFetch: typeof fetch;
  private readonly base: string;
  private readonly now: () => number;
  private token: { token: string; expiresAtMs: number } | null = null;

  constructor(private readonly opts: GarminApiOptions) {
    this.doFetch = opts.fetch ?? ((...a) => fetch(...a));
    this.base = (opts.baseUrl ?? GARMIN_API_URL).replace(/\/$/, "");
    this.now = opts.now ?? Date.now;
  }

  private async accessToken(): Promise<string> {
    if (this.token && this.token.expiresAtMs - TOKEN_MARGIN_MS > this.now()) return this.token.token;
    let res: Response;
    try {
      // The token comes back as text/plain: asking for JSON gets HTTP 406.
      res = await this.doFetch(this.base + TOKEN_PATH, { method: "POST", headers: { authorization: `ApiKey ${this.opts.apiKey}`, accept: "*/*" } });
    } catch (e) {
      throw new GarminApiError(`Could not reach Garmin (${(e as Error).message})`);
    }
    const text = await res.text();
    if (res.status === 401 || res.status === 403) {
      throw new GarminApiError(`${KEY_REJECTED} (HTTP ${res.status}). It may have expired: make a new one in Garmin Connect.`, res.status);
    }
    if (!res.ok) throw new GarminApiError(`Garmin token request failed (HTTP ${res.status})`, res.status);
    const parsed = parseTokenReply(text, this.now());
    if (!parsed) throw new GarminApiError("Garmin's token reply had no access token in it");
    log.debug("access token obtained", { validMin: Math.round((parsed.expiresAtMs - this.now()) / 60_000) });
    this.token = parsed;
    return parsed.token;
  }

  /** Check the key: trade it for a token, the cheapest call that needs a valid key. */
  async verify(): Promise<void> {
    this.token = null;
    await this.accessToken();
  }

  async get(path: string, query: Record<string, string | number> = {}): Promise<unknown> {
    const qs = new URLSearchParams(Object.entries(query).map(([k, v]) => [k, String(v)])).toString();
    const url = this.base + path + (qs ? `?${qs}` : "");
    for (let attempt = 0; ; attempt++) {
      const token = await this.accessToken();
      let res: Response;
      try {
        res = await this.doFetch(url, { method: "GET", headers: { authorization: `Bearer ${token}`, accept: "application/json" } });
      } catch (e) {
        throw new GarminApiError(`Could not reach Garmin (${(e as Error).message})`);
      }
      // A token can be revoked before its expiry: get a new one once.
      if (res.status === 401 && attempt === 0) {
        this.token = null;
        continue;
      }
      const text = await res.text();
      if (!res.ok) throw new GarminApiError(`Garmin ${path.split("/")[1]} failed (HTTP ${res.status})`, res.status);
      if (!text.trim()) return null;
      try {
        return JSON.parse(text);
      } catch {
        throw new GarminApiError(`Garmin ${path.split("/")[1]} sent something that is not JSON`);
      }
    }
  }
}

export interface GarminOptions {
  api: GarminApi;
  /** Used when the profile settings do not give the account timezone. */
  timeZone?: string;
  /** How far back the first sync reads. Older days come from the Garmin export import. */
  firstSyncDays?: number;
  now?: () => number;
}

/** "2026-10-25T07:12:00.0" or "2026-10-25 07:12:00" (no zone) read as if UTC, to subtract local from GMT. */
const naiveMs = (s: unknown): number | null => {
  if (typeof s !== "string") return null;
  const ms = Date.parse(`${s.replace(" ", "T").replace(/Z$/, "")}Z`);
  return Number.isFinite(ms) ? ms : null;
};

const DAY_RE = /^\d{4}-\d{2}-\d{2}/;
const dayOf = (v: unknown): string | null => (typeof v === "string" && DAY_RE.test(v) ? v.slice(0, 10) : null);

export class GarminSource implements Source {
  readonly id = GARMIN_SOURCE;
  private readonly opts: Required<GarminOptions>;

  constructor(opts: GarminOptions) {
    this.opts = { timeZone: "Europe/Madrid", firstSyncDays: 30, now: Date.now, ...opts };
  }

  async fetchSince(cursor: string | null): Promise<SyncResult> {
    const { api, now, firstSyncDays } = this.opts;
    const warnings: string[] = [];
    const tz = await this.timeZone();
    const today = localDay(now(), tz);
    const start = cursor ? (cursor < today ? cursor : today) : addDays(today, -(firstSyncDays - 1));
    log.debug("window", { start, end: today, firstSync: !cursor, tz });

    const { samples, add } = sampleCollector(GARMIN_SOURCE, DEVICE);
    const offsets = new Map<string, number>();
    const bounds = (day: string) => {
      const off = offsets.get(day);
      if (off === undefined) {
        const s = localDayStart(day, tz);
        return { startMs: s.startMs, endMs: localDayStart(addDays(day, 1), tz).startMs, offsetMin: s.offsetMin };
      }
      const startMs = Date.parse(`${day}T00:00:00Z`) - off * 60_000;
      return { startMs, endMs: startMs + 86_400_000, offsetMin: off };
    };
    /** One endpoint failing for lack of access (scope, feature) should not stop the others. */
    const read = async (what: string, path: string, query?: Record<string, string | number>) => {
      try {
        return await api.get(path, query);
      } catch (e) {
        if (e instanceof GarminApiError && (e.status === 403 || e.status === 404)) {
          warnings.push(`${what}: not available (HTTP ${e.status})`);
          return null;
        }
        throw e;
      }
    };

    for (let from = start; from <= today; from = addDays(from, CHUNK_DAYS)) {
      const to = addDays(from, CHUNK_DAYS - 1) < today ? addDays(from, CHUNK_DAYS - 1) : today;

      // Daily summaries first: they give each day's UTC offset.
      const daily = await read("Daily summaries", "/usersummary-service/v2/dailysummaries", { startDate: from, endDate: to });
      for (const r of arr(isObj(daily) ? daily.data : daily)) {
        const day = isObj(r) ? dayOf(r.calendarDate) : null;
        if (!isObj(r) || !day) continue;
        const chrono = isObj(r.wellnessChronology) ? r.wellnessChronology : null;
        const local = naiveMs(chrono?.startTimestampLocal);
        const gmt = naiveMs(chrono?.startTimestampGmt);
        if (local !== null && gmt !== null && Math.abs(local - gmt) <= 14 * 3_600_000) offsets.set(day, Math.round((local - gmt) / 60_000));
        const at = bounds(day);
        const id = `${day}#0`;
        const o = (k: string) => (isObj(r[k]) ? (r[k] as Obj) : {});
        const steps = isObj(o("movement").steps) ? (o("movement").steps as Obj) : {};
        const cal = o("calories");
        const hr = o("heartRate");
        const im = o("intensityMinutes");
        const st = o("stress");
        const bb = o("bodyBattery");
        const ox = o("pulseOx");
        const minutes = (v: unknown) => {
          const n = inRange(num(v), 0, 1440);
          return n === null ? null : n * 60;
        };
        const ms = (...vs: unknown[]) => {
          const ns = vs.map(num).filter((n): n is number => n !== null && n >= 0);
          return ns.length ? inRange(Math.round(ns.reduce((a, b) => a + b, 0) / 1000), 0, 86_400) : null;
        };
        add("daily_steps", inRange(num(steps.value), 0, 200_000), null, at, id);
        add("daily_distanceInMeters", inRange(num(steps.distanceInMeters), 0, 500_000), "meters", at, id);
        add("daily_totalKilocalories", inRange(num(cal.burnedTotal), 0, 20_000), "kcal", at, id);
        add("daily_activeKilocalories", inRange(num(cal.burnedActive), 0, 20_000), "kcal", at, id);
        add("daily_bmrKilocalories", inRange(num(cal.burnedResting), 0, 10_000), "kcal", at, id);
        add("daily_restingHeartRateInBeatsPerMinute", inRange(num(hr.restingValue), 20, 200), "bpm", at, id);
        add("daily_minHeartRateInBeatsPerMinute", inRange(num(hr.minValue), 20, 250), "bpm", at, id);
        add("daily_maxHeartRateInBeatsPerMinute", inRange(num(hr.maxValue), 20, 250), "bpm", at, id);
        add("daily_moderateIntensityDurationInSeconds", minutes(im.moderate), "seconds", at, id);
        add("daily_vigorousIntensityDurationInSeconds", minutes(im.vigorous), "seconds", at, id);
        add("daily_averageStressLevel", inRange(num(st.avgLevel), 0, 100), null, at, id);
        add("daily_maxStressLevel", inRange(num(st.maxLevel), 0, 100), null, at, id);
        add(
          "daily_stressDurationInSeconds",
          ms(st.lowStressDurationInMillis, st.mediumStressDurationInMillis, st.highStressDurationInMillis),
          "seconds",
          at,
          id,
        );
        add("daily_restStressDurationInSeconds", ms(st.restDurationInMillis), "seconds", at, id);
        add("dailyBodyBattery_highestValue", inRange(num(bb.maxValue), 0, 100), null, at, id);
        add("dailyBodyBattery_lowestValue", inRange(num(bb.minValue), 0, 100), null, at, id);
        add("dailyBodyBattery_chargedValue", inRange(num(bb.chargedValue), 0, 200), null, at, id);
        add("dailyBodyBattery_drainedValue", inRange(num(bb.drainedValue), 0, 200), null, at, id);
        add("pulseOx_avgSpo2InPercent", inRange(num(ox.avgValue), 50, 100), "%", at, id);
        add("pulseOx_minSpo2InPercent", inRange(num(ox.minValue), 50, 100), "%", at, id);
      }

      const sleep = await read("Sleep", "/sleep-service/sleep/dailySleepSummariesByDate", { startDate: from, endDate: to });
      for (const r of arr(sleep)) {
        const day = isObj(r) ? dayOf(r.calendarDate) : null;
        if (!isObj(r) || !day) continue;
        const at = bounds(day);
        const id = `${day}#0`;
        const sec = (v: unknown) => inRange(num(v), 0, 86_400);
        const deep = sec(r.deepSleepSeconds);
        const light = sec(r.lightSleepSeconds);
        const rem = sec(r.remSleepSeconds);
        const staged = deep === null && light === null && rem === null ? null : (deep ?? 0) + (light ?? 0) + (rem ?? 0);
        const total = sec(r.sleepTimeSeconds) ?? staged;
        const scores = isObj(r.sleepScores) ? r.sleepScores : null;
        const overall = isObj(scores?.overall) ? (scores.overall as Obj) : null;
        add("sleep_durationInSeconds", total && total > 0 ? total : null, "seconds", at, id);
        add("sleep_deepSleepDurationInSeconds", deep, "seconds", at, id);
        add("sleep_lightSleepDurationInSeconds", light, "seconds", at, id);
        add("sleep_remSleepInSeconds", rem, "seconds", at, id);
        add("sleep_awakeDurationInSeconds", sec(r.awakeSleepSeconds), "seconds", at, id);
        add("sleep_averageSpO2", inRange(num(r.averageSpO2Value), 50, 100), "%", at, id);
        // avgHeartRate is documented but not always sent; averageSpO2HRSleep is the export's averageHR.
        add("sleep_averageHeartRateInBeatsPerMinute", inRange(num(r.avgHeartRate) ?? num(r.averageSpO2HRSleep), 20, 200), "bpm", at, id);
        add("sleep_averageRespiration", inRange(num(r.averageRespirationValue), 3, 60), "brpm", at, id);
        add("sleep_overallSleepScore", inRange(num(overall?.value), 0, 100), null, at, id);
      }

      const hrv = await read("HRV", `/hrv-service/hrv/daily/${from}/${to}`);
      for (const r of arr(isObj(hrv) ? hrv.hrvSummaries : null)) {
        const day = isObj(r) ? dayOf(r.calendarDate) : null;
        if (!isObj(r) || !day) continue;
        const at = bounds(day);
        add("hrv_lastNightAvg", inRange(num(r.lastNightAvg), 1, 300), "ms", at, `${day}#0`);
        add("hrv_lastNight5MinHigh", inRange(num(r.lastNight5MinHigh), 1, 300), "ms", at, `${day}#0`);
        add("hrv_weeklyAvg", inRange(num(r.weeklyAvg), 1, 300), "ms", at, `${day}#0`);
      }

      // weight/all answers HTTP 400 (checked 26 Oct 2026); weight/range with includeAll lists every weigh-in.
      const weights = await read("Weight", `/weight-service/weight/range/${from}/${to}`, { includeAll: "true" });
      for (const s of arr(isObj(weights) ? weights.dailyWeightSummaries : null)) {
        if (!isObj(s)) continue;
        const entries = arr(s.allWeightMetrics).length ? arr(s.allWeightMetrics) : [s.latestWeight];
        for (const r of entries) {
          const day = isObj(r) ? (dayOf(r.calendarDate) ?? dayOf(s.summaryDate)) : null;
          const w = isObj(r) ? num(r.weight) : null;
          // USER_SETTING is the profile weight, not a weigh-in (as in the export).
          if (!isObj(r) || !day || w === null || r.sourceType === "USER_SETTING") continue;
          // Documented as kilograms, sent as grams. Either way, store grams.
          const grams = w < 1000 ? Math.round(w * 1000) : w;
          const t = num(r.timestampGMT) ?? num(r.date);
          const at = t !== null ? { startMs: t, endMs: t, offsetMin: bounds(day).offsetMin } : bounds(day);
          add("body_weightInGrams", inRange(grams, 20_000, 400_000), "grams", at, `weight:${num(r.samplePk) ?? t ?? day}`);
        }
      }
    }

    // Activities: paged, filtered by local start day.
    for (let offset = 0; ; offset += ACTIVITY_PAGE) {
      const page = arr(
        await read("Activities", "/activitylist-service/activities/search/activities", {
          startDate: start,
          endDate: today,
          start: offset,
          limit: ACTIVITY_PAGE,
        }),
      );
      for (const a of page) this.addActivity(a, samples);
      if (page.length < ACTIVITY_PAGE) break;
    }

    log.debug("fetched", { samples: samples.length, warnings: warnings.length });
    // Re-fetch yesterday next time: it may have been incomplete at the last read.
    return { samples, catalog: catalogFor(samples), nextCursor: addDays(today, -1), warnings };
  }

  private addActivity(a: unknown, samples: SampleInput[]) {
    const id = isObj(a) ? num(a.activityId) : null;
    const gmt = isObj(a) ? (num(a.beginTimestamp) ?? naiveMs(a.startTimeGMT)) : null;
    if (!isObj(a) || id === null || gmt === null) return;
    const local = naiveMs(a.startTimeLocal);
    const gmtNaive = naiveMs(a.startTimeGMT) ?? gmt;
    const off = local !== null ? Math.round((local - gmtNaive) / 60_000) : 0;
    const durationS = inRange(num(a.duration), 0, 7 * 86_400);
    const at = { startMs: gmt, endMs: gmt + Math.round((durationS ?? 0) * 1000), offsetMin: Math.abs(off) <= 840 ? off : 0 };
    const ext = `activity:${id}`;
    const add = (metric: string, value: number | null, unit?: string) => {
      if (value !== null) samples.push({ source: GARMIN_SOURCE, device: DEVICE, externalId: ext, metric, ...at, valueNum: value, ...(unit ? { unit } : {}) });
    };
    const type = isObj(a.activityType) && typeof a.activityType.typeKey === "string" ? a.activityType.typeKey : null;
    if (type) samples.push({ source: GARMIN_SOURCE, device: DEVICE, externalId: ext, metric: "activity_activityType", ...at, valueText: type });
    const round = (v: number | null) => (v === null ? null : Math.round(v));
    add("activity_durationInSeconds", round(durationS), "seconds");
    add("activity_movingDurationInSeconds", round(inRange(num(a.movingDuration), 0, 7 * 86_400)), "seconds");
    add("activity_distanceInMeters", inRange(num(a.distance), 0, 1_000_000), "meters");
    add("activity_totalElevationGainInMeters", inRange(num(a.elevationGain), 0, 20_000), "meters");
    add("activity_activeKilocalories", inRange(num(a.calories), 0, 20_000), "kcal");
    add("activity_averageHeartRateInBeatsPerMinute", inRange(num(a.averageHR), 20, 250), "bpm");
    add("activity_maxHeartRateInBeatsPerMinute", inRange(num(a.maxHR), 20, 250), "bpm");
    add("activity_steps", inRange(num(a.steps), 0, 200_000));
    add("activity_aerobicTrainingEffect", inRange(num(a.aerobicTrainingEffect), 0, 5));
    add("activity_anaerobicTrainingEffect", inRange(num(a.anaerobicTrainingEffect), 0, 5));
    add("activity_vo2Max", inRange(num(a.vO2MaxValue), 10, 100), "ml/kg/min");
  }

  /** The account timezone from the profile settings, or the configured fallback. */
  private async timeZone(): Promise<string> {
    try {
      const s = await this.opts.api.get("/userprofile-service/userprofile/settings");
      const tz = isObj(s) && typeof s.timeZone === "string" ? s.timeZone : null;
      if (tz) {
        // Throws on a zone name the runtime does not know.
        void new Intl.DateTimeFormat("en", { timeZone: tz });
        return tz;
      }
    } catch (e) {
      // The key being wrong surfaces on the next call with a clear message; anything else falls back.
      if (e instanceof GarminApiError && (e.status === 401 || e.status === undefined)) throw e;
      log.debug("timezone not read, using fallback", { err: e });
    }
    return this.opts.timeZone;
  }
}
