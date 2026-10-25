@echo off
rem ============================================================
rem  dsh-qq-bot - one-click launcher
rem  Order: QQ client -> SnowLuma (OneBot) -> DSH host -> self check
rem  The QQ account must already be logged in by you; no script can do that.
rem ============================================================
setlocal
title dsh-qq-bot launcher
set "SCRIPT=%~dp0start-bot.ps1"

if not exist "%SCRIPT%" (
  echo [ERROR] start-bot.ps1 was not found next to this file.
  echo         Keep start-bot.cmd and start-bot.ps1 in the same folder.
  pause
  exit /b 1
)

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT%" -Wait
exit /b %ERRORLEVEL%
