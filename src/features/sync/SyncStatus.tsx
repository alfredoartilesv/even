import type { LastSync } from "./runSync";
import { ago, freshness } from "./reminder";

interface Props {
  status: LastSync | null;
  configured: boolean;
  syncing: boolean;
  nowMs: number;
  onSync: () => void;
}

/** Header sync button: when Garmin last synced, and a tap to sync now. */
export function SyncButton({ status, configured, syncing, nowMs, onSync }: Props) {
  const f = freshness(status?.lastOkMs ?? null, nowMs);
  const label = syncing ? "Syncing…" : f.state === "never" ? "Sync" : `Synced ${ago(f.ageMs)}`;
  return (
    <button
      className={f.state === "stale" || status?.status === "error" ? "sync-button stale" : "sync-button secondary"}
      onClick={onSync}
      disabled={!configured || syncing}
      title={configured ? "Sync with Garmin now" : "Add your Garmin key in Settings first"}
      aria-label={`${label}. Sync with Garmin now`}
    >
      <span aria-hidden className={syncing ? "spin" : ""}>
        ⟳
      </span>{" "}
      {label}
    </button>
  );
}

/** Banner on every tab when Garmin is 3+ days behind or the last attempt failed. */
export function SyncBanner({ status, configured, syncing, nowMs, onSync }: Props) {
  if (!configured) return null;
  const f = freshness(status?.lastOkMs ?? null, nowMs);
  const failed = status?.status === "error";
  if (f.state !== "stale" && !failed) return null;
  const days = f.state === "stale" ? Math.floor(f.ageMs / 86_400_000) : 0;
  return (
    <div className="banner" role="status">
      <div>
        {f.state === "stale" ? (
          <strong>No Garmin sync for {days} days.</strong>
        ) : (
          <strong>The last sync failed.</strong>
        )}
        {failed && status?.error && <div className="small">{status.error}</div>}
      </div>
      <button onClick={onSync} disabled={syncing}>
        {syncing ? "Syncing…" : "Sync now"}
      </button>
    </div>
  );
}
