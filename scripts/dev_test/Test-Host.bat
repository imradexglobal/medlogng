@echo off
title MediLog NG - Host Test Pipeline
echo ============================================================
echo  MediLog NG - Test Service + Launch Desktop Build
echo ============================================================
echo.

cd /d "%~dp0.."
if not exist "package.json" (
    echo [ERROR] Could not find project root.
    pause & exit /b 1)

:: Step 1: Install if needed
if not exist "node_modules\.bin\vite.cmd" (
    echo [STEP 1/3] Installing dependencies...
    call npm install --silent
    if errorlevel 1 ( echo [ERROR] npm install failed; pause; exit /b 1 )
) else ( echo [OK] Dependencies present.
)

:: Step 2: Tests
echo.
echo ==========================================
echo  [STEP 2/3] Running tests...
echo ==========================================
& call node scripts/smoke.mjs
if errorlevel 1 ( echo [FAIL]; pause; exit /b 1 )
echo [OK] Smoke passed.

& call node scripts/test/pharmacy.service.test.mjs
& call node scripts/test/requests.test.mjs
& call node scripts/test/administration.test.mjs
& call node scripts/test/lab.imaging.test.mjs
& call node scripts/test/lab.lims.test.mjs
& call node scripts/test/delete.service.test.mjs
echo [OK] All service tests passed.

:: Step 3: Build + Launch
echo.
echo ==========================================
echo  [STEP 3/3] Building web app...
echo ==========================================
call node scripts/stamp-build.mjs
call npm run build
if errorlevel 1 ( echo [FAIL]; pause; exit /b 1 )
if not exist "dist\index.html" ( echo [FAIL] no dist/index.html; pause; exit /b 1 )
echo [OK] Web app built.

echo.
echo ==========================================
echo  Launched MediLog NG desktop build...
echo  Close window when done.
echo ==========================================
echo.
:: Ensure dist is fresh for Electron
call node scripts/stamp-build.mjs
:: Fresh rebuild if dist looks stale
if not exist "dist\index.html" (
    call npm run build
)
echo Electron launched with fresh dist/.
call npx electron .

pause
