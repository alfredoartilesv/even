/**
 * Calls `fn` at once, then at most once every `ms`: calls in between run once when the wait
 * ends, so the last one is never lost. For a sync that stores many pages a second, where the
 * screens should reload as rows arrive but not on every page.
 */
export function throttle(fn: () => void, ms: number, timers: Pick<typeof globalThis, "setTimeout"> = globalThis): () => void {
  let waiting = false;
  let again = false;
  const run = () => {
    if (waiting) {
      again = true;
      return;
    }
    fn();
    waiting = true;
    timers.setTimeout(() => {
      waiting = false;
      if (!again) return;
      again = false;
      run();
    }, ms);
  };
  return run;
}
