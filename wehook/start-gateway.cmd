@echo off
setlocal EnableExtensions
title Cloud Channel Gateway
cd /d "%~dp0"

if exist "%CD%\gateway.local.cmd" call "%CD%\gateway.local.cmd"

set "CHECK_ARG="
if /I "%~1"=="--check" set "CHECK_ARG=-Check"

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%CD%\start-gateway.ps1" %CHECK_ARG%
set "EXIT_CODE=%ERRORLEVEL%"

if /I "%~1"=="--check" exit /b %EXIT_CODE%

echo.
echo Gateway process exited with code %EXIT_CODE%.
pause
exit /b %EXIT_CODE%
