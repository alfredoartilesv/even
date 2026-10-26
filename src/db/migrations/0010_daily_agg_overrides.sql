-- 0010: daily aggregation for Garmin metrics the name rule gets wrong, for every source.
-- Same conventions as 0001 to 0009. Never put a semicolon inside a comment here.

-- classifyMetric now knows these metrics (DAILY_AGG_OVERRIDES in src/features/metrics/catalog.ts).
-- Until now only the export import set them, so catalog rows of the Personal API ('garmin') and
-- freddy kept the name-based guess: on a day with two workouts, training effect and VO2 max were
-- summed. A row is changed only while it still holds that old guess, so a choice the owner made
-- is kept.
UPDATE metric_catalog SET daily_agg = 'max' WHERE metric = 'activity_aerobicTrainingEffect' AND daily_agg = 'sum';
UPDATE metric_catalog SET daily_agg = 'max' WHERE metric = 'activity_anaerobicTrainingEffect' AND daily_agg = 'sum';
UPDATE metric_catalog SET daily_agg = 'max' WHERE metric = 'activity_vo2Max' AND daily_agg = 'sum';
UPDATE metric_catalog SET daily_agg = 'max' WHERE metric = 'activity_maxHeartRateInBeatsPerMinute' AND daily_agg = 'avg';
UPDATE metric_catalog SET daily_agg = 'min' WHERE metric = 'daily_minHeartRateInBeatsPerMinute' AND daily_agg = 'avg';
UPDATE metric_catalog SET daily_agg = 'max' WHERE metric = 'daily_maxHeartRateInBeatsPerMinute' AND daily_agg = 'avg';
UPDATE metric_catalog SET daily_agg = 'max' WHERE metric = 'daily_maxStressLevel' AND daily_agg = 'avg';
UPDATE metric_catalog SET daily_agg = 'min' WHERE metric = 'pulseOx_minSpo2InPercent' AND daily_agg = 'avg';

-- The freddy sync is gone: its transport setting (native or WebView fetch) is no longer read.
DELETE FROM app_settings WHERE key = 'freddy.transport';
