/** Small, dependency-free timezone helpers built on Intl (no date library). */

/** Minutes east of UTC for an IANA zone at a given instant (DST-aware). */
export function tzOffsetMinutes(ms: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "longOffset" }).formatToParts(new Date(ms));
  const name = parts.find((p) => p.type === "timeZoneName")?.value ?? "GMT";
  const m = /GMT([+-])(\d{2}):(\d{2})/.exec(name);
  if (!m) return 0; // plain "GMT" means offset 0
  const sign = m[1] === "-" ? -1 : 1;
  return sign * (Number(m[2]) * 60 + Number(m[3]));
}

function parseDay(day: string): [number, number, number] {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!m) throw new Error(`Bad date (expected YYYY-MM-DD): ${day}`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/** Start of a local calendar day as UTC ms, plus the zone offset in force at that moment. */
export function localDayStart(day: string, timeZone: string): { startMs: number; offsetMin: number } {
  const [y, mo, d] = parseDay(day);
  const utcMidnight = Date.UTC(y, mo - 1, d);
  let offsetMin = tzOffsetMinutes(utcMidnight, timeZone);
  let startMs = utcMidnight - offsetMin * 60_000;
  const check = tzOffsetMinutes(startMs, timeZone);
  if (check !== offsetMin) {
    offsetMin = check;
    startMs = utcMidnight - offsetMin * 60_000;
  }
  return { startMs, offsetMin };
}

/** Local calendar date (YYYY-MM-DD) of an instant in a zone. */
export function localDay(ms: number, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(ms));
}

/**
 * A local wall-clock time (YYYY-MM-DD + HH:MM) in a zone, as UTC ms plus the offset in force then.
 * On the DST fall-back hour the earlier (summer-time) instant wins; a time skipped by spring-forward
 * resolves to the instant one hour later, as clocks do.
 */
export function localDateTimeToMs(day: string, time: string, timeZone: string): { ms: number; offsetMin: number } {
  const [y, mo, d] = parseDay(day);
  const t = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(time);
  if (!t) throw new Error(`Bad time (expected HH:MM): ${time}`);
  const wall = Date.UTC(y, mo - 1, d, Number(t[1]), Number(t[2]));
  // Try the offsets in force just before and after: the first that maps back to this wall time wins.
  for (const probe of [wall - 12 * 3_600_000, wall + 12 * 3_600_000]) {
    const offsetMin = tzOffsetMinutes(probe, timeZone);
    const ms = wall - offsetMin * 60_000;
    if (tzOffsetMinutes(ms, timeZone) === offsetMin) return { ms, offsetMin };
  }
  // Skipped hour: read it with the offset from before the jump, which lands after the gap.
  const ms = wall - tzOffsetMinutes(wall - 12 * 3_600_000, timeZone) * 60_000;
  return { ms, offsetMin: tzOffsetMinutes(ms, timeZone) };
}

/** Add whole calendar days to a YYYY-MM-DD string. */
export function addDays(day: string, n: number): string {
  const [y, mo, d] = parseDay(day);
  return new Date(Date.UTC(y, mo - 1, d + n)).toISOString().slice(0, 10);
}
