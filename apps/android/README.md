# Android shell

The Android app is the web app in a Capacitor WebView. There is no second UI
codebase and there must never be one: a fix made in `apps/web` is the fix on
both platforms.

## First-time setup

The native project (`apps/android/android/`) is generated, not committed — it is
in `.gitignore` because regenerating it is deterministic and keeping it under
version control means merge conflicts in files nobody edits.

```bash
npm install                       # from the repo root
npm run build -w @calliope/web
npx cap add android               # run once, from apps/android
```

Android Studio and a JDK are required from here on; `npx cap open android`
launches it.

## Building

```bash
# development: point it at a dev server on the LAN
CALLIOPE_API_ORIGIN=http://192.168.1.10:3008 npm run sync -w @calliope/android
npx cap open android            # then Run from the IDE

# release: builds the current web UI into a signed APK
CALLIOPE_API_ORIGIN=https://calliope.example.org ./build-apk.sh
./publish-apk.sh
```

## Updates

Each APK is tied to one Calliope server. On first launch it asks for a device
token from that server; the token is stored only on the phone and sent as a
Bearer token on API requests. There is intentionally no server picker or
fallback origin that could silently open the wrong library.

Most releases are web-only. The main-branch workflow publishes the same web
build as a checksum-verified OTA bundle under the APK's `VERSION_CODE`; the app
downloads it in the background, offers a restart, and rolls back to its built-in
bundle if the update cannot start. A Capacitor/plugin/config change is native:
bump both values in `version.properties`, build and publish a new signed APK,
then devices receive that through the stable `/api/app/download` URL.

The release keystore and its passwords live in
`~/.config/calliope/keystore.env`, never in the repository. `publish-apk.sh`
refuses debuggable, unsigned, or version-mismatched artifacts.

## Why the API origin is a build-time variable

The WebView serves the bundle from `https://localhost`, so there is no
same-origin backend the way there is on the web. Every request is absolute and
cross-origin, which is why the backend registers CORS. Baking the origin in at
build time keeps the app's first paint free of a configuration screen — at the
cost of one APK per server, which for a self-hosted single-server app is the
right trade.

If one APK ever needs to serve several installations, replace this with a
first-run origin screen. Do not add a default origin: a wrong default silently
talks to the wrong library.
