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
    set "FAILMSG=Could not find project root."
    goto :fail
)

:: Optional version bump: Web-Deploy.bat patch
set BUMP=
if /I "%~1"=="patch" set BUMP=patch
if /I "%~1"=="minor" set BUMP=minor
if /I "%~1"=="major" set BUMP=major
if defined BUMP (
    echo [1/6] Bumping version: %BUMP%...
    call node scripts/bump-version.mjs %BUMP%
    if errorlevel 1 (
        set "FAILMSG=Version bump failed."
        goto :fail
    )
) else (
    echo [1/6] No version bump - deploying current version with fresh code.
)

echo [2/6] Checking Node.js + dependencies...
where node >nul 2>nul
if errorlevel 1 (
    set "FAILMSG=Node.js not found."
    goto :fail
)
if not exist "node_modules\.bin\vite.cmd" (
    call npm install
    if errorlevel 1 (
        set "FAILMSG=npm install failed."
        goto :fail
    )
)
if not exist "node_modules\.bin\firebase.cmd" (
    echo [2/6] firebase-tools missing - installing dependencies...
    call npm install
    if errorlevel 1 (
        set "FAILMSG=npm install failed - firebase-tools missing."
        goto :fail
    )
)

:: Stale node.exe processes (a stuck previous deploy, a leftover dev server)
:: hold npm/Vite cache locks and make `vite build` hang forever with no output.
echo [3/6] Clearing stale dev/build processes (they can deadlock Vite^)...
call node scripts/clear-build-lock.mjs
if errorlevel 1 (
    set "FAILMSG=Port 5174 is still held by another process - close extra terminals and retry."
    goto :fail
)

echo [4/6] Cleaning stale output (full rebuild, no leftovers)...
if exist "dist" rmdir /s /q "dist"
if exist ".firebase" rmdir /s /q ".firebase"
if exist "dist" (
    set "FAILMSG=Could not delete dist\ - close the dev server or editor locking it, then retry."
    goto :fail
)
echo [OK] dist\ + .firebase\ cache cleared.

echo [5/6] Stamping build time + rebuilding web app from current source...
call node scripts/stamp-build.mjs
if errorlevel 1 (
    set "FAILMSG=Build stamp failed. Nothing deployed."
    goto :fail
)
:: Hard 5-minute cap: a wedged vite build dies loudly instead of hanging forever.
call node scripts/run-with-timeout.mjs 300 npm run build
if errorlevel 1 (
    set "FAILMSG=Build failed or timed out after 5 minutes. Nothing deployed."
    goto :fail
)
if not exist "dist\index.html" (
    set "FAILMSG=Build produced no dist\index.html. Nothing deployed."
    goto :fail
)
echo [OK] dist/ freshly rebuilt from current source - verified dist\index.html exists.

echo [6/6] Deploying to Firebase (hosting + firestore^)...
:: 15-minute cap (first Firestore enablement can be slow, but not infinite).
call node scripts/run-with-timeout.mjs 900 npx --no-install firebase deploy --only hosting,firestore --project medlogng --non-interactive
if errorlevel 1 (
    echo [ERROR] Deploy failed or timed out after 15 minutes. Check you are logged in:
    echo   npx firebase login
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
exit /b 0

:fail
echo.
echo [ERROR] !FAILMSG!
echo Window stays open so you can copy. Press Enter when done...
set /p DONE=Press Enter to close...
exit /b 1
