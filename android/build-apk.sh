#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
output="${1:-$root/dist/inkshift-android.apk}"
platform="${ANDROID_PLATFORM_JAR:-${ANDROID_HOME:-}/platforms/android-34/android.jar}"
resources="${ANDROID_RESOURCE_JAR:-$platform}"
tools="${ANDROID_BUILD_TOOLS:-${ANDROID_HOME:-}/build-tools/34.0.0}"
: "${INKSHIFT_KEYSTORE:?Path to the Android signing keystore}"
: "${INKSHIFT_STORE_PASS_FILE:?Path to a file containing the signing password}"
key_alias="${INKSHIFT_KEY_ALIAS:-inkshift}"

temp="$(mktemp -d)"
trap 'rm -rf "$temp"' EXIT
mkdir -p "$temp/res/drawable-nodpi" "$temp/assets/web" "$temp/classes" "$temp/dex"
cp "$root/dist/mark-192.png" "$temp/res/drawable-nodpi/inkshift_mark.png"
for asset in "$root"/dist/*.{html,css,js,json,png,svg,webmanifest}; do
    if [[ -f "$asset" ]]; then cp "$asset" "$temp/assets/web/"; fi
done

"${ANDROID_AAPT2:-$tools/aapt2}" compile --dir "$temp/res" -o "$temp/resources.zip"
"${ANDROID_AAPT2:-$tools/aapt2}" link -o "$temp/resources.apk" \
    --manifest "$root/android/AndroidManifest.xml" -I "$resources" -A "$temp/assets" "$temp/resources.zip"

if command -v javac >/dev/null; then
    compiler=(javac)
else
    compiler=(java -m jdk.compiler/com.sun.tools.javac.Main)
fi
"${compiler[@]}" -source 8 -target 8 -Xlint:-options -classpath "$platform" -d "$temp/classes" \
    "$root/android/src/studio/icesmoker/inkshift/MainActivity.java"
(cd "$temp/classes" && zip -q -r "$temp/classes.jar" .)
if [[ -n "${ANDROID_R8_JAR:-}" ]]; then
    d8=(java -cp "$ANDROID_R8_JAR" com.android.tools.r8.D8)
else
    d8=("${ANDROID_D8:-$tools/d8}")
fi
"${d8[@]}" --release --min-api 23 --lib "$platform" --output "$temp/dex" "$temp/classes.jar"
(cd "$temp/dex" && zip -q "$temp/resources.apk" classes.dex)
"${ANDROID_ZIPALIGN:-$tools/zipalign}" -f 4 "$temp/resources.apk" "$temp/aligned.apk"

if [[ -n "${ANDROID_APKSIGNER_CLASSPATH:-}" ]]; then
    signer=(java -cp "$ANDROID_APKSIGNER_CLASSPATH" com.android.apksigner.ApkSignerTool)
else
    signer=("${ANDROID_APKSIGNER:-$tools/apksigner}")
fi
"${signer[@]}" sign --ks "$INKSHIFT_KEYSTORE" --ks-key-alias "$key_alias" \
    --ks-pass "file:$INKSHIFT_STORE_PASS_FILE" --v4-signing-enabled false --out "$temp/signed.apk" "$temp/aligned.apk"
"${signer[@]}" verify --verbose "$temp/signed.apk"
mkdir -p "$(dirname "$output")"
cp "$temp/signed.apk" "$output"
