-- 0012: Apple Health (source 'apple_health') joins the per-day source priority.
-- Same conventions as 0001 to 0011. Never put a semicolon inside a comment here.

-- Apple Health uses the Garmin metric names, and Garmin Connect can write the watch's data into
-- Apple Health, so the same steps can arrive twice: once from Garmin, once through Apple Health.
-- As in 0009, for each metric and day only the best source is shown. The order is now
-- garmin, freddy, apple_health, then garmin_export. A source outside this list is never hidden
-- and hides only garmin_export rows, as before. Nothing is deleted from health_samples.
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
  AND NOT (h.source IN ('freddy', 'apple_health', 'garmin_export') AND EXISTS (
    SELECT 1 FROM health_samples o
    WHERE o.metric = h.metric AND o.local_day = h.local_day AND o.value_num IS NOT NULL
      AND (CASE o.source WHEN 'garmin' THEN 1 WHEN 'freddy' THEN 2 WHEN 'apple_health' THEN 3 WHEN 'garmin_export' THEN 5 ELSE 4 END)
        < (CASE h.source WHEN 'freddy' THEN 2 WHEN 'apple_health' THEN 3 ELSE 5 END)))
GROUP BY metric, local_day, source, device;
