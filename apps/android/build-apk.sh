#!/usr/bin/env bash
# Build a release APK.
#
# Two things this script exists to prevent:
#   1. Shipping a debug-signed APK. Android will not upgrade an installed app
#      whose signature changed, so a debug build handed to a phone has to be
#      uninstalled (losing its data) before a real one can replace it.
#   2. Shipping a bundle pointed at localhost. The APK has no backend of its
#      own; CALLIOPE_API_ORIGIN is what it talks to and there is no default that
#      could possibly be right.
set -euo pipefail

cd "$(dirname "$0")"

: "${CALLIOPE_API_ORIGIN:?set CALLIOPE_API_ORIGIN to the Calliope server this APK should talk to}"

KEYSTORE_ENV="${CALLIOPE_KEYSTORE_ENV:-$HOME/.config/calliope/keystore.env}"
if [ ! -f "$KEYSTORE_ENV" ]; then
  echo "No keystore config at $KEYSTORE_ENV." >&2
  echo "It must define CALLIOPE_KEYSTORE, CALLIOPE_KEYSTORE_PASSWORD, CALLIOPE_KEY_ALIAS, CALLIOPE_KEY_PASSWORD." >&2
  exit 1
fi
# shellcheck source=/dev/null
. "$KEYSTORE_ENV"

echo "==> building web app against $CALLIOPE_API_ORIGIN"
VITE_API_ORIGIN="$CALLIOPE_API_ORIGIN" npm run build -w @calliope/web --prefix ../..

echo "==> syncing into the native project"
npx cap sync android

echo "==> assembling release APK"
cd android
./gradlew assembleRelease \
  -Pandroid.injected.signing.store.file="$CALLIOPE_KEYSTORE" \
  -Pandroid.injected.signing.store.password="$CALLIOPE_KEYSTORE_PASSWORD" \
  -Pandroid.injected.signing.key.alias="$CALLIOPE_KEY_ALIAS" \
  -Pandroid.injected.signing.key.password="$CALLIOPE_KEY_PASSWORD"

echo "==> $(pwd)/app/build/outputs/apk/release/app-release.apk"
