@echo off
setlocal

echo ============================================
echo  MediLog NG Host - Publish to GitHub
echo ============================================
echo.

:: ── 1. Get GitHub Token ──────────────────────────────────────────────────────
if "%GH_TOKEN%"=="" (
    set /p GH_TOKEN="Enter your GitHub token (ghp_...): "
)

if "%GH_TOKEN%"=="" (
    echo ERROR: No GitHub token provided. Exiting.
    pause
    exit /b 1
)

:: ── 2. Build + Package + Upload ──────────────────────────────────────────────
echo.
echo [1/2] Building and publishing Host release...
echo.

call npm run publish:host

if %ERRORLEVEL% neq 0 (
    echo.
    echo ERROR: Build or publish failed. Check output above.
    pause
    exit /b 1
)

:: ── 3. Find the draft release and publish it ─────────────────────────────────
echo.
echo [2/2] Promoting draft release to public...
echo.

:: Read version from package.json
for /f "tokens=2 delims=:, " %%v in ('findstr /i "\"version\"" package.json') do (
    set RAW_VER=%%v
    goto :got_version
)
:got_version
:: Strip quotes
set VERSION=%RAW_VER:"=%
set TAG=v%VERSION%

echo Detected version: %TAG%
echo.

:: Use PowerShell to publish the draft via GitHub API
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$headers = @{ Authorization = 'token %GH_TOKEN%'; 'User-Agent' = 'MediLogNG'; 'Content-Type' = 'application/json' };" ^
  "$releases = Invoke-RestMethod -Uri 'https://api.github.com/repos/imradexglobal/medlogng/releases' -Headers $headers;" ^
  "$draft = $releases | Where-Object { $_.tag_name -eq '%TAG%' };" ^
  "if (-not $draft) { Write-Host 'WARNING: Release %TAG% not found on GitHub. It may already be published or the upload failed.'; exit 1 };" ^
  "if (-not $draft.draft) { Write-Host 'Release %TAG% is already public! Nothing to do.'; exit 0 };" ^
  "$body = @{ draft = $false; name = '%TAG%' } | ConvertTo-Json;" ^
  "$result = Invoke-RestMethod -Method Patch -Uri ('https://api.github.com/repos/imradexglobal/medlogng/releases/' + $draft.id) -Headers $headers -Body $body;" ^
  "Write-Host '';" ^
  "Write-Host '✅ Published: ' $result.html_url;" ^
  "Write-Host 'Assets: ' ($result.assets.name -join ', ');"

if %ERRORLEVEL% neq 0 (
    echo.
    echo WARNING: Could not auto-publish the draft.
    echo Go to https://github.com/imradexglobal/medlogng/releases and publish it manually.
    pause
    exit /b 1
)

echo.
echo ============================================
echo  Done! v%VERSION% is now live on GitHub.
echo  Existing installs will auto-update.
echo ============================================
echo.
pause
endlocal
