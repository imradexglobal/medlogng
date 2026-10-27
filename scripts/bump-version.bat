@echo off
setlocal enabledelayedexpansion
title MediLog NG - Version Bumper

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
echo                 MediLog NG - Version Bumper                 
echo ============================================================
echo.
for /f "tokens=*" %%v in ('node -e "console.log(JSON.parse(require('fs').readFileSync('package.json')).version)" 2^>nul') do set "CUR_VER=%%v"
if defined CUR_VER (
    echo   Current Version: v!CUR_VER!
) else (
    echo   Current Version: [Unknown]
)
echo.
echo   Select update type:
echo.
echo     [1] PATCH - Bug fixes, small tweaks, corrections
echo                 Example: v!CUR_VER! -^> (bumps last number)
echo.
echo     [2] MINOR - New features, reports, UI additions
echo                 Example: v!CUR_VER! -^> (bumps middle number)
echo.
echo     [3] MAJOR - Major overhaul or complete restructuring
echo                 Example: v!CUR_VER! -^> (bumps first number)
echo.
echo     [0] Cancel and Exit
echo.
echo ============================================================
set "CHOICE="
set /p "CHOICE=Enter choice [1-3, default=1]: "
if defined CHOICE (
    set "CHOICE=!CHOICE: =!"
)
if "!CHOICE!"=="" set "CHOICE=1"

if "!CHOICE!"=="1" set "BUMP_TYPE=patch" & goto DO_BUMP
if "!CHOICE!"=="2" set "BUMP_TYPE=minor" & goto DO_BUMP
if "!CHOICE!"=="3" set "BUMP_TYPE=major" & goto DO_BUMP
if "!CHOICE!"=="0" exit /b 0

echo.
echo [ERROR] Invalid choice '!CHOICE!'. Please enter 1, 2, 3, or 0.
pause
goto MENU

:DO_BUMP
echo.
echo ============================================================
echo Bumping version as [%BUMP_TYPE%]...
echo ============================================================
echo.
call node scripts/bump-version.mjs %BUMP_TYPE%
if %errorlevel% neq 0 (
    echo.
    echo [ERROR] Version bump failed. Check the error output above.
    echo.
    pause
    exit /b 1
)

for /f "tokens=*" %%v in ('node -e "console.log(JSON.parse(require('fs').readFileSync('package.json')).version)" 2^>nul') do set "NEW_VER=%%v"

echo.
echo ============================================================
echo [SUCCESS] Version successfully bumped to: v!NEW_VER!
echo ============================================================
echo.
echo What to do next:
echo   1. Run 'build-host.bat' to build the new installer:
echo        release\MediLogHost-Setup-!NEW_VER!.exe
echo.
echo   2. Save and push your code to GitHub:
echo        git add .
echo        git commit -m "Bump version to v!NEW_VER!"
echo        git push origin main
echo.
echo   3. Create a GitHub Release titled 'MediLog NG v!NEW_VER!'
echo      and upload 'MediLogHost-Setup-!NEW_VER!.exe' and 'host.yml'.
echo ============================================================
echo.
pause
