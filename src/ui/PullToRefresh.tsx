import { useEffect, useRef, useState, type ReactNode } from "react";
import { Icon } from "./icons";

/** How far (px, after damping) a pull goes before letting go starts the refresh, and the most it shows. */
export const PULL_TRIGGER = 64;
const PULL_MAX = 96;
/** Finger travel is halved, so the page follows the finger more slowly and the pull feels deliberate. */
const DAMPING = 0.5;

/** Pull distance on screen for a finger that moved dy px down (negative or zero: no pull). Pure. */
export const pullFor = (dy: number) => (dy <= 0 ? 0 : Math.min(PULL_MAX, dy * DAMPING));

/**
 * Pull down from the top of the page to refresh, as in most phone apps: a sync symbol comes down
 * with the finger, turns as it goes, says "Release to sync" past the trigger, and letting go there
 * calls onRefresh. Only from the very top, one finger, and not while a refresh is running.
 */
export function PullToRefresh({ onRefresh, busy, label = "sync", children }: { onRefresh: () => void; busy: boolean; label?: string; children: ReactNode }) {
  const [pull, setPull] = useState(0);
  const start = useRef<number | null>(null);
  const shown = useRef(0);
  // Read in the listeners, which are attached once.
  const latest = useRef({ onRefresh, busy });
  latest.current = { onRefresh, busy };

  useEffect(() => {
    const set = (p: number) => {
      shown.current = p;
      setPull(p);
    };
    const down = (e: TouchEvent) => {
      start.current = window.scrollY <= 0 && e.touches.length === 1 && !latest.current.busy ? e.touches[0].clientY : null;
    };
    const move = (e: TouchEvent) => {
      if (start.current === null) return;
      if (window.scrollY > 0) {
        start.current = null;
        return set(0);
      }
      set(pullFor(e.touches[0].clientY - start.current));
    };
    const up = () => {
      if (start.current !== null && shown.current >= PULL_TRIGGER) latest.current.onRefresh();
      start.current = null;
      set(0);
    };
    window.addEventListener("touchstart", down, { passive: true });
    window.addEventListener("touchmove", move, { passive: true });
    window.addEventListener("touchend", up);
    window.addEventListener("touchcancel", up);
    return () => {
      window.removeEventListener("touchstart", down);
      window.removeEventListener("touchmove", move);
      window.removeEventListener("touchend", up);
      window.removeEventListener("touchcancel", up);
    };
  }, []);

  const ready = pull >= PULL_TRIGGER;
  return (
    <>
      <div className={pull ? "ptr pulling" : "ptr"} style={{ height: pull }} aria-hidden={!pull}>
        {pull > 0 && (
          <div className={ready ? "ptr-mark ready" : "ptr-mark"} style={{ transform: `rotate(${pull * 3}deg)`, opacity: Math.min(1, pull / PULL_TRIGGER) }}>
            <Icon name="sync" size={26} />
          </div>
        )}
        {pull > 0 && <span className="small muted">{ready ? `Release to ${label}` : `Pull to ${label}`}</span>}
      </div>
      {children}
    </>
  );
}
