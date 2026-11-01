import { useEffect, useState } from "react";
import type { SqlDriver } from "../../db/driver";
import { lastBackupSaved } from "../../domain/backup/backup";
import { chatAvailable } from "../../domain/chat/mode";
import { getCalorieGoal } from "../../domain/food/food";
import { loadIdentity } from "../../domain/settings/profile";
import { dataInventory, type InventoryRow } from "../../domain/settings/dataInventory";
import type { SecretStore } from "../../domain/settings/secrets";
import { garminConnection } from "../../domain/sync/garminConnect";
import { APP_VERSION } from "../../platform/buildInfo";
import { platformName } from "../../platform/device";
import { fmtDay } from "../../ui/common";

export const PLATFORM: Record<string, string> = { android: "Android", ios: "iOS", web: "Browser" };

/** Where each settings page stands, in a few words, for the menu rows and the wide overview. */
export interface SettingsSummary {
  name: string | null;
  photo: string | null;
  calorieTarget: number | null;
  garmin: "connected" | "not_connected" | "needs_attention";
  chatOn: boolean;
  lastBackupMs: number | null;
  schema: number | null;
  inventory: InventoryRow[];
}

export function useSettingsSummary(db: SqlDriver, secrets: SecretStore, version: number): SettingsSummary | null {
  const [s, setS] = useState<SettingsSummary | null>(null);
  useEffect(() => {
    let live = true;
    void Promise.all([
      loadIdentity(db),
      getCalorieGoal(db),
      garminConnection(db, secrets).catch(() => null),
      chatAvailable(secrets).catch(() => false),
      lastBackupSaved(db),
      db.all<{ user_version: number }>("PRAGMA user_version"),
      dataInventory(db),
    ]).then(([who, goal, garmin, chatOn, backup, v, inventory]) => {
      if (!live) return;
      setS({
        name: who.name,
        photo: who.photo,
        calorieTarget: goal?.target ?? null,
        garmin: garmin?.status ?? "not_connected",
        chatOn,
        lastBackupMs: backup,
        schema: Number(v[0]?.user_version ?? 0) || null,
        inventory,
      });
    });
    return () => void (live = false);
  }, [db, secrets, version]);
  return s;
}

const GARMIN_WORD = { connected: "Garmin connected", not_connected: "Garmin not connected", needs_attention: "Garmin needs attention" } as const;

export const hints = (s: SettingsSummary) => ({
  profile: [s.name, s.calorieTarget !== null && `${Math.round(s.calorieTarget).toLocaleString()} kcal target`].filter(Boolean).join(" · ") || undefined,
  connections: `${GARMIN_WORD[s.garmin]} · Chat ${s.chatOn ? "on" : "off"}`,
  privacy: s.lastBackupMs ? `Backed up ${fmtDay(new Date(s.lastBackupMs).toLocaleDateString("en-CA"))}` : "No backup yet",
  about: `${APP_VERSION} · ${PLATFORM[platformName] ?? platformName}${s.schema ? ` · schema v${s.schema}` : ""}`,
});

/** A backup older than this is worth a nudge on the menu. */
const STALE_MS = 30 * 86_400_000;
export const backupDue = (s: SettingsSummary, nowMs: number = Date.now()) => s.lastBackupMs === null || nowMs - s.lastBackupMs > STALE_MS;

/** What is stored, as label and count cells, with the days it spans; empty kinds in one line under. */
export function InventoryGrid({ rows, wide = false }: { rows: InventoryRow[]; wide?: boolean }) {
  const stored = rows.filter((r) => r.count > 0 && !r.label.startsWith("Data sent"));
  const empty = rows.filter((r) => r.count === 0);
  return (
    <>
      <dl className={wide ? "inventory wide" : "inventory"}>
        {stored.map((r) => (
          <div key={r.label}>
            <dt>
              {r.label.replace(/ \((?!synced).*\)$/, "")}
              {wide && r.from && r.to && (
                <span className="muted small block">
                  {fmtDay(r.from)} to {fmtDay(r.to)}
                </span>
              )}
            </dt>
            <dd>{r.count.toLocaleString()}</dd>
          </div>
        ))}
      </dl>
      {wide && empty.length > 0 && (
        <p className="muted small">Nothing stored yet: {empty.map((r) => r.label.replace(/ \(.*\)$/, "").toLowerCase()).join(", ")}.</p>
      )}
    </>
  );
}
