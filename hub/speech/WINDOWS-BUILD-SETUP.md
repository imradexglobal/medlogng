# Windows speech asset build setup

This guide prepares a Windows x64 development machine to build the existing
Host speech assets. It does not change the application or its runtime
architecture. Phase 1 remains open until the actual assets, installer, and
runtime tests have been verified.

## Pinned inputs and official sources

| Input | Pin / license | Official source |
|---|---|---|
| whisper.cpp | `v1.9.5`, commit beginning `d1be6fd`, MIT | <https://github.com/ggml-org/whisper.cpp> |
| English model | `tiny.en-q5_1`, repository revision `f281eb4`, MIT; SHA-256 `c77c5766f1cef09b6b7d47f21b546cbddd4157886b3b5d6d4f709e91e66c7c2b` | <https://huggingface.co/ggerganov/whisper.cpp/resolve/f281eb4/ggml-tiny.en-q5_1.bin> |
| FFmpeg | `9.0.2`, LGPL configuration only; source archive must pass detached signature verification | <https://ffmpeg.org/releases/ffmpeg-9.0.2.tar.xz> |
| FFmpeg signature | detached `.asc`; official release key fingerprint `FCF986EA15E6E293A5644F10B4322F04D67658D8` | <https://ffmpeg.org/releases/ffmpeg-9.0.2.tar.xz.asc> |
| FFmpeg release key | `ffmpeg-devel.asc` | <https://ffmpeg.org/ffmpeg-devel.asc> |

The worker and model pins/licenses and FFmpeg version/signature/license are
checked by the existing asset build and verification scripts. Keep the final
`vendor/speech/speech-assets.json` manifest with the release outputs; it records
the exact source, toolchain, configuration and SHA-256 values used for that
build. Do not call the process reproducible until a clean second build from the
same recorded inputs has been compared.

## 1. Common prerequisites

- Windows 10 or 11 x64 development PC with internet access for pinned source
  and model retrieval. The runtime Host and client PCs do not need internet for
  transcription.
- Git for Windows: <https://git-scm.com/download/win>.
- Node.js 20.x x64 (the repository declares Node `>=20`) and npm, for the
  existing Host packaging scripts: <https://nodejs.org/en/download>.
- A checkout of this repository and its normal npm dependencies installed.

Check common tools in PowerShell:

```powershell
node --version
npm --version
git --version
node -p "process.arch"
```

`process.arch` should print `x64`. Preserve `package-lock.json` and use
`npm ci` when installing the repository dependencies.

## 2. Whisper worker: MSVC toolchain

Whisper is built as a native Windows x64 executable with **MSVC**. CMake drives
the Visual Studio generator. This build does not use the MSYS2 compiler.

1. Install **Visual Studio 2022 Build Tools** from
   <https://visualstudio.microsoft.com/downloads/> (Tools for Visual Studio →
   Build Tools).
2. In the installer select **Desktop development with C++**, including MSVC
   v143 x64/x86 build tools and a Windows 10 or Windows 11 SDK. No full Visual
   Studio IDE is required.
3. Install CMake 3.20 or newer from <https://cmake.org/download/>. Select the
   option to add CMake to the system PATH, or add its `bin` folder to PATH.
4. Install Git for Windows if it was not installed under common prerequisites.

Open **x64 Native Tools Command Prompt for VS 2022** (or its PowerShell
shortcut) so MSVC and the Windows SDK environment is initialized. From there,
open PowerShell in the repository. No persistent compiler environment
variables are required; the Visual Studio prompt sets `PATH`, `INCLUDE`,
`LIB`, and `LIBPATH` for that shell. Do not point this build at MSYS2 GCC.

Verify from that initialized shell:

```powershell
where.exe cl
cl /Bv
where.exe cmake
cmake --version
where.exe git
git --version
```

`cl /Bv` must report the Microsoft x64 compiler. CMake must report 3.20 or
newer. The project build script explicitly selects generator `Visual Studio 17
2022` and architecture `x64`; it pins whisper.cpp to `v1.9.5` and checks the
resolved commit. It downloads and verifies the pinned model hash. Do not
manually substitute another model.

## 3. FFmpeg: MSYS2 UCRT64 toolchain

FFmpeg is a separate native build. Its configure/make process uses **MSYS2
UCRT64 MinGW-w64 GCC**, NASM and GNU build utilities, not MSVC. The existing
design packages a standalone static FFmpeg command-line converter; it does not
link FFmpeg libraries into the application. It must be built without GPL or
nonfree options. Development tools remain on the build PC and are not
prerequisites for Host users.

1. Install MSYS2 only from <https://www.msys2.org/>.
2. Open **MSYS2 UCRT64** from the Start menu. Update its package database and
base system as directed by the official MSYS2 installation guide; close and
reopen UCRT64 if the updater requests it.
3. In the UCRT64 terminal install the build tools:

```bash
pacman -S --needed base-devel mingw-w64-ucrt-x86_64-toolchain \
  mingw-w64-ucrt-x86_64-nasm gnupg
```

These are the base build tools, UCRT64 compiler, assembler and signature
verifier for the stated configuration. It uses FFmpeg's built-in codecs and
does not enable optional external codec libraries. If configure reports a
missing dependency, stop and review it before adding a package; record every
installed package in the build receipt. Do not enable GPL/nonfree components.

4. Verify the UCRT64 tools in that same terminal:

```bash
echo "$MSYSTEM"
which gcc
gcc --version
which make
make --version
which nasm
nasm -v
which pkgconf
pkgconf --version
which gpg
gpg --version
pacman -Q
```

`MSYSTEM` must be `UCRT64`; `which gcc` should resolve below `/ucrt64/bin`.
Save the complete `pacman -Q` output with the build records so the rolling
MSYS2 environment can be reconstructed as closely as possible. MSYS2 package
repositories are rolling, so record versions and archive/cache the exact
packages used; the package names alone do not make a build reproducible.

5. Download only the official FFmpeg source archive, detached signature, and
   key listed above. Place them in:

```text
vendor/speech/ffmpeg-source/ffmpeg-9.0.2.tar.xz
vendor/speech/ffmpeg-source/ffmpeg-9.0.2.tar.xz.asc
vendor/speech/ffmpeg-source/ffmpeg-devel.asc
```

Before unpacking or building the source, verify its signature in the UCRT64
terminal. From the repository root:

```bash
cd /c/Users/User/Documents/GitHub/medlogng
mkdir -p .cache/ffmpeg-gpg-manual
chmod 700 .cache/ffmpeg-gpg-manual
gpg --homedir "$PWD/.cache/ffmpeg-gpg-manual" --batch --import \
  vendor/speech/ffmpeg-source/ffmpeg-devel.asc
gpg --homedir "$PWD/.cache/ffmpeg-gpg-manual" --batch --with-fingerprint \
  --show-keys vendor/speech/ffmpeg-source/ffmpeg-devel.asc
gpg --homedir "$PWD/.cache/ffmpeg-gpg-manual" --batch --verify \
  vendor/speech/ffmpeg-source/ffmpeg-9.0.2.tar.xz.asc \
  vendor/speech/ffmpeg-source/ffmpeg-9.0.2.tar.xz
```

Confirm the displayed primary fingerprint is exactly
`FCF986EA15E6E293A5644F10B4322F04D67658D8` and GnuPG reports a good
signature. Do not extract or build if either check fails. The later asset
build independently repeats signature and fingerprint verification using an
isolated temporary keyring.

6. In UCRT64, unpack the verified source and configure/build it. Start from the
   repository's pinned configuration in `hub/speech/README.md`:

```bash
cd /c/Users/User/Documents/GitHub/medlogng/vendor/speech/ffmpeg-source
tar -xf ffmpeg-9.0.2.tar.xz
cd ffmpeg-9.0.2
./configure --arch=x86_64 --target-os=mingw32 --disable-autodetect \
  --disable-shared --enable-static --disable-ffplay --disable-ffprobe \
  --disable-doc --disable-debug --extra-ldflags=-static
make -j2
./ffmpeg.exe -version
./ffmpeg.exe -L
```

Do not add `--enable-gpl` or `--enable-nonfree`. Verify that the reported
configuration/license match the intended LGPL-only setup. Copy the resulting
`ffmpeg.exe` to `vendor/speech/ffmpeg.exe`. Create
`vendor/speech/ffmpeg-build.json` using the receipt schema documented in
`hub/speech/README.md`; include source SHA-256, full `pacman -Q` toolchain
versions, and the complete configure argument array. The asset builder checks
the official signature against the pinned key fingerprint, the receipt, the
binary version/license/configuration and the source hash.

Use this JSON shape for the receipt (replace the example source hash with the
output of `sha256sum ffmpeg-9.0.2.tar.xz`, and store the complete `pacman -Q`
output as the `toolchain` value):

```json
{
  "schemaVersion": 1,
  "sourceVersion": "9.0.2",
  "sourceSha256": "<64-character lowercase SHA-256>",
  "toolchain": "<paste complete pacman -Q output here>",
  "configureArgs": [
    "--arch=x86_64",
    "--target-os=mingw32",
    "--disable-autodetect",
    "--disable-shared",
    "--enable-static",
    "--disable-ffplay",
    "--disable-ffprobe",
    "--disable-doc",
    "--disable-debug",
    "--extra-ldflags=-static"
  ]
}
```

The source hash command is:

```bash
sha256sum vendor/speech/ffmpeg-source/ffmpeg-9.0.2.tar.xz
```

Create `ffmpeg-build.json` with UTF-8 JSON after returning to PowerShell, or
use an editor that preserves the exact fields and configure argument strings.

MSYS2 tools are build-time only. The static FFmpeg configuration is intended
to avoid requiring a separately installed MSYS2 runtime, but that must be
verified on a clean supported Windows machine before release.

## 4. Environment and paths

No new permanent environment variables are required by this repository's
build scripts. Use the initialized VS x64 tools shell for the Whisper build
and the MSYS2 UCRT64 shell for FFmpeg. Do not combine their PATHs: MSYS2
utilities can shadow Windows tools and cause CMake/MSVC detection failures.

The repository scripts expect the project at any path, but FFmpeg's UCRT64
example above uses the supplied checkout path. If the checkout is elsewhere,
change only that `cd` path. Do not set `WHISPER_CPP_DIR` or other custom
overrides unless intentionally supplying a source tree; the script validates
the exact pin.

## 5. Build and verify assets

With the required tools installed, the normal path is to open PowerShell in the
repository and run:

```powershell
npm ci
npm run speech:build
npm run speech:verify
```

The first command is needed only when repository dependencies are not
installed. `speech:build` checks the MSVC/CMake tools, automatically invokes
the MSYS2 FFmpeg source builder when the signed source inputs or staged binary
are missing, then builds the pinned Whisper worker and model. It resumes from
the cached matching FFmpeg source tree and existing build outputs. Verification
checks all runtime assets and manifest hashes. Keep generated `.exe`, model,
build receipt, manifest, source archive/signature/key and toolchain records
available for installer verification.

An on-demand CI alternative is available in
`.github/workflows/build-speech-assets.yml`. It uses a Windows 2022 runner,
pinned workflow action commits and read-only repository permissions to build
and upload the verified runtime assets and provenance. No signing key or
application secret is used. CI can avoid installing the native build
toolchains on your development PC for the asset build; it does not currently
produce or validate the Host installer and does not replace the clean-machine
or actual 4 GB Host tests in
[`DEPLOYMENT-CHECKLIST.md`](DEPLOYMENT-CHECKLIST.md).

The Host installer is built only after assets verify:

```powershell
npm run dist:host
```

The repository's overall frontend build currently has a known, unrelated
BillingView/billingService error. Per the approved scope, do not modify billing
to work around it. If that error still prevents installer creation, record
that result separately from speech asset and worker test results.

## 6. Runtime compatibility and completion checks

The developer toolchains are not to be installed on Host/client PCs. Before
claiming release readiness, test the packaged worker and FFmpeg on a clean
machine matching the Windows versions supported by the existing Host
application. Verify process startup without Visual Studio runtimes installed,
or explicitly package any runtime dependency required by the worker. Then run
the real-worker audio, malformed-input, crash/restart, timeout, queue, Host
restart and multi-client tests. Measure memory, CPU and transcription time on
the actual 4 GB Host. Evaluate Nigerian English medical terms and medication
names without silently correcting recognition errors. Yoruba and
English/Yoruba code-switching remain outstanding; `tiny.en` is English-only.

Phase 1 remains **IN PROGRESS** until these actual asset, installer, real
transcription, recovery, language and performance results are reviewed.
