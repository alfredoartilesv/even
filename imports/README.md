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

The Garmin importer is not built yet: once the ZIP is here, it will read it on the PC and
produce an encrypted backup file that you restore in the app (Settings → Restore).
