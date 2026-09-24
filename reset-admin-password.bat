@echo off
setlocal
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0ops\Reset-OwnerPassword.ps1"
if errorlevel 1 (
  echo.
  echo Password reset failed. Review the error above.
) else (
  echo.
  echo Password reset completed.
)
pause
endlocal
