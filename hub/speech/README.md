# Host speech worker

This is a persistent, single-model CPU worker. The Electron Host will supervise
it and communicate over stdin/stdout; it does not listen on a network port.
The Host hands it only validated 16 kHz, mono, 16-bit PCM WAV files from its
private temporary audio folder. The worker applies a five-minute and 32 MB
defensive limit, loads English once, and serializes transcription work.

## Build inputs

- Windows x64, CMake 3.20 or newer, and a Visual Studio C++ toolchain on the
  build machine only.
- The official `ggml-org/whisper.cpp` source at the pinned `v1.9.5` release
  commit (`d1be6fd`).
- Visual Studio 2022 x64 C++ tools, CMake 3.20+, and Git.
- Official FFmpeg source inputs are fetched and signature-verified by
  `scripts/build-ffmpeg.sh`, then built through `scripts/build-ffmpeg.ps1` in
  MSYS2 UCRT64. The scripts stage the executable and `ffmpeg-build.json`; do
  not use an unverified third-party binary.
- `scripts/build-whisper-worker.ps1` checks the Visual Studio 2022 C++ tools,
  CMake and Git; performs the pinned source checkout; downloads
  `tiny.en-q5_1` from the pinned Hugging Face revision `f281eb4`; verifies its
  SHA-256; builds the CPU worker; and writes `speech-assets.json` with asset
  hashes.
  GPU backends, shared runtime libraries, OpenMP, examples, tests, and the
  upstream HTTP server are disabled for this worker build.

The manifest records the Whisper source commit and MIT license, the model
revision and MIT license, and the FFmpeg source URL/version/signing key,
source and executable hashes, LGPL license/configuration, and build toolchain.
The Host installer carries the MIT and LGPL license texts, the exact verified
FFmpeg source archive, detached signature and release key alongside the
runtime assets so the source and license notice remain available offline.
The Host build refuses to proceed unless the FFmpeg source archive, detached
signature and public key are staged under `vendor/speech/ffmpeg-source`, the
signature validates against FFmpeg's pinned release key, and
`vendor/speech/ffmpeg-build.json` records the toolchain and configure options.
It also checks that the executable's reported version, license and configure
flags match that record, and rejects GPL/nonfree flags.

For a Windows x64 build machine, install Visual Studio 2022 Build Tools with
the Desktop C++ workload (MSVC v143 and a Windows SDK), CMake 3.20 or newer,
and Git. For FFmpeg, install MSYS2 and use its UCRT64 shell. Install
`base-devel`, `mingw-w64-ucrt-x86_64-toolchain`,
`mingw-w64-ucrt-x86_64-nasm`, and GnuPG.
Download `ffmpeg-9.0.2.tar.xz`, its `.asc` signature, and the key
`ffmpeg-devel.asc` from ffmpeg.org. Stage the three files in
`vendor/speech/ffmpeg-source`. The FFmpeg source build imports that key into an isolated
GnuPG keyring, verifies fingerprint
`FCF986EA15E6E293A5644F10B4322F04D67658D8`, and validates the signature and
source SHA-256.

Build the standalone converter from that source in the UCRT64 shell with
`./configure --arch=x86_64 --target-os=mingw32 --disable-autodetect
--disable-shared --enable-static --disable-ffplay --disable-ffprobe
--disable-doc --disable-debug --extra-ldflags=-static`, then run `make -j2`.
Do not add `--enable-gpl` or `--enable-nonfree`. Stage the resulting
`ffmpeg.exe` and create `vendor/speech/ffmpeg-build.json` with schema version
1, source version `9.0.2`, the complete configure argument array, and the exact
MSYS2 toolchain/package versions from `pacman -Q`. The Host builder verifies
that record against the executable and records source and binary SHA-256
values. Rebuild from identical inputs and compare hashes before calling the
packaging process reproducible.

The receipt fields are `schemaVersion`, `sourceVersion`, optional `sourceSha256`,
`toolchain`, and `configureArgs`. The builder independently computes the
source hash and verifies the staged signature; it checks the supplied hash when
present. Keep the full package-version output in `toolchain` so another build
can reconstruct the same environment.

Run `npm run speech:build` from the repository root to prepare FFmpeg and the
Whisper worker. It automatically fetches missing pinned inputs, verifies
FFmpeg's signature before extraction/build, resumes an existing matching
FFmpeg source/build tree, and gives a specific missing-tool error. Run
`scripts/verify-speech-assets.ps1` to validate all three runtime files,
their recorded sizes and SHA-256 hashes, the pinned model hash, and FFmpeg's
reported version. `build-host.bat` runs both preparation and verification
before building the installer, so a missing or corrupt asset fails packaging.

The build machine needs internet only to fetch the pinned source/model. The
Host and clients do not download source, models, or tools at runtime. Keep the
generated asset manifest with the release artifacts for reproducibility.

An on-demand Windows 2022 GitHub Actions workflow is available at
`.github/workflows/build-speech-assets.yml`. It uses read-only repository
permissions, pinned action commit SHAs, official source/model pins, verifies
and starts the real worker/model, and uploads the runtime assets and receipts.
It uses no signing keys or application secrets. It does not build the installer
or validate 4 GB Host performance. GitHub runner and MSYS2 package updates are
recorded in the receipts; do not describe the build as reproducible until
identical clean builds have been compared.

## Worker protocol

The process loads the model at startup and prints `READY` only after successful
initialization. Each request line is `<job-id>\t<absolute-wav-path>`. Each
response is `<job-id>\tOK|ERR\t<base64-utf8-text>`. `QUIT` requests a clean stop.
The supervisor starts at most one worker and sends one job at a time. It retries
startup and unexpected exits; a job interrupted by a worker crash stays queued
on disk for retry. A single inference has a 15-minute timeout and then fails
with a visible job error so it cannot block later work. Host shutdown stops the
worker and persists its active job back to the queue before exit.

`jobs.json` stores job ownership, status and the audio path needed to recover a
queued job. Completed text uses the Host's encrypted-result callbacks. Audio
files are removed after completion or cancellation and abandoned temporary
files are cleaned during startup/retention cleanup.
