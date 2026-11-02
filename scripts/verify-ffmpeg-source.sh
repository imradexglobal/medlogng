#!/usr/bin/env bash
set -euo pipefail

fingerprint='FCF986EA15E6E293A5644F10B4322F04D67658D8'
if [[ $# -ne 3 ]]; then
  echo 'Usage: verify-ffmpeg-source.sh <source-archive> <signature> <signing-key>' >&2
  exit 2
fi
archive="$1"
signature="$2"
key="$3"
for file in "$archive" "$signature" "$key"; do
  [[ -s "$file" ]] || { printf 'Missing or empty FFmpeg source proof: %s\n' "$file" >&2; exit 1; }
done
command -v gpg >/dev/null 2>&1 || { echo 'GnuPG is required in MSYS2 UCRT64.' >&2; exit 1; }
command -v sha256sum >/dev/null 2>&1 || { echo 'sha256sum is required in MSYS2 UCRT64.' >&2; exit 1; }

gpg_home="$(mktemp -d "${TMPDIR:-/tmp}/medlog-ffmpeg-gpg.XXXXXX")"
chmod 700 "$gpg_home"
trap 'rm -rf "$gpg_home"' EXIT
gpg --homedir "$gpg_home" --batch --import "$key" >/dev/null 2>&1 || { echo 'Could not import the official FFmpeg release key.' >&2; exit 1; }
actual_fingerprint="$(gpg --homedir "$gpg_home" --batch --with-colons --fingerprint | awk -F: '$1 == "fpr" { print $10; exit }')"
[[ "$actual_fingerprint" == "$fingerprint" ]] || { printf 'FFmpeg release signing key fingerprint mismatch (found %s).\n' "${actual_fingerprint:-none}" >&2; exit 1; }
gpg --homedir "$gpg_home" --batch --verify "$signature" "$archive" || { echo 'Official FFmpeg source signature verification failed.' >&2; exit 1; }
source_sha="$(sha256sum "$archive" | awk '{print tolower($1)}')"
printf 'FFMPEG_SOURCE_SHA256=%s\n' "$source_sha"
