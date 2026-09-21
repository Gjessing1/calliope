#!/usr/bin/env bash
# Build a release-signed, server-specific APK. Native versioning lives in
# version.properties; ordinary web changes ship through the runtime-scoped OTA
# channel and do not require rebuilding this binary.
set -euo pipefail

cd "$(dirname "$0")"

if [[ -z "${ANDROID_HOME:-}" && -f "$HOME/android-sdk/env.sh" ]]; then
  # shellcheck source=/dev/null
  . "$HOME/android-sdk/env.sh"
fi
: "${ANDROID_HOME:?ANDROID_HOME not set and no \$HOME/android-sdk/env.sh found}"
: "${CALLIOPE_API_ORIGIN:?set CALLIOPE_API_ORIGIN to this APK server}"

# shellcheck source=/dev/null
. ./version.properties
: "${VERSION_CODE:?VERSION_CODE missing from version.properties}"
: "${VERSION_NAME:?VERSION_NAME missing from version.properties}"

KEYSTORE_ENV="${CALLIOPE_KEYSTORE_ENV:-$HOME/.config/calliope/keystore.env}"
if [[ ! -f "$KEYSTORE_ENV" ]]; then
  echo "No release-signing config at $KEYSTORE_ENV; refusing to publish an update-incompatible APK." >&2
  exit 1
fi
# shellcheck source=/dev/null
. "$KEYSTORE_ENV"
: "${CALLIOPE_KEYSTORE:?CALLIOPE_KEYSTORE missing}"
: "${CALLIOPE_KEYSTORE_PASSWORD:?CALLIOPE_KEYSTORE_PASSWORD missing}"
: "${CALLIOPE_KEY_ALIAS:?CALLIOPE_KEY_ALIAS missing}"
: "${CALLIOPE_KEY_PASSWORD:?CALLIOPE_KEY_PASSWORD missing}"

BUNDLE_ID="${CALLIOPE_BUNDLE_ID:-$(git rev-parse HEAD)}"
echo "==> building web bundle $BUNDLE_ID against $CALLIOPE_API_ORIGIN"
VITE_API_ORIGIN="${CALLIOPE_API_ORIGIN%/}" VITE_APP_BUNDLE_ID="$BUNDLE_ID" \
  npm run build -w @calliope/web --prefix ../..

if [[ ! -d android ]]; then
  echo "==> generating native Android project"
  npx cap add android
fi
echo "==> syncing Capacitor plugins and web assets"
npx cap sync android
# The native project is generated and gitignored, so the launcher icon is
# rewritten into it on every build rather than kept there.
echo "==> writing the launcher icon"
node ../../scripts/app-icon.mjs --android android/app/src/main/res

GRADLE_FILE=android/app/build.gradle
sed -i -E "s/versionCode [0-9]+/versionCode $VERSION_CODE/" "$GRADLE_FILE"
sed -i -E "s/versionName \"[^\"]+\"/versionName \"$VERSION_NAME\"/" "$GRADLE_FILE"

export GRADLE_USER_HOME="$PWD/.gradle-home"
echo "==> assembling signed Calliope $VERSION_NAME ($VERSION_CODE)"
(cd android && ./gradlew --no-daemon assembleRelease \
  -Pandroid.injected.signing.store.file="$CALLIOPE_KEYSTORE" \
  -Pandroid.injected.signing.store.password="$CALLIOPE_KEYSTORE_PASSWORD" \
  -Pandroid.injected.signing.key.alias="$CALLIOPE_KEY_ALIAS" \
  -Pandroid.injected.signing.key.password="$CALLIOPE_KEY_PASSWORD")

APK="$PWD/android/app/build/outputs/apk/release/app-release.apk"
APKSIGNER="$(find "$ANDROID_HOME/build-tools" -mindepth 2 -maxdepth 2 -type f -name apksigner | sort -V | tail -1)"
"$APKSIGNER" verify --print-certs "$APK" | grep -E 'Signer #1 certificate (DN|SHA-256)' || true
echo "APK: $APK"
