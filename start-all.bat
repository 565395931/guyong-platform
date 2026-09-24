@echo off
setlocal EnableExtensions
cd /d "%~dp0"
title Guyong Customer Service Platform

set "START_SCRIPT=%CD%\ops\Start-Platform.ps1"
set "EXTRA_ARGS="
if /I "%~1"=="--dry-run" set "EXTRA_ARGS=-DryRun"

if not exist "%START_SCRIPT%" (
  echo Startup script is missing:
  echo %START_SCRIPT%
  goto :failed
)

echo Starting the customer service platform. Please wait...
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%START_SCRIPT%" %EXTRA_ARGS%
set "EXIT_CODE=%ERRORLEVEL%"

if /I "%~1"=="--dry-run" exit /b %EXIT_CODE%
if not "%EXIT_CODE%"=="0" goto :failed

echo.
echo Startup completed. Closing this window will not stop background services.
echo Press any key to close this window.
pause >nul
exit /b 0

:failed
echo.
echo Startup failed. Review the error message above.
echo Press any key to close this window.
pause >nul
exit /b 1
