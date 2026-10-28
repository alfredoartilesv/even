import { createLogger } from "../../core/log";
import { addDays } from "../../core/tz";
import type { SqlDriver } from "../../db/driver";
import { ETHANOL_DENSITY } from "../../core/health";
import { SHARE_DAYS, type Friend, type Share, type ShareKind, type ShareRow } from "../../core/syncWire";
import { nutritionRange } from "../food/food";
import { metricsDays } from "../metrics/queries";
import type { SyncApi } from "./api";
import { aesOpen, aesSeal, openJson, randomBytes, sealJson, sharedKey } from "./keys";
import type { SyncSession } from "./session";

const log = createLogger("cloudsync.friends");

/**
 * What a friend is shown (docs/users.md section 2.4): per kind, one small summary per day, never
 * the rows behind it. Each (owner, friend, kind) has its own share key, wrapped with the ECDH key
 * of the two accounts' identity keys, so either account's devices can open it and nobody else.
 */
export interface KindField {
  key: string;
  label: string;
  unit: string;
  /** Divides the stored value for display (seconds to hours, grams to kg). */
  scale?: number;
  digits?: number;
}

const METRIC_KINDS: Partial<Record<ShareKind, (KindField & { metric: string })[]>> = {
  activity: [
    { key: "steps", metric: "daily_steps", label: "Steps", unit: "" },
    { key: "activeKcal", metric: "daily_activeKilocalories", label: "Active", unit: "kcal" },
    { key: "distanceKm", metric: "daily_distanceInMeters", label: "Distance", unit: "km", scale: 1000, digits: 1 },
    { key: "intenseMin", metric: "daily_vigorousIntensityDurationInSeconds", label: "Vigorous", unit: "min", scale: 60 },
  ],
  sleep: [
    { key: "sleepH", metric: "sleep_durationInSeconds", label: "Sleep", unit: "h", scale: 3600, digits: 1 },
    { key: "score", metric: "sleep_overallSleepScore", label: "Score", unit: "" },
  ],
  recovery: [
    { key: "restingHr", metric: "daily_restingHeartRateInBeatsPerMinute", label: "Resting HR", unit: "bpm" },
    { key: "hrv", metric: "hrv_lastNightAvg", label: "HRV", unit: "ms" },
    { key: "bodyBattery", metric: "dailyBodyBattery_highestValue", label: "Body battery", unit: "" },
    { key: "stress", metric: "daily_averageStressLevel", label: "Stress", unit: "" },
  ],
  weight: [{ key: "weightKg", metric: "body_weightInGrams", label: "Weight", unit: "kg", scale: 1000, digits: 1 }],
};

export const KIND_FIELDS: Record<ShareKind, KindField[]> = {
  activity: METRIC_KINDS.activity!,
  sleep: METRIC_KINDS.sleep!,
  recovery: METRIC_KINDS.recovery!,
  weight: METRIC_KINDS.weight!,
  nutrition: [
    { key: "kcal", label: "Eaten", unit: "kcal" },
    { key: "proteinG", label: "Protein", unit: "g" },
    { key: "carbsG", label: "Carbs", unit: "g" },
    { key: "fatG", label: "Fat", unit: "g" },
  ],
  alcohol: [{ key: "alcoholG", label: "Alcohol", unit: "g", digits: 0 }],
};

export const KIND_LABEL: Record<ShareKind, string> = {
  activity: "Activity",
  sleep: "Sleep",
  recovery: "Recovery",
  weight: "Weight",
  nutrition: "Nutrition totals",
  alcohol: "Alcohol",
};

export type DaySummary = Record<string, number>;

/** One kind's summaries, from..to (inclusive). Days with nothing are left out. */
export async function summaries(db: SqlDriver, kind: ShareKind, from: string, to: string): Promise<Map<string, DaySummary>> {
  const out = new Map<string, DaySummary>();
  const put = (day: string, key: string, v: number | null | undefined) => {
    if (v === null || v === undefined || !Number.isFinite(v)) return;
    out.set(day, { ...out.get(day), [key]: Math.round(v * 10) / 10 });
  };
  const fields = METRIC_KINDS[kind];
  if (fields) {
    const days = await metricsDays(
      db,
      fields.map((f) => f.metric),
      from,
      to,
    );
    for (const f of fields) for (const [day, v] of days.get(f.metric)!.values) put(day, f.key, v);
  } else if (kind === "nutrition") {
    for (const d of await nutritionRange(db, from, to)) {
      if (d.entries === 0) continue;
      put(d.day, "kcal", d.calories);
      put(d.day, "proteinG", d.proteinG);
      put(d.day, "carbsG", d.carbsG);
      put(d.day, "fatG", d.fatG);
    }
  } else {
    const rows = await db.all<{ day: string; g: number }>(
      `SELECT local_day AS day, SUM(volume_ml * abv_percent / 100.0 * ?) AS g FROM drink_entries
        WHERE deleted_at IS NULL AND local_day BETWEEN ? AND ? GROUP BY local_day`,
      [ETHANOL_DENSITY, from, to],
    );
    for (const r of rows) put(r.day, "alcoholG", r.g);
  }
  return out;
}

const SHARE_INFO = "even-share-v1";
const otherSide = (s: Share, me: string) => (s.ownerId === me ? s.friendId : s.ownerId);

/** The AES key of a share, from either side. */
async function shareAesKey(session: SyncSession, share: Share, friends: Friend[]): Promise<CryptoKey> {
  const friend = friends.find((f) => f.accountId === otherSide(share, session.accountId));
  if (!friend) throw new Error("That friend is gone");
  const raw = await aesOpen(
    await sharedKey(session.identityPrivate, friend.identityPublic, SHARE_INFO),
    share.wrappedKey,
    `share:${share.ownerId}:${share.friendId}:${share.kind}`,
  );
  return crypto.subtle.importKey("raw", raw as BufferSource, "AES-GCM", false, ["encrypt", "decrypt"]);
}

/** Starts (or re-keys) sharing one kind with one friend. Its days follow on the next sync. */
export async function shareKind(api: SyncApi, session: SyncSession, friend: Friend, kind: ShareKind): Promise<Share> {
  const wrapped = await aesSeal(
    await sharedKey(session.identityPrivate, friend.identityPublic, SHARE_INFO),
    randomBytes(32),
    `share:${session.accountId}:${friend.accountId}:${kind}`,
  );
  const share = await api.share(friend.accountId, kind, wrapped);
  log.info("kind shared", { share: share.id, kind });
  return share;
}

/** Sends this account's summaries for every kind it shares: the last SHARE_DAYS days, sealed per day. */
export async function pushShares(db: SqlDriver, api: SyncApi, session: SyncSession, today: string, nowMs = Date.now()): Promise<number> {
  const { outgoing } = await api.shares();
  if (outgoing.length === 0) return 0;
  const friends = await api.friends();
  const from = addDays(today, -(SHARE_DAYS - 1));
  const byKind = new Map<ShareKind, Map<string, DaySummary>>();
  let sent = 0;
  for (const share of outgoing) {
    const key = await shareAesKey(session, share, friends);
    if (!byKind.has(share.kind)) byKind.set(share.kind, await summaries(db, share.kind, from, today));
    const rows: ShareRow[] = [];
    for (const [day, values] of byKind.get(share.kind)!) rows.push({ day, updatedAt: nowMs, blob: await sealJson(key, values, `${share.id}:${day}`) });
    if (rows.length) sent += (await api.pushShareRows(share.id, rows)).accepted;
  }
  log.info("shares sent", { shares: outgoing.length, days: sent });
  return sent;
}

export interface FriendKind {
  share: Share;
  days: { day: string; values: DaySummary }[];
}

/** What a friend shares with this account, newest day first, per kind. Read from the server each time, kept nowhere. */
export async function friendData(api: SyncApi, session: SyncSession, friendId: string): Promise<FriendKind[]> {
  const [{ incoming }, friends] = await Promise.all([api.shares(), api.friends()]);
  const out: FriendKind[] = [];
  for (const share of incoming.filter((s) => s.ownerId === friendId)) {
    const key = await shareAesKey(session, share, friends);
    const days: FriendKind["days"] = [];
    for (let after = -1; ;) {
      const page = await api.pullShareRows(share.id, after, 500);
      for (const r of page.rows) {
        try {
          days.push({ day: r.day, values: await openJson<DaySummary>(key, r.blob, `${share.id}:${r.day}`) });
        } catch {
          // A day sealed with an older key (the share was re-keyed): the next sync replaces it.
        }
      }
      after = page.next;
      if (!page.more) break;
    }
    days.sort((a, b) => (a.day < b.day ? 1 : -1));
    out.push({ share, days });
  }
  return out;
}
