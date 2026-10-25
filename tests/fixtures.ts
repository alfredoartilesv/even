// Synthetic fixtures that follow the exact text formats freddy's MCP tools returned
// when this integration was written (25 Oct 2026). Numbers are invented.

export const LIST_METRICS = `Available metrics: 6 from Garmin.

Source: Garmin (6 metrics)
activity_distanceInMeters: 9 records (2026-09-27 to 2026-10-17, unit: meters, source: Garmin, device: "Forerunner 245")
activityDetail_samples: 9 records (2026-09-27 to 2026-10-17, source: Garmin, device: "Forerunner 245") [raw-only — fetch with include_raw]
body_weightInGrams: 2 records (2026-10-24 to 2026-10-24, unit: grams, source: Garmin) [raw available: 2]
daily_steps: 32 records (2026-09-24 to 2026-10-25, source: Garmin) [raw available: 32]
epoch_steps: 3045 records (2026-09-23 to 2026-10-25, source: Garmin)
sleep_durationInSeconds: 33 records (2026-09-23 to 2026-10-25, unit: seconds, source: Garmin) [raw available: 33]

Showing data from GARMIN only. This account plan queries one connected provider at a time.

History window for queries: last 7 days. The counts above reflect total stored data; this account plan can query the last 7 days of synced data.`;

export const QUERY_METRICS = `Health data (last 7 days):
Dates are local days in Europe/Madrid (timezone reported by the freddy app). Times show their UTC offset.

2026-10-25:
  (possibly incomplete: the day is not over. Last read: Garmin at 2026-10-25T18:03+01:00.)
  daily_steps: 15000 (Garmin)
  daily_averageHeartRateInBeatsPerMinute: 90 bpm (Garmin)
2026-10-24:
  body_weightInGrams: 87000 grams (Garmin)
  body_weightInGrams: 86500 grams (Garmin)
  daily_steps: 10000 (Garmin)
  sleep_durationInSeconds: 30000 seconds (Garmin)
  daily_stressQualifier: very stressful (Garmin)
  weird_metric: 5 bpm at 07:30+01:00 (Garmin)
  this line has no colon structure

Note: This account plan can query the last 7 days of data (since 2026-10-19). The requested range starts earlier, so results are limited to the available window.`;
