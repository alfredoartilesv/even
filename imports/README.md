# imports/

Drop data exports here for the importers to read, for example your Garmin account export:

```
imports/
  garmin/
    <the ZIP Garmin emailed you>.zip     (keep it zipped; do not rename)
```

**Everything in this folder except this README is git-ignored.** These files hold your full
health history, so they never leave your PC through git. Do not move them elsewhere in the repo,
and do not commit them under another name.

How to get the Garmin export: Garmin Connect on the web → Account → Data Management →
Export Your Data → Request Data Export. Garmin emails a download link (usually within 48 hours,
up to 30 days; the link expires, so download it soon).

Then run `npm run import:garmin`. It reads the ZIP on the PC and writes an encrypted backup file
next to it (`imports/garmin/garmin-import-<date>.json`, also git-ignored). Copy that file to the
phone and restore it in the app (Settings → Restore) with the password you chose. Restoring merges:
nothing already on the phone is lost or duplicated. `npm run import:garmin -- --dry-run` only reports
what it would import.
