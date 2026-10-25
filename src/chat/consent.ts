import type { SqlDriver } from "../db/driver";
import { uuidv7 } from "../lib/uuidv7";

/**
 * GDPR: health data is special-category data, so each kind of data sent to Claude needs
 * its own explicit consent, kept as history (newest row per scope is in force).
 *
 * - aggregates: summaries (averages, ranges, trends, counts). Needed for any chat at all,
 *   because the question itself and every tool answer leave the phone.
 * - raw_series: one value per day, or individual readings.
 * - notes: text the user wrote (day notes).
 */
export type DataClass = "aggregate" | "raw" | "note";
export type ConsentScope = "claude.aggregates" | "claude.raw_series" | "claude.notes";

export const SCOPE_FOR: Record<DataClass, ConsentScope> = {
  aggregate: "claude.aggregates",
  raw: "claude.raw_series",
  note: "claude.notes",
};

/** Bump when the wording shown to the user changes; older consents then no longer count. */
export const CONSENT_POLICY_VERSION = "2026-10-25";

/** Text the UI shows when asking. Keep in step with CONSENT_POLICY_VERSION. */
export const CONSENT_TEXT: Record<ConsentScope, string> = {
  "claude.aggregates":
    "Send your questions and summaries of your health data (averages, ranges, trends, counts) to Anthropic's Claude API to answer them.",
  "claude.raw_series": "Also send day-by-day values of a metric when Claude asks for them.",
  "claude.notes": "Also send the notes you wrote (day notes, mood and energy) when Claude asks for them.",
};

export async function hasConsent(db: SqlDriver, scope: ConsentScope): Promise<boolean> {
  // Tie-break on rowid (insertion order): UUIDv7 ids are not ordered within one millisecond.
  const rows = await db.all<{ granted: number; policy_version: string }>(
    `SELECT granted, policy_version FROM consents
     WHERE scope = ? AND deleted_at IS NULL
     ORDER BY decided_at_ms DESC, rowid DESC LIMIT 1`,
    [scope],
  );
  const r = rows[0];
  return r !== undefined && r.granted === 1 && r.policy_version === CONSENT_POLICY_VERSION;
}

export async function recordConsent(
  db: SqlDriver,
  scope: ConsentScope,
  granted: boolean,
  deviceId: string,
  nowMs: number = Date.now(),
): Promise<void> {
  await db.run(
    `INSERT INTO consents (id, scope, granted, decided_at_ms, policy_version, created_at, updated_at, origin_device_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [uuidv7(nowMs), scope, granted ? 1 : 0, nowMs, CONSENT_POLICY_VERSION, nowMs, nowMs, deviceId],
  );
}

export async function consentStatus(db: SqlDriver): Promise<Record<ConsentScope, boolean>> {
  return {
    "claude.aggregates": await hasConsent(db, "claude.aggregates"),
    "claude.raw_series": await hasConsent(db, "claude.raw_series"),
    "claude.notes": await hasConsent(db, "claude.notes"),
  };
}
