-- 0014: an index to count one source's samples.
-- Same conventions as 0001 to 0013. Never put a semicolon inside a comment here.

-- Settings > Connections shows how much of the Garmin export is stored: a count and the first
-- and last day of one source. Without this index that read every row in full, raw JSON included,
-- and the "imported" badge took seconds on the phone. With it the index alone answers.
CREATE INDEX idx_health_samples_source_day ON health_samples (source, local_day);
