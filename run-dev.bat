@echo off
setlocal enabledelayedexpansion
title MediLog NG - Local Testing and Development

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

:MENU
cls
echo ============================================================
echo           MediLog NG - Local Testing and Development          
echo ============================================================
echo.
echo   [1] Test Host App (Host Mode: Setup Wizard + Tray + LAN Server)
echo       * Exercises the exact Host PC app hospitals will run.
echo       * Serves http://localhost:8787 and LAN IP to other devices.
echo.
echo   [2] Test Hub Server Only (Headless Node.js Hub on port 8787)
echo       * Fast LAN server in terminal without opening Electron.
echo.
echo   [3] Test Web App (Vite Dev Server on port 5174)
echo       * Hot Module Replacement for fast UI development.
echo.
echo   [4] Test Regular Desktop App (Standard Electron Client)
echo       * Single-PC offline desktop mode.
echo.
echo   [5] Run All Automated Tests (Smoke + Services + Hub)
echo.
echo   [0] Exit
echo.
echo ============================================================
set "CHOICE=1"
set /p "CHOICE=Enter selection [1-5, default=1]: "

if "%CHOICE%"=="1" goto TEST_HOST
if "%CHOICE%"=="2" goto TEST_HUB
if "%CHOICE%"=="3" goto TEST_WEB
if "%CHOICE%"=="4" goto TEST_DESKTOP
if "%CHOICE%"=="5" goto RUN_TESTS
if "%CHOICE%"=="0" exit /b 0

echo Invalid choice. Try again.
pause
goto MENU

:TEST_HOST
echo.
echo ============================================================
echo Starting MediLog NG Host Mode...
echo ============================================================
echo [1/2] Stamping version and building web app (dist/)...
call node scripts/stamp-build.mjs
call npm run build
if %errorlevel% neq 0 (
    echo [ERROR] Build failed.
    pause
    goto MENU
)
echo.
echo [2/2] Launching Host Electron App...
echo - Local URL: http://127.0.0.1:8787
echo - Close the window or quit from the system tray when finished.
echo.
call node scripts/start-host.mjs
echo.
echo Host mode closed.
pause
goto MENU

:TEST_HUB
echo.
echo ============================================================
echo Starting Headless Hub Server...
echo ============================================================
if not exist "dist\index.html" (
    echo Building dist first...
    call npm run build
)
echo.
echo Listening on port 8787. Press Ctrl+C to stop.
call npm run hub
pause
goto MENU

:TEST_WEB
echo.
echo ============================================================
echo Starting Vite Dev Server...
echo ============================================================
echo Dev URL: http://localhost:5174
call npm run dev
pause
goto MENU

:TEST_DESKTOP
echo.
echo ============================================================
echo Starting Regular Electron Desktop Mode...
echo ============================================================
if not exist "dist\index.html" (
    echo Building dist first...
    call npm run build
)
call npm run electron:dev
pause
goto MENU

:RUN_TESTS
echo.
echo ============================================================
echo Running Smoke, Service, and Hub Tests...
echo ============================================================
call npm test
echo.
pause
goto MENU
