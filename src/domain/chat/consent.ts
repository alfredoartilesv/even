import type { SqlDriver } from "../../db/driver.js";
import { uuidv7 } from "../../core/uuidv7.js";
import { createLogger } from "../../core/log.js";

const log = createLogger("chat.consent");

/**
 * GDPR: health data is special-category data, so each kind of data sent to Claude needs
 * its own explicit consent, kept as history (newest row per scope is in force).
 *
 * - aggregate: the questions themselves, summaries (averages, ranges, trends, counts), goals and
 *   meal plans. Needed for any chat at all.
 * - raw: detailed records: one value per day of a metric, individual food log entries.
 * - note: text the owner wrote (day notes, mood and energy).
 * - photo: pictures the owner attaches (for example of a meal).
 * - file: documents the owner attaches (a lab report PDF, a CSV or text export).
 */
export type DataClass = "aggregate" | "raw" | "note" | "photo" | "file";
export type ConsentScope = "claude.aggregates" | "claude.raw_series" | "claude.notes" | "claude.photos" | "claude.files";

export const SCOPE_FOR: Record<DataClass, ConsentScope> = {
  aggregate: "claude.aggregates",
  raw: "claude.raw_series",
  note: "claude.notes",
  photo: "claude.photos",
  file: "claude.files",
};

/** Text the UI shows when asking. Change a text -> bump its version: older consents to it stop counting. */
export const CONSENT_TEXT: Record<ConsentScope, string> = {
  "claude.aggregates":
    "Send your questions, and summaries of your health data (averages, ranges, trends, counts), your goals and meal plans, to Anthropic's Claude API to answer them.",
  "claude.raw_series": "Also send detailed records when Claude asks for them: day-by-day values of a metric and individual food log entries.",
  "claude.notes": "Also send the notes you wrote (day notes, mood and energy) when Claude asks for them.",
  "claude.photos": "Send the photos you attach in the chat (for example of a meal) to Claude so it can look at them.",
  "claude.files": "Send the files you attach in the chat (for example a lab report PDF or a CSV export) to Claude so it can read them.",
};

/**
 * The health connector (docs/users.md section 10): Claude's own apps (claude.ai, the Claude app),
 * on the owner's Claude plan, reach the data through Even's server instead of this phone, so they
 * have their own consents. The class consents above still decide what each tool may send.
 */
export type ConnectorScope = "claude.connector" | "claude.connector_changes";

export const CONNECTOR_TEXT: Record<ConnectorScope, string> = {
  "claude.connector":
    "Let Claude's own apps (claude.ai, the Claude app), signed in to your Claude account, ask Even about your data through the Even connector. While a connection is live, Even's server opens your synced data to answer each request and keeps nothing readable afterwards. What Claude receives then falls under your Claude plan's terms. The choices above still decide what kinds of data it may get.",
  "claude.connector_changes":
    "Also let Claude add entries through the connector: food, drinks, meal prep, shopping, measurements, notes and goals. Claude asks you before each one, and you can undo any of them here.",
};

export const CONSENT_POLICY_VERSION: Record<ConsentScope | ConnectorScope, string> = {
  "claude.aggregates": "2026-10-25",
  "claude.raw_series": "2026-10-25",
  "claude.notes": "2026-10-25",
  "claude.photos": "2026-10-25",
  "claude.files": "2026-10-28",
  "claude.connector": "2026-10-31",
  "claude.connector_changes": "2026-10-31",
};

export const ALL_SCOPES = Object.keys(CONSENT_TEXT) as ConsentScope[];
export const CONNECTOR_SCOPES = Object.keys(CONNECTOR_TEXT) as ConnectorScope[];

export async function hasConsent(db: SqlDriver, scope: ConsentScope | ConnectorScope): Promise<boolean> {
  // Tie-break on rowid (insertion order): UUIDv7 ids are not ordered within one millisecond.
  const rows = await db.all<{ granted: number; policy_version: string }>(
    `SELECT granted, policy_version FROM consents
     WHERE scope = ? AND deleted_at IS NULL
     ORDER BY decided_at_ms DESC, rowid DESC LIMIT 1`,
    [scope],
  );
  const r = rows[0];
  return r !== undefined && r.granted === 1 && r.policy_version === CONSENT_POLICY_VERSION[scope];
}

export async function recordConsent(
  db: SqlDriver,
  scope: ConsentScope | ConnectorScope,
  granted: boolean,
  deviceId: string,
  nowMs: number = Date.now(),
): Promise<void> {
  await db.run(
    `INSERT INTO consents (id, scope, granted, decided_at_ms, policy_version, created_at, updated_at, origin_device_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [uuidv7(nowMs), scope, granted ? 1 : 0, nowMs, CONSENT_POLICY_VERSION[scope], nowMs, nowMs, deviceId],
  );
  log.info("consent recorded", { scope, granted, policy: CONSENT_POLICY_VERSION[scope] });
}

export async function consentStatus(db: SqlDriver): Promise<Record<ConsentScope, boolean>> {
  const out = {} as Record<ConsentScope, boolean>;
  for (const s of ALL_SCOPES) out[s] = await hasConsent(db, s);
  return out;
}
