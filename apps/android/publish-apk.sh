#!/usr/bin/env bash
# Atomically publish a signed APK for first install and in-app native updates.
set -euo pipefail

cd "$(dirname "$0")"
# shellcheck source=/dev/null
. ./version.properties
apk="${1:-android/app/build/outputs/apk/release/app-release.apk}"
app_dir="${CALLIOPE_ANDROID_APP_DIR:-/mnt/data/calliope/app}"

if [[ -z "${ANDROID_HOME:-}" && -f "$HOME/android-sdk/env.sh" ]]; then
  # shellcheck source=/dev/null
  . "$HOME/android-sdk/env.sh"
fi
: "${ANDROID_HOME:?ANDROID_HOME is required to verify the release}"
[[ -f "$apk" ]] || { echo "APK not found: $apk" >&2; exit 1; }

aapt="$(find "$ANDROID_HOME/build-tools" -mindepth 2 -maxdepth 2 -type f -name aapt | sort -V | tail -1)"
apksigner="$(find "$ANDROID_HOME/build-tools" -mindepth 2 -maxdepth 2 -type f -name apksigner | sort -V | tail -1)"
badging="$("$aapt" dump badging "$apk")"
[[ "$badging" == *"versionCode='$VERSION_CODE'"* ]] || { echo 'APK versionCode mismatch' >&2; exit 1; }
[[ "$badging" == *"versionName='$VERSION_NAME'"* ]] || { echo 'APK versionName mismatch' >&2; exit 1; }
[[ "$badging" != *'application-debuggable'* ]] || { echo 'Refusing a debuggable APK' >&2; exit 1; }
"$apksigner" verify "$apk"

file="calliope-$VERSION_NAME.apk"
mkdir -p "$app_dir"
install -m 0644 "$apk" "$app_dir/$file"
bytes="$(stat -c '%s' "$app_dir/$file")"
sha256="$(sha256sum "$app_dir/$file" | cut -d ' ' -f 1)"
metadata_tmp="$app_dir/.version.json.$$"
printf '{"versionCode":%s,"versionName":"%s","file":"%s","bytes":%s,"sha256":"%s"}\n' \
  "$VERSION_CODE" "$VERSION_NAME" "$file" "$bytes" "$sha256" > "$metadata_tmp"
chmod 0644 "$metadata_tmp"
mv "$metadata_tmp" "$app_dir/version.json"
echo "Published $file (versionCode $VERSION_CODE) to $app_dir"
