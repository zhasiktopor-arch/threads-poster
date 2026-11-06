@echo off
title Threads Poster - uninstall
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0app\uninstall.ps1"
echo.
pause
