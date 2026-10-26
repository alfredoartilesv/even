-- 0008: the Garmin export import and freddy hold the same Garmin values for the days both cover.
-- Same conventions as 0001 to 0007. Never put a semicolon inside a comment here.

-- The importer now uses freddy's metric names. Rename rows an earlier import already stored,
-- so the history and freddy's recent days are one series per metric.
UPDATE health_samples SET metric = 'daily_activeTimeInSeconds' WHERE source = 'garmin_export' AND metric = 'daily_activeDurationInSeconds';
UPDATE health_samples SET metric = 'pulseOx_avgSpo2InPercent' WHERE source = 'garmin_export' AND metric = 'pulseOx_averageSpO2';
UPDATE health_samples SET metric = 'pulseOx_minSpo2InPercent' WHERE source = 'garmin_export' AND metric = 'pulseOx_lowestSpO2';
UPDATE health_samples SET metric = 'sleep_deepSleepDurationInSeconds' WHERE source = 'garmin_export' AND metric = 'sleep_deepDurationInSeconds';
UPDATE health_samples SET metric = 'sleep_lightSleepDurationInSeconds' WHERE source = 'garmin_export' AND metric = 'sleep_lightDurationInSeconds';
UPDATE health_samples SET metric = 'sleep_remSleepInSeconds' WHERE source = 'garmin_export' AND metric = 'sleep_remDurationInSeconds';
UPDATE health_samples SET metric = 'activity_totalElevationGainInMeters' WHERE source = 'garmin_export' AND metric = 'activity_elevationGainInMeters';
UPDATE health_samples SET metric = 'activity_activityType' WHERE source = 'garmin_export' AND metric = 'activity_type';
UPDATE metric_catalog SET metric = 'daily_activeTimeInSeconds' WHERE source = 'garmin_export' AND metric = 'daily_activeDurationInSeconds';
UPDATE metric_catalog SET metric = 'pulseOx_avgSpo2InPercent' WHERE source = 'garmin_export' AND metric = 'pulseOx_averageSpO2';
UPDATE metric_catalog SET metric = 'pulseOx_minSpo2InPercent' WHERE source = 'garmin_export' AND metric = 'pulseOx_lowestSpO2';
UPDATE metric_catalog SET metric = 'sleep_deepSleepDurationInSeconds' WHERE source = 'garmin_export' AND metric = 'sleep_deepDurationInSeconds';
UPDATE metric_catalog SET metric = 'sleep_lightSleepDurationInSeconds' WHERE source = 'garmin_export' AND metric = 'sleep_lightDurationInSeconds';
UPDATE metric_catalog SET metric = 'sleep_remSleepInSeconds' WHERE source = 'garmin_export' AND metric = 'sleep_remDurationInSeconds';
UPDATE metric_catalog SET metric = 'activity_totalElevationGainInMeters' WHERE source = 'garmin_export' AND metric = 'activity_elevationGainInMeters';
UPDATE metric_catalog SET metric = 'activity_activityType' WHERE source = 'garmin_export' AND metric = 'activity_type';

-- As in 0002, except that a garmin_export day is left out when another source (freddy) has the
-- same metric on the same day: it is the same watch reading twice. freddy wins because it is the
-- live source and keeps updating. Both rows stay in health_samples, so nothing is lost and a
-- backup still holds both.
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
GROUP BY metric, local_day, source, device;
