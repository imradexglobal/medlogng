@echo off
setlocal enabledelayedexpansion
title MediLog NG - Build Host Installer (.exe)

:: Determine project root
if exist "%~dp0package.json" (
    cd /d "%~dp0"
) else if exist "%~dp0..\package.json" (
    cd /d "%~dp0.."
) else (
    echo [ERROR] Could not find package.json in current or parent directory.
    pause
    exit /b 1
)

:: Locate Node.js and NPM
where node >nul 2>&1
if %errorlevel% neq 0 (
    if exist "C:\nodejs\nodejs\node-v20.18.0-win-x64\node.exe" (
        set "PATH=C:\nodejs\nodejs\node-v20.18.0-win-x64;%PATH%"
    ) else if exist "C:\Program Files\nodejs\node.exe" (
        set "PATH=C:\Program Files\nodejs;%PATH%"
    ) else if exist "%LOCALAPPDATA%\Programs\node\node.exe" (
        set "PATH=%LOCALAPPDATA%\Programs\node;%PATH%"
    ) else (
        echo [ERROR] Node.js is not found in PATH or standard installation folders.
        echo Please ensure Node.js is installed.
        pause
        exit /b 1
    )
)

echo.
echo ============================================================
echo   MediLog NG - Building Host App (.exe) Installer
echo ============================================================
echo   Output Target: MediLogHost-Setup-*.exe
echo   Destination:   release\
echo ============================================================
echo.

:: Speech runtime assets are mandatory for Host installers. This step builds
:: the pinned CPU worker, verifies the model and FFmpeg, and writes hashes.
echo [1/4] Preparing and validating offline speech assets...
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%cd%\scripts\build-whisper-worker.ps1"
if %errorlevel% neq 0 (
    echo [ERROR] Speech assets could not be built or verified. No installer was created.
    pause
    exit /b 1
)
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%cd%\scripts\verify-speech-assets.ps1"
if %errorlevel% neq 0 (
    echo [ERROR] Speech asset verification failed. No installer was created.
    pause
    exit /b 1
)

:: Stamp build version and timestamp
echo [2/4] Stamping build version...
call node scripts/stamp-build.mjs
if %errorlevel% neq 0 (
    echo [ERROR] Failed to stamp build version.
    pause
    exit /b 1
)

:: Build Host Installer
echo.
echo [3/4] Building Web App and packaging Host Executable...
echo       Running: npm run dist:host
echo.
call npm run dist:host
if %errorlevel% neq 0 (
    echo.
    echo ============================================================
    echo [BUILD FAILED] An error occurred during the packaging step.
    echo See the output above for error details.
    echo ============================================================
    pause
    exit /b 1
)

echo.
echo ============================================================
echo [4/4] BUILD COMPLETE AND SUCCESSFUL!
echo ============================================================
echo.
echo The installer executable is located at:
dir /b release\MediLogHost-Setup-*.exe 2>nul
echo Full path: %cd%\release\
echo.
echo Instructions for the Hospital:
echo   1. Copy the MediLogHost-Setup-*.exe installer to the Host PC.
echo   2. Run the installer on that PC (creates desktop shortcut + tray).
echo   3. On first launch, follow the 3-step wizard:
echo        - Choose the Firebase service-account.json key
echo        - Click 'Open firewall...' (allows port 8787 on Private LAN)
echo        - Click 'Finish setup'
echo   4. The Host PC will display its LAN address (e.g. http://192.168.1.50:8787).
echo   5. All other PCs in the hospital simply open Chrome/Edge and go to:
echo        http://^<HOST_IP^>:8787
echo ============================================================
echo.
pause
