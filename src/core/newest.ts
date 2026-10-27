/**
 * For async loads that can overlap: each call starts one and returns a check that stays true only
 * while no later one has started. A screen applies an answer only if it is still the newest, so a
 * slow earlier answer never replaces a newer one.
 */
export function newestOnly(): () => () => boolean {
  let n = 0;
  return () => {
    const ticket = ++n;
    return () => ticket === n;
  };
}
