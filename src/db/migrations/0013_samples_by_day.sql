-- 0013: an index to find one day's samples.
-- Same conventions as 0001 to 0012. Never put a semicolon inside a comment here.

-- The Dashboard's day view asks daily_metric_values for every metric of one day. The existing
-- indexes start with the metric, so that read every sample ever stored, slower with each import
-- (about 15x on 46,000 samples). This one starts with the day, and its metric column also serves
-- the view's per-day lookups.
CREATE INDEX idx_health_samples_day_metric ON health_samples (local_day, metric);
