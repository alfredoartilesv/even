-- 0009: the Garmin Personal API (source 'garmin') replaces freddy as the live source.
-- Same conventions as 0001 to 0008. Never put a semicolon inside a comment here.

-- The export's activity calories are kilojoules, not kcal (exactly 4.184 times the API's kcal for
-- the same activities). Rows an earlier import stored are converted here, once. A re-import with
-- the fixed importer writes kcal over them anyway.
UPDATE health_samples SET value_num = ROUND(value_num / 4.184)
  WHERE source = 'garmin_export' AND metric = 'activity_activeKilocalories' AND value_num IS NOT NULL;

-- The same watch reading can now be stored up to three times, once per source: 'garmin' (the
-- Personal API), 'freddy' (the earlier sync, rows kept from before the switch) and
-- 'garmin_export' (the account export import). They use the same metric names, so for each metric
-- and day only the best source is shown: garmin, then freddy, then garmin_export. As in 0008 all
-- rows stay in health_samples, nothing is deleted, and a backup still holds every copy.
-- Other sources (none yet) are never hidden, and hide only garmin_export rows, as in 0008.
DROP VIEW daily_metric_values;
CREATE VIEW daily_metric_values AS
SELECT
  metric,
  local_day,
  source,
  device,
  COUNT(*)        AS readings,
  AVG(value_num)  AS avg_num,
  SUM(value_num)  AS sum_num,
  MIN(value_num)  AS min_num,
  MAX(value_num)  AS max_num,
  (SELECT l.value_num FROM health_samples l
    WHERE l.metric = h.metric AND l.local_day = h.local_day AND l.source = h.source
      AND l.device = h.device AND l.value_num IS NOT NULL
    ORDER BY l.start_ms DESC, l.rowid DESC LIMIT 1) AS last_num,
  MAX(unit)       AS unit,
  MAX(CASE WHEN raw_json LIKE '%"partial":true%' THEN 1 ELSE 0 END) AS partial
FROM health_samples h
WHERE value_num IS NOT NULL AND local_day IS NOT NULL
  AND NOT (h.source = 'garmin_export' AND EXISTS (
    SELECT 1 FROM health_samples o
    WHERE o.metric = h.metric AND o.local_day = h.local_day AND o.source <> 'garmin_export' AND o.value_num IS NOT NULL))
  AND NOT (h.source = 'freddy' AND EXISTS (
    SELECT 1 FROM health_samples o
    WHERE o.metric = h.metric AND o.local_day = h.local_day AND o.source = 'garmin' AND o.value_num IS NOT NULL))
GROUP BY metric, local_day, source, device;
