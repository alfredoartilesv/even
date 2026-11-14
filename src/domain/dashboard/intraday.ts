import { localDayStart } from "../../core/tz";

/** One point of a day's eaten-against-burned chart: an hour of the day, or the current time. */
export interface EnergyPoint {
  /** Minutes after the day's local midnight. */
  minute: number;
  /** Food and drinks logged up to this time, kcal. */
  eaten: number;
  /** The watch's burn up to this time: its day total spread evenly (see intradayEnergy). */
  burned: number | null;
}

/**
 * A day's calories eaten against burned, hour by hour (the owner's ask, 14 Nov 2026). Eaten adds
 * each meal and drink at the time it was logged. The watch only gives a day total for burned
 * (so far, on the current day), so burned grows evenly from midnight to that total: across the
 * whole day for a past one, up to now for today, with a last point at now. Null burned means the
 * watch has no number for the day.
 */
export function intradayEnergy(
  day: string,
  timeZone: string,
  logged: { atMs: number; kcal: number }[],
  burnedTotal: number | null,
  nowMs: number | null,
): EnergyPoint[] {
  const { startMs } = localDayStart(day, timeZone);
  // Today ends at now; a past day at its last hour (24 points after midnight).
  const endMin = nowMs === null ? 24 * 60 : Math.max(0, Math.min(24 * 60, Math.floor((nowMs - startMs) / 60_000)));
  const minutes: number[] = [];
  for (let m = 0; m <= endMin; m += 60) minutes.push(m);
  if (minutes[minutes.length - 1] !== endMin) {
    // The chart spaces points evenly, so a now just past the hour would draw its few minutes as a
    // whole step: then now takes that hour's place.
    if (minutes.length > 1 && endMin - minutes[minutes.length - 1] < 30) minutes.pop();
    minutes.push(endMin);
  }
  const sorted = [...logged].sort((a, b) => a.atMs - b.atMs);
  return minutes.map((minute) => {
    const at = startMs + minute * 60_000;
    const eaten = sorted.reduce((sum, e) => (e.atMs <= at ? sum + e.kcal : sum), 0);
    const burned = burnedTotal === null ? null : endMin === 0 ? 0 : (burnedTotal * minute) / endMin;
    return { minute, eaten: Math.round(eaten), burned: burned === null ? null : Math.round(burned) };
  });
}

/** "09:00" for a point's minute after midnight. */
export const clockOf = (minute: number) => `${String(Math.floor(minute / 60) % 24).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
