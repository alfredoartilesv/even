import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { SqlDriver } from "../../db/driver";
import { Icon } from "../../ui/icons";
import type { LastSync } from "../../domain/sync/runSync";
import { ago, freshness, markNoticeSeen, seenNotice, syncNotice } from "../../domain/sync/reminder";

interface Props {
  status: LastSync | null;
  configured: boolean;
  syncing: boolean;
  nowMs: number;
  onSync: () => void;
}

/**
 * Header sync button: the sync symbol alone, without a frame, so the header keeps room for the
 * greeting (the owner preferred it to the board's pill). What it would say ("Synced 5 min ago") is
 * its tooltip and screen-reader label; it spins while syncing and turns amber when the last sync is
 * old or failed. Without a Garmin key it opens You > Connections (onSetup) instead of sitting there disabled.
 */
export function SyncButton({ status, configured, syncing, nowMs, onSync, onSetup }: Props & { onSetup: () => void }) {
  const f = freshness(status?.lastOkMs ?? null, nowMs);
  const label = !configured ? "Set up Garmin sync" : syncing ? "Syncing…" : f.state === "never" ? "Not synced yet" : `Synced ${ago(f.ageMs)}`;
  const action = configured ? "Sync with Garmin now" : "Add your Garmin key in You, Connections";
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
        <Icon name="sync" size={28} />
      </span>
    </button>
  );
}

/**
 * Today's bell (the owner's choice, 14 Nov 2026, in place of the banner over every page): a dot in
 * the accent color when there is a notice not yet seen (the last Garmin sync failed, or none for
 * 3 days); a tap opens the list with Try again, and marks it seen until the next one. The notice
 * stays listed until a sync works.
 */
export function NotificationBell({ db, status, configured, syncing, nowMs, onSync }: Props & { db: SqlDriver | null }) {
  const [open, setOpen] = useState(false);
  const [seen, setSeen] = useState<string | null | undefined>(undefined);
  const wrap = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  // Where the panel goes: under the bell, right-aligned with it. It is drawn on the page itself
  // (a portal), because the header's fade mask would hide anything hanging below the header.
  const [at, setAt] = useState<{ top: number; right: number } | null>(null);
  const notice = syncNotice(status, configured, nowMs);
  const fresh = notice !== null && seen !== undefined && seen !== notice.key;

  useEffect(() => {
    // The component gallery has no database: nothing is remembered there.
    if (!db) setSeen(null);
    else void seenNotice(db).then(setSeen, () => setSeen(null));
  }, [db]);
  // Closes on a tap outside or Escape, as menus do.
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!wrap.current?.contains(t) && !panel.current?.contains(t)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", away);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("pointerdown", away);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);

  const toggle = () => {
    if (!open && notice && seen !== notice.key) {
      setSeen(notice.key);
      if (db) void markNoticeSeen(db, notice.key);
    }
    const r = wrap.current?.getBoundingClientRect();
    if (!open && r) setAt({ top: r.bottom + 4, right: Math.max(16, window.innerWidth - r.right) });
    setOpen(!open);
  };
  const label = fresh ? "Notifications, 1 new" : "Notifications";
  return (
    <div className="bell-wrap" ref={wrap}>
      <button
        type="button"
        className={`bell-button icon-button${open ? " open" : ""}`}
        aria-label={label}
        title={label}
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={toggle}
      >
        <Icon name="bell" size={26} />
        {fresh && <span className="bell-dot" aria-hidden />}
      </button>
      {open &&
        at &&
        createPortal(
          <div className="bell-panel" role="dialog" aria-label="Notifications" ref={panel} style={{ top: at.top, right: at.right }}>
            <strong className="bell-title">Notifications</strong>
            {notice ? (
              <div className="bell-item">
                <span className="bell-item-icon">
                  <Icon name="alert" size={18} />
                </span>
                <div className="bell-item-text">
                  <strong>{notice.title}</strong>
                  <div className="muted small">
                    {notice.detail ? `${notice.detail} ` : ""}
                    {notice.failed ? ago(Math.max(0, nowMs - notice.atMs)) : `Last sync ${ago(Math.max(0, nowMs - notice.atMs))}`}
                  </div>
                  <button type="button" className="secondary bell-action" onClick={onSync} disabled={syncing}>
                    <span className={syncing ? "spin" : ""}>
                      <Icon name="sync" size={16} />
                    </span>
                    {syncing ? "Syncing…" : notice.failed ? "Try again" : "Sync now"}
                  </button>
                </div>
              </div>
            ) : (
              <p className="muted small bell-empty">Nothing new.</p>
            )}
          </div>,
          document.body,
        )}
    </div>
  );
}
