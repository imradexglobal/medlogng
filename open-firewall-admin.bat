@echo off
setlocal
title MediLog NG - Open Firewall Rule

echo ============================================================
echo   MediLog NG Host - Windows Firewall Rule Configurator
echo ============================================================
echo.

:: Check for Administrative privileges
net session >nul 2>&1
if %errorlevel% neq 0 (
    echo [REQUESTING ADMIN RIGHTS] Relaunching with Administrator privileges...
    powershell.exe -NoProfile -Command "Start-Process cmd.exe -ArgumentList '/c \"\"%~f0\"\"' -Verb RunAs"
    exit /b
)

echo Adding Windows Firewall Rule for MediLog NG Host (TCP Port 8787)...
powershell.exe -NoProfile -Command "Get-NetFirewallRule -DisplayName 'MediLog NG Host' -ErrorAction SilentlyContinue | Remove-NetFirewallRule -ErrorAction SilentlyContinue; New-NetFirewallRule -DisplayName 'MediLog NG Host' -Direction Inbound -Protocol TCP -LocalPort 8787 -Action Allow -Profile Domain,Private | Out-Null"

if %errorlevel% equ 0 (
    echo.
    echo ============================================================
    echo [SUCCESS] Firewall rule 'MediLog NG Host' added successfully!
    echo Inbound TCP Port 8787 is now open for Domain and Private LAN.
    echo Other PCs in the hospital can now reach this Host PC.
    echo ============================================================
) else (
    echo.
    echo [ERROR] Failed to add firewall rule.
)

echo.
pause
