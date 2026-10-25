@echo off
rem ============================================================
rem  dsh-qq-bot - status tray launcher
rem  Starts bot-tray.ps1 with a hidden console window.
rem  A colored dot appears in the notification area:
rem    green  = link is fully up
rem    yellow = partially up
rem    red    = something essential is down
rem  Double-click the tray icon for the full report.
rem ============================================================
setlocal
set "SCRIPT=%~dp0bot-tray.ps1"

if not exist "%SCRIPT%" (
  echo [ERROR] bot-tray.ps1 was not found next to this file.
  echo         Keep bot-tray.cmd and bot-tray.ps1 in the same folder.
  pause
  exit /b 1
)

start "" powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "%SCRIPT%"
exit /b 0
