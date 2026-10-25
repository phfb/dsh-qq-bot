@echo off
rem %~dp0 = this script's own folder, so the whole package can be moved anywhere.
powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "%~dp0settings-ui.ps1"
