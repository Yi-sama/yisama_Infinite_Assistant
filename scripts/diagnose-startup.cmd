@echo off
title Yisama Startup Check
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0diagnose-startup.ps1" -NoPause
echo.
echo Send a screenshot of this window.
pause
