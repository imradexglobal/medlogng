#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
asset_dir="$repo_root/vendor/speech"
source_dir="$asset_dir/ffmpeg-source"
cache_dir="$repo_root/.cache/ffmpeg-source"
source_url='https://ffmpeg.org/releases/ffmpeg-9.0.2.tar.xz'
signature_url="$source_url.asc"
key_url='https://ffmpeg.org/ffmpeg-devel.asc'
fingerprint='FCF986EA15E6E293A5644F10B4322F04D67658D8'
archive="$source_dir/ffmpeg-9.0.2.tar.xz"
signature="$source_dir/ffmpeg-9.0.2.tar.xz.asc"
key="$source_dir/ffmpeg-devel.asc"
source_sha_file="$source_dir/ffmpeg-9.0.2.tar.xz.sha256"
build_dir="$cache_dir/ffmpeg-9.0.2"
staged_ffmpeg="$asset_dir/ffmpeg.exe"
receipt="$asset_dir/ffmpeg-build.json"

fail() { printf 'FFmpeg source build failed: %s\n' "$*" >&2; exit 1; }

[[ "${MSYSTEM:-}" == UCRT64 ]] || fail 'Run this script in the MSYS2 UCRT64 environment.'
missing_tools=()
for tool in curl gpg tar make gcc nasm pacman sha256sum; do
  command -v "$tool" >/dev/null 2>&1 || missing_tools+=("$tool")
done
if ((${#missing_tools[@]})); then
  fail "Missing UCRT64 tools: ${missing_tools[*]}. In the UCRT64 shell run: pacman -S --needed base-devel mingw-w64-ucrt-x86_64-toolchain mingw-w64-ucrt-x86_64-nasm gnupg"
fi
mkdir -p "$source_dir" "$cache_dir" "$asset_dir"

download_if_missing() {
  local url="$1" output="$2"
  local temporary="$output.download"
  if [[ ! -s "$output" ]]; then
    rm -f "$temporary"
    curl --fail --location --retry 3 --retry-all-errors --output "$temporary" "$url" || fail "Could not download official source input: $url"
    [[ -s "$temporary" ]] || fail "Downloaded file is empty: $url"
    mv -f "$temporary" "$output"
  fi
}

download_if_missing "$source_url" "$archive"
download_if_missing "$signature_url" "$signature"
download_if_missing "$key_url" "$key"

gpg_home="$(mktemp -d "$cache_dir/gpg.XXXXXX")"
chmod 700 "$gpg_home"
trap 'rm -rf "$gpg_home"' EXIT
gpg --homedir "$gpg_home" --batch --import "$key" >/dev/null 2>&1 || fail 'Could not import the official FFmpeg release key.'
actual_fingerprint="$(gpg --homedir "$gpg_home" --batch --with-colons --fingerprint | awk -F: '$1 == "fpr" { print $10; exit }')"
[[ "$actual_fingerprint" == "$fingerprint" ]] || fail "FFmpeg release key fingerprint mismatch (found ${actual_fingerprint:-none})."
gpg --homedir "$gpg_home" --batch --verify "$signature" "$archive" || fail 'Official FFmpeg source signature verification failed; source will not be extracted or built.'

source_sha="$(sha256sum "$archive" | awk '{print tolower($1)}')"
if [[ -d "$build_dir" && -f "$build_dir/.medlog-source-sha256" && "$(cat "$build_dir/.medlog-source-sha256")" == "$source_sha" ]]; then
  echo 'Refreshing source files from the verified FFmpeg archive while retaining incremental build outputs.'
  tar -xf "$archive" --strip-components=1 -C "$build_dir"
else
  case "$build_dir" in "$cache_dir/ffmpeg-9.0.2") rm -rf -- "$build_dir" ;; *) fail 'Refusing to remove an unexpected source path.' ;; esac
  mkdir -p "$build_dir"
  tar -xf "$archive" --strip-components=1 -C "$build_dir"
  printf '%s\n' "$source_sha" > "$build_dir/.medlog-source-sha256"
fi

configure_args=(
  --arch=x86_64
  --target-os=mingw32
  --disable-autodetect
  --disable-shared
  --enable-static
  --disable-ffplay
  --disable-ffprobe
  --disable-doc
  --disable-debug
  --extra-ldflags=-static
)
cd "$build_dir"
./configure "${configure_args[@]}" || fail 'FFmpeg configure failed; no unsupported option or dependency will be enabled automatically.'
make -j2 || fail 'FFmpeg compilation failed.'
[[ -s ffmpeg.exe ]] || fail 'FFmpeg build completed without producing ffmpeg.exe.'
./ffmpeg.exe -version | head -n 1 | grep -Eq '^ffmpeg version 9\.0\.2([[:space:]]|$)' || fail 'Built executable did not report FFmpeg 9.0.2.'
./ffmpeg.exe -L 2>&1 | grep -Eqi 'GNU Lesser General Public License|LGPL' || fail 'Built executable did not report an LGPL license.'
./ffmpeg.exe -version 2>&1 | grep -Eq -- '--enable-(gpl|nonfree)([[:space:]]|$)' && fail 'Built executable unexpectedly enables GPL/nonfree components.'

cp -f ffmpeg.exe "$staged_ffmpeg"
[[ -s COPYING.LGPLv2.1 ]] || fail 'The verified FFmpeg source archive is missing COPYING.LGPLv2.1.'
cp -f COPYING.LGPLv2.1 "$asset_dir/COPYING.LGPLv2.1"
cp -f "$archive" "$asset_dir/ffmpeg-9.0.2.tar.xz"
cp -f "$signature" "$asset_dir/ffmpeg-9.0.2.tar.xz.asc"
cp -f "$key" "$asset_dir/ffmpeg-devel.asc"
mapfile -t package_lines < <(pacman -Q)
toolchain_json='['
for line in "${package_lines[@]}"; do
  escaped="${line//\\/\\\\}"
  escaped="${escaped//\"/\\\"}"
  [[ "$toolchain_json" == '[' ]] || toolchain_json+=','
  toolchain_json+="\"$escaped\""
done
toolchain_json+=']'
configure_json='["--arch=x86_64","--target-os=mingw32","--disable-autodetect","--disable-shared","--enable-static","--disable-ffplay","--disable-ffprobe","--disable-doc","--disable-debug","--extra-ldflags=-static"]'
printf '{\n  "schemaVersion": 1,\n  "sourceVersion": "9.0.2",\n  "sourceSha256": "%s",\n  "toolchain": %s,\n  "configureArgs": %s\n}\n' \
  "$source_sha" "$toolchain_json" "$configure_json" > "$receipt"
printf 'Staged FFmpeg 9.0.2. Source SHA-256: %s\n' "$source_sha"
printf 'Receipt written: %s\n' "$receipt"
