# RAYIS Dock — Windows

Press one key, anywhere, and search everything your RAYIS HQ login opens.

Staff install it from **https://rayisweddings.com/dock-setup**. It is not a
second set of permissions: you sign in with your own RAYIS HQ email and
password, and the website answers with the apps your grants already open. If
Ray grants you an app it appears here within about fifteen minutes; if he takes
one away it disappears the same way.

The Mac version is a separate native app — this one is Electron, matching the
RAYIS Chat desktop build so the studio has one Windows pipeline.

## Build

```
npm install
npm run dist:win        # -> dist/RAYIS-Dock-Setup.exe
```

## Updates

Every dock checks for a newer one each time it refreshes its app list (every
fifteen minutes, on wake, and when the palette opens), signed in or not. The
website says which Windows version is published in `dockVersionWin`, on both
the catalog and the sign-in answer. (`dockVersion` there is the Mac app's
number; this app ignores it.) When `dockVersionWin` is ahead of the running
copy, the tray menu and a row at the foot of the palette say "Update
available". One click downloads the installer, checks it, runs it silently
over the top and reopens the dock.

To publish a version:

1. Bump `version` in `package.json`, then `npm run dist:win`.
2. Attach `dist/RAYIS-Dock-Setup.exe` to a new GitHub release on
   `rayisweddings/rayis-dock-app`, under exactly that file name. The dock
   downloads `releases/latest/download/RAYIS-Dock-Setup.exe`.
3. Set `dockVersionWin` on the website to the new number. Do this last — the
   moment it changes, every dock offers the update.

Run from source (`npm start`), two environment variables point the app at a
local stand-in for testing: `RAYIS_DOCK_SITE` (the site's origin) and
`RAYIS_DOCK_UPDATE_URL` (the installer). An installed copy ignores both. On a
Mac the update downloads and checks the file but never runs it.

Everything it knows comes from three endpoints on the site; nothing about
who-may-see-what is decided in this repo:

| endpoint | answers |
| --- | --- |
| `POST /hq/api/dock-session` | sign in → a RAYIS HQ session token |
| `GET /downloads/dock-catalog.json?me=1` | this person's apps, each with the level they hold |
| `GET /hq/api/dock-search?q=` | couples / leads / galleries / crew, already scoped to their grants |
