/**
 * One tab at a time owns the web app's database (webDatabase.ts): two would overwrite each other's
 * saved copy. A Web Lock marks the owner. On a phone, Chrome freezes a tab in the background
 * instead of closing it, and a frozen tab keeps its lock, so the owner can be a tab nobody sees:
 * the tab in front can take the lock over ("Use Even here"), and the old one stops.
 */
export const TAB_LOCK = "even-db";
/** sessionStorage flag (this tab only, no data): the reload after "Use Even here" takes the lock. */
const TAKE_OVER_KEY = "even.db.takeOver";

type Locks = Pick<LockManager, "request">;

export interface TabLock {
  /** False when another tab owns the database. */
  held: boolean;
}

/**
 * Asks for the lock and keeps it for as long as the page lives. `takeOver` steals it from the tab
 * that has it; that tab's `onLost` runs, so it stops writing. Without Web Locks (old browsers)
 * the tab simply goes ahead, as before.
 */
export function holdTabLock(opts: { locks?: Locks | null; takeOver?: boolean; onLost: () => void }): Promise<TabLock> {
  // null: a browser without Web Locks (tests pass it); undefined: the real one, if any.
  const locks = opts.locks !== undefined ? opts.locks : typeof navigator !== "undefined" && "locks" in navigator ? navigator.locks : undefined;
  if (!locks) return Promise.resolve({ held: true });
  return new Promise((resolve) => {
    let held = false;
    const options: LockOptions = opts.takeOver ? { steal: true } : { ifAvailable: true };
    locks
      .request(TAB_LOCK, options, (lock) => {
        held = lock !== null;
        resolve({ held });
        // Held until the page goes: a promise that never settles.
        return held ? new Promise<void>(() => {}) : undefined;
      })
      // Another tab stole it: the request rejects (AbortError) in the tab that had it.
      .catch(() => {
        if (held) opts.onLost();
        else resolve({ held: false });
      });
  });
}

/** Marks this tab to take the lock over on its next load, then reloads it. */
export function takeOverOnReload(storage: Pick<Storage, "setItem"> = sessionStorage, reload: () => void = () => location.reload()): void {
  try {
    storage.setItem(TAKE_OVER_KEY, "1");
  } catch {
    // Storage blocked: the reload just asks again, and the screen offers the button again.
  }
  reload();
}

/** True once, on the load that follows takeOverOnReload. */
export function consumeTakeOver(storage: Pick<Storage, "getItem" | "removeItem"> = sessionStorage): boolean {
  try {
    const on = storage.getItem(TAKE_OVER_KEY) === "1";
    if (on) storage.removeItem(TAKE_OVER_KEY);
    return on;
  } catch {
    return false;
  }
}
