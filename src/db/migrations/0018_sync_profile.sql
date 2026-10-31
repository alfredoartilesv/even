-- Cloud sync carries the owner's profile (name, body figures, sports) and picture, so the web
-- app greets them by name and its estimates match the phone. Only these two app_settings keys:
-- the rest are about this install (device id, backup dates, Garmin cursors, log level).
-- One line per trigger, as in 0016.
CREATE TRIGGER cloud_sync_app_settings_ins AFTER INSERT ON app_settings WHEN NEW.key IN ('profile', 'profile.photo') AND NOT EXISTS (SELECT 1 FROM cloud_sync_pulling) BEGIN UPDATE cloud_sync_outbox SET stamp = (SELECT MAX(stamp) + 1 FROM cloud_sync_outbox) WHERE tbl = 'app_settings' AND row_id = NEW.rowid; INSERT INTO cloud_sync_outbox (tbl, row_id, stamp) SELECT 'app_settings', NEW.rowid, (SELECT COALESCE(MAX(stamp), 0) + 1 FROM cloud_sync_outbox) WHERE NOT EXISTS (SELECT 1 FROM cloud_sync_outbox WHERE tbl = 'app_settings' AND row_id = NEW.rowid); END;
CREATE TRIGGER cloud_sync_app_settings_upd AFTER UPDATE ON app_settings WHEN NEW.key IN ('profile', 'profile.photo') AND NOT EXISTS (SELECT 1 FROM cloud_sync_pulling) BEGIN UPDATE cloud_sync_outbox SET stamp = (SELECT MAX(stamp) + 1 FROM cloud_sync_outbox) WHERE tbl = 'app_settings' AND row_id = NEW.rowid; INSERT INTO cloud_sync_outbox (tbl, row_id, stamp) SELECT 'app_settings', NEW.rowid, (SELECT COALESCE(MAX(stamp), 0) + 1 FROM cloud_sync_outbox) WHERE NOT EXISTS (SELECT 1 FROM cloud_sync_outbox WHERE tbl = 'app_settings' AND row_id = NEW.rowid); END;

-- A profile saved before this version goes on the next sync.
INSERT INTO cloud_sync_outbox (tbl, row_id, stamp) SELECT 'app_settings', rowid, 0 FROM app_settings WHERE key IN ('profile', 'profile.photo');
