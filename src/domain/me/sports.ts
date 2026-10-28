/**
 * Sports the owner can pick as theirs, and how a Garmin activity type ("running",
 * "TREADMILL_RUNNING", "lap_swimming"...) maps onto one. Pure.
 */

export const SPORTS = [
  { id: "running", label: "Running", match: /run/ },
  { id: "walking", label: "Walking", match: /walk/ },
  { id: "hiking", label: "Hiking", match: /hik|mountaineer/ },
  { id: "cycling", label: "Cycling", match: /cycl|bik|ride/ },
  { id: "swimming", label: "Swimming", match: /swim/ },
  { id: "strength", label: "Strength", match: /strength|weight|gym/ },
  { id: "yoga", label: "Yoga & Pilates", match: /yoga|pilates|breath/ },
  { id: "cardio", label: "Cardio & HIIT", match: /hiit|cardio|elliptical|stair|fitness_equipment|indoor_rowing|rowing|boxing|jump/ },
  { id: "team", label: "Team & racket", match: /soccer|football|basket|volley|tennis|padel|squash|badminton|pickleball|handball|rugby|hockey/ },
  { id: "winter", label: "Winter sports", match: /ski|snowboard|snowshoe|skat/ },
  { id: "other", label: "Other", match: /.*/ },
] as const;

export type SportId = (typeof SPORTS)[number]["id"];
export const SPORT_IDS = SPORTS.map((s) => s.id) as [SportId, ...SportId[]];
export const SPORT_LABEL = Object.fromEntries(SPORTS.map((s) => [s.id, s.label])) as Record<SportId, string>;

/** The sport an activity type belongs to; anything unknown is "other". */
export function sportOf(activityType: string | null): SportId {
  const t = (activityType ?? "").toLowerCase();
  return (SPORTS.find((s) => s.id !== "other" && s.match.test(t))?.id ?? "other") as SportId;
}

/** "TREADMILL_RUNNING" -> "Treadmill running". */
export function activityLabel(activityType: string | null): string {
  const t = (activityType ?? "").trim().toLowerCase().replace(/[_-]+/g, " ");
  return t ? t[0].toUpperCase() + t.slice(1) : "Workout";
}
