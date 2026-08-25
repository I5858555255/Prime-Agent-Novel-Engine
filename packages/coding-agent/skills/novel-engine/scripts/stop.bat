@echo off

setlocal enabledelayedexpansion

set SCRIPT_DIR=%~dp0
set PROJECT=%SCRIPT_DIR%..
set PID_FILE=%PROJECT%src\novel_engine\runtime\dashboard.pid

if not exist "%PID_FILE%" (
    echo [INFO] No dashboard process found
    pause
    exit /b 0
)

for /f "tokens=*" %%p in (^"type "%PID_FILE%"^") do set PID=%%p

tasklist /fi "pid eq %%PID%%" 2>nul | findstr /i python.exe >nul
if not errorlevel 1 (
    echo [INFO] Stopping dashboard (PID: %%PID%%)...
    taskkill /pid %%PID%% /f >nul 2>&1
    if errorlevel 1 (
        echo [WARN] Process may have already exited
    ) else (
        echo [OK] Dashboard stopped
    )
    del "%PID_FILE%" >nul 2>&1
) else (
    echo [INFO] Dashboard not running
    del "%PID_FILE%" >nul 2>&1
)

if "%~1"==all (
    echo [INFO] Stopping all Python processes...
    taskkill /f /im python.exe >nul 2>&1
)

pause