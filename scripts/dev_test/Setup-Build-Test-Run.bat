@echo off
title MediLog NG - Setup, Build & Test Pipeline
echo ============================================================
echo  MediLog NG - Build, Test & Run the Host Application
echo ============================================================
echo.

cd /d "%~dp0.."
if not exist "package.json" (
    echo [ERROR] Could not find project root.
    pause & exit /b 1)

:: ============================================================
:: STEP 1: Install dependencies if needed
:: ============================================================
echo.
echo ==========================================
echo  [STEP 1/5] Checking dependencies...
echo ==========================================
if not exist "node_modules\.bin\vite.cmd" (
    echo Installing dependencies...
    call npm install --silent
    if errorlevel 1 ( echo [FAIL]; pause; exit /b 1 )
) else ( echo [OK] Dependencies present.
)
echo [OK] Dependencies ready.

:: ============================================================
:: STEP 2: Run smoke tests
:: ============================================================
echo.
echo ==========================================
echo  [STEP 2/5] Running smoke tests...
echo ==========================================
& call node scripts/smoke.mjs
if errorlevel 1 ( echo [FAIL] smoke test; pause; exit /b 1 )
echo [OK] Smoke tests passed.

:: ============================================================
:: STEP 3: Run service layer tests
:: ============================================================
echo.
echo ==========================================
echo  [STEP 3/5] Running service tests...
echo ==========================================
& call node scripts/test/pharmacy.service.test.mjs
& call node scripts/test/requests.test.mjs
& call node scripts/test/administration.test.mjs
& call node scripts/test/lab.imaging.test.mjs
& call node scripts/test/lab.lims.test.mjs
& call node scripts/test/delete.service.test.mjs
echo [OK] All service tests passed.

:: ============================================================
:: STEP 4: Build web app (for hosting / LAN hub)
:: ============================================================
echo.
echo ==========================================
echo  [STEP 4/5] Building web app...
echo ==========================================
call node scripts/stamp-build.mjs
call npm run build
if errorlevel 1 ( echo [FAIL] web build; pause; exit /b 1 )
if not exist "dist\index.html" ( echo [FAIL] no dist/index.html; pause; exit /b 1 )
echo [OK] Web app built successfully.

:: ============================================================
:: STEP 5: Package desktop build (win-unpacked)
:: ============================================================
echo.
echo ==========================================
echo  [STEP 5/5] Packaging desktop build...
echo ==========================================
call node scripts/stamp-build.mjs
call npm run dist:win
if errorlevel 1 ( echo [FAIL] EXE packaging; pause; exit /b 1 )
if not exist "release\win-unpacked\MediLogNG.exe" (
    echo [WARN] win-unpacked\MediLogNG.exe missing, checking alternative names...
    if not exist "release\win-unpacked\*.exe" (
        echo [FAIL] No EXE produced in release folder!
        pause
        exit /b 1
    )
)
echo [OK] Desktop build packaged successfully!
echo     EXE located at: release\win-unpacked\MediLogNG.exe
echo     Full installer (if Nsis works): release\MediLogNG-Setup-*.exe

echo.
echo ==========================================
echo  Starting MediLog NG desktop app for testing...
echo  Close window when done.
echo ==========================================
echo.
npx electron .
pause
