@echo off
setlocal EnableDelayedExpansion
title Web Deploy - MediLog NG
echo ==========================================
echo  MediLog NG - Web DEPLOY (clean rebuild + Firebase^)
echo  Usage: Web-Deploy.bat [patch^|minor^|major]
echo         No arg = deploy same version, fresh code.
echo ==========================================
echo.

:: Project root = two levels up from scripts\dev_test
cd /d "%~dp0..\.."
if not exist "package.json" (
    echo [ERROR] Could not find project root.
    echo Window stays open so you can copy. Press Enter when done...
set /p DONE=Press Enter to close...
    exit /b 1
)

:: Optional version bump: Web-Deploy.bat patch
set BUMP=
if /I "%~1"=="patch" set BUMP=patch
if /I "%~1"=="minor" set BUMP=minor
if /I "%~1"=="major" set BUMP=major
if defined BUMP (
    echo [1/5] Bumping version: %BUMP%...
    call node scripts/bump-version.mjs %BUMP%
    if errorlevel 1 (
        echo [ERROR] Version bump failed.
        echo Window stays open so you can copy. Press Enter when done...
set /p DONE=Press Enter to close...
        exit /b 1
    )
) else (
    echo [1/5] No version bump - deploying current version with fresh code.
)

echo [2/5] Checking Node.js + dependencies...
where node >nul 2>nul
if errorlevel 1 (
    echo [ERROR] Node.js not found.
    echo Window stays open so you can copy. Press Enter when done...
set /p DONE=Press Enter to close...
    exit /b 1
)
if not exist "node_modules\.bin\vite.cmd" (
    call npm install
    if errorlevel 1 (
        echo [ERROR] npm install failed.
        echo Window stays open so you can copy. Press Enter when done...
set /p DONE=Press Enter to close...
        exit /b 1
    )
)
if not exist "node_modules\.bin\firebase.cmd" (
    echo [2/5] firebase-tools missing - installing dependencies...
    call npm install
    if errorlevel 1 (
        echo [ERROR] npm install failed - firebase-tools missing.
        echo Window stays open so you can copy. Press Enter when done...
set /p DONE=Press Enter to close...
        exit /b 1
    )
)

echo [3/5] Cleaning stale output (full rebuild, no leftovers)...
if exist "dist" rmdir /s /q "dist"
if exist ".firebase" rmdir /s /q ".firebase"
if exist "dist" (
    echo [ERROR] Could not delete dist\ - close dev server or editor locking it, then retry.
    echo Window stays open so you can copy. Press Enter when done...
set /p DONE=Press Enter to close...
    exit /b 1
)
echo [OK] dist\ + .firebase\ cache cleared.

echo [4/5] Stamping build time + rebuilding web app from current source...
call node scripts/stamp-build.mjs
if errorlevel 1 (
    echo [ERROR] Build stamp failed. Nothing deployed.
    echo Window stays open so you can copy. Press Enter when done...
set /p DONE=Press Enter to close...
    exit /b 1
)
call npm run build
if errorlevel 1 (
    echo [ERROR] Build failed. Nothing deployed.
    echo Window stays open so you can copy. Press Enter when done...
set /p DONE=Press Enter to close...
    exit /b 1
)
if not exist "dist\index.html" (
    echo [ERROR] Build produced no dist\index.html. Nothing deployed.
    echo Window stays open so you can copy. Press Enter when done...
set /p DONE=Press Enter to close...
    exit /b 1
)
echo [OK] dist/ freshly rebuilt from current source - verified dist\index.html exists.

echo [5/5] Deploying to Firebase (hosting + firestore^)...
call npx --no-install firebase deploy --only hosting,firestore --project medlogng --non-interactive
if errorlevel 1 (
    echo [ERROR] Deploy failed. Check you are logged in: npx firebase login
    echo and that project "medlogng" exists. If Firestore is being enabled
    echo for the first time, the first deploy can take a few minutes.
    echo Window stays open so you can copy. Press Enter when done...
set /p DONE=Press Enter to close...
    exit /b 1
)

echo.
echo ==========================================
echo  SUCCESS! Web deployed (clean rebuild^).
echo  If you still see old content, hard-refresh:
echo    Chrome/Edge: Ctrl+Shift+R, or clear
echo    site data for the hosted URL once.
echo  Welcome-page footer BUILD_TIME proves the new build.
echo ==========================================
echo Window stays open so you can copy. Press Enter when done...
set /p DONE=Press Enter to close...
