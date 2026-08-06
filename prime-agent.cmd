@echo off
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0prime-agent.ps1" %*
exit /b %ERRORLEVEL%
