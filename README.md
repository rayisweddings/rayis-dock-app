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

Everything it knows comes from three endpoints on the site; nothing about
who-may-see-what is decided in this repo:

| endpoint | answers |
| --- | --- |
| `POST /hq/api/dock-session` | sign in → a RAYIS HQ session token |
| `GET /downloads/dock-catalog.json?me=1` | this person's apps, each with the level they hold |
| `GET /hq/api/dock-search?q=` | couples / leads / galleries / crew, already scoped to their grants |
