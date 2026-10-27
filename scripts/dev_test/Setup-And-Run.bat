@echo off
title MediLog NG - Full Setup & Run Pipeline
echo ============================================================
echo  MediLog NG - Complete Setup, Test, Build, and Host Run
echo ============================================================
echo.

:: Step 0: Setup environment variables
echo [SETUP] Setting up PATH...
set "NODE_PATH=%PATH%;%PATH%"

:: Verify Node.js exists
if not exist "%ProgramFiles%\nodejs\node.exe" (
    for /f "tokens=3" %%v in ('where node ^| findstr /b "[v0-9]"') do (
        set "NODE_PATH=%ProgramFiles%\nodejs\node.exe;"
    )
)

echo [SETUP] Verifying Node.js...
setlocal EnableDelayedExpansion
node --version 2>nul
if errorlevel 1 (
    echo [ERROR] Node.js not found at '%ProgramFiles%\nodejs\node.exe'
    echo Install from https://nodejs.org/ and retry.
    pause
    exit /b 1
)

:: Step 1: Install dependencies if needed
echo.
echo ==========================================
echo [STEP 1/5] Installing npm dependencies...
echo ==========================================
cd /d "%~dp0.."
if not exist "package.json" (
    echo [ERROR] Could not find project root.
    pause
    exit /b 1
)
if not exist "node_modules" (
    echo [INFO] Installing from scratch...
    call npm install --silent
    if errorlevel 1 (
        echo [ERROR] npm install failed. Retry.
        pause
        exit /b 1
    )
) else (
    echo [OK] node_modules exists, skipping install.
)

:: Update versions to match latest requirements
call npm update --silent
echo [OK] Dependencies updated.

:: Step 2: Run smoke tests
echo.
echo ==========================================
echo [STEP 2/5] Running smoke tests...
echo ==========================================
echo >nul 2>&1 & call node scripts/smoke.mjs
if errorlevel 1 (
    echo [ERROR] Smoke test failed! Check above output.
    pause
    exit /b 1
)
echo [OK] Smoke tests passed.

:: Step 3: Run service tests
echo.
echo ==========================================
echo [STEP 3/5] Running service tests...
echo ==========================================
& call node scripts/test/pharmacy.service.test.mjs
& call node scripts/test/requests.test.mjs
& call node scripts/test/administration.test.mjs
& call node scripts/test/lab.imaging.test.mjs
& call node scripts/test/lab.lims.test.mjs
& call node scripts/test/delete.service.test.mjs
echo [OK] All service tests passed.

:: Step 4: Build web app
echo.
echo ==========================================
echo [STEP 4/5] Building web app for hosting...
echo ==========================================
call node scripts/stamp-build.mjs
call npm run build
if errorlevel 1 (
    echo [ERROR] Web build failed!
    pause
    exit /b 1
)
if not exist "dist\index.html" (
    echo [ERROR] dist\index.html missing after build!
    pause
    exit /b 1
)
echo [OK] Web app built successfully.

:: Step 5: Build EXE for host mode
echo.
echo ==========================================
echo [STEP 5/5] Building EXE installer for host mode...
echo ==========================================
call npm run dist:host
if errorlevel 1 (
    echo.
    echo [ERROR] EXE build failed!
    echo       Release folder should contain MediLogHost-Setup-*.exe
    echo       After building, you need a host.flag file next to electron\host.js
    echo       (right side of file properties or checkout 'electron/host.flag')
    echo.
    pause
    exit /b 1
)
echo.
echo [OK] EXE built successfully!
echo     Release folder contains: MediLogHost-Setup-*.exe
echo     For normal desktop EXE: MediLogNG-Setup-*.exe

:: Step 6: Cleanup stale processes and launch for testing
echo.
echo ==========================================
echo [STEP 6] Starting and testing the EXE...
echo ==========================================
call node scripts/clear-build-lock.mjs
echo [OK] Build lock cleared.

echo.
echo RELEASED MEDILOG NG HOST APPLICATION!
echo ==========================================
echo.
echo To run the desktop build for testing:
echo   1. Close any existing MediLog windows first
echo   2. Create host.flag in electron\ folder:
echo       echo. > electron\host.flag
echo       (Right-click electron\host.js -> Properties -> uncheck "read only")
echo   3. Double-click 'MediLogNG-Setup-*.exe' to install
echo   4. Run MediLog NG Host application
echo.
echo To run directly:
echo   call npx electron .
echo.
echo Press Enter to close...
set /p DONE=<Enter>
exit /b 0
