import { Icon } from "../../ui/icons";
import type { LastSync } from "./runSync";
import { ago, freshness } from "./reminder";

interface Props {
  status: LastSync | null;
  configured: boolean;
  syncing: boolean;
  nowMs: number;
  onSync: () => void;
}

/**
 * Header sync button: the sync symbol alone, large and without a frame, so the header keeps room for the greeting. What it would
 * say ("Synced 5 min ago") is its tooltip and screen-reader label; it spins while syncing and turns
 * amber when the last sync is old or failed. Without a Garmin key it opens Settings > Connections
 * (onSetup) instead of sitting there disabled.
 */
export function SyncButton({ status, configured, syncing, nowMs, onSync, onSetup }: Props & { onSetup: () => void }) {
  const f = freshness(status?.lastOkMs ?? null, nowMs);
  const label = !configured ? "Set up Garmin sync" : syncing ? "Syncing…" : f.state === "never" ? "Not synced yet" : `Synced ${ago(f.ageMs)}`;
  const action = configured ? "Sync with Garmin now" : "Add your Garmin key in Settings";
  const stale = configured && (f.state === "stale" || status?.status === "error");
  return (
    <button
      type="button"
      className={`sync-button icon-button${stale ? " stale" : ""}`}
      onClick={configured ? onSync : onSetup}
      disabled={syncing}
      title={`${label}. ${action}`}
      aria-label={`${label}. ${action}`}
    >
      <span className={syncing ? "spin" : ""}>
        <Icon name="sync" size={30} />
      </span>
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
        {f.state === "stale" ? <strong>No Garmin sync for {days} days.</strong> : <strong>The last sync failed.</strong>}
        {failed && status?.error && <div className="small">{status.error}</div>}
      </div>
      <button onClick={onSync} disabled={syncing}>
        {syncing ? "Syncing…" : "Sync now"}
      </button>
    </div>
  );
}
