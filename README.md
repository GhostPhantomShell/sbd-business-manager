# SBD Business Manager — desktop app

Windows and Mac app for Strength By Design. Data syncs through Supabase.

- `app/index.html` — the app itself. Updating this file (and bumping `app/version.json`) updates every installed copy on its next launch.
- `main.js` — the desktop window shell.
- New installers are built by GitHub Actions when a tag like `v1.0.1` is pushed (or from Actions → Build desktop apps → Run workflow). Download them from Releases.

## PAR-Q+ setup (one time)

The PAR-Q+ forms use their own locked table and a private file folder in Supabase.
Open Supabase → SQL Editor → New query, paste everything in `parq-setup.sql`, and click Run.
It creates the `parq_forms` table (owner-only access, signed forms can't be edited or deleted)
and the private `parq-private` storage bucket for signatures and PDFs. Existing data isn't touched.

## Contracts setup (one time)

Open Supabase → SQL Editor → New query, paste everything in `contracts-setup.sql`, and click Run.
It creates the `contracts` table (owner-only, signed contracts locked), the add-only `contract_events`
history, and the private `contracts-private` storage bucket for signatures and PDFs.
