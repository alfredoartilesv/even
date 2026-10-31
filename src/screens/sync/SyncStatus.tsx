import { useState } from "react";
import { Icon } from "../../ui/icons";
import type { LastSync } from "../../domain/sync/runSync";
import { ago, freshness } from "../../domain/sync/reminder";

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

/**
 * Notice on every tab when Garmin is 3+ days behind or the last attempt failed. It floats over the
 * top of the page like a phone notification instead of pushing the page down, and can be closed:
 * closing hides this failure or this stale stretch only, so the next failure or the next gap shows
 * again. Soft amber with the title in the text color, so it reads as a notice rather than an alarm.
 */
export function SyncBanner({ status, configured, syncing, nowMs, onSync }: Props) {
  const [closed, setClosed] = useState<string | null>(null);
  if (!configured) return null;
  const f = freshness(status?.lastOkMs ?? null, nowMs);
  const failed = status?.status === "error";
  if (f.state !== "stale" && !failed) return null;
  const key = failed ? `failed:${status?.startedMs}` : `stale:${status?.lastOkMs}`;
  if (closed === key) return null;
  const days = f.state === "stale" ? Math.floor(f.ageMs / 86_400_000) : 0;
  const detail = failed ? status?.error : null;
  return (
    <div className={`banner${detail ? " detailed" : ""}`} role="status">
      <span className="banner-icon">
        <Icon name="alert" size={20} />
      </span>
      <div className="banner-text">
        <strong>{f.state === "stale" ? `No Garmin sync for ${days} days` : "Garmin sync failed"}</strong>
        {detail && <div className="small">{detail}</div>}
      </div>
      <button type="button" className="secondary banner-action" onClick={onSync} disabled={syncing}>
        <span className={syncing ? "spin" : ""}>
          <Icon name="sync" size={18} />
        </span>
        {syncing ? "Syncing…" : failed ? "Try again" : "Sync now"}
      </button>
      <button type="button" className="icon-button banner-close" onClick={() => setClosed(key)} aria-label="Close" title="Close">
        <Icon name="close" size={18} />
      </button>
    </div>
  );
}
