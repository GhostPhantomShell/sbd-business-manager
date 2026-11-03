# SBD Business Manager — desktop app

Windows and Mac app for Strength By Design. Data syncs through Supabase.

- `app/index.html` — the app itself. Updating this file (and bumping `app/version.json`) updates every installed copy on its next launch.
- `main.js` — the desktop window shell.
- New installers are built by GitHub Actions when a tag like `v1.0.1` is pushed (or from Actions → Build desktop apps → Run workflow). Download them from Releases.
