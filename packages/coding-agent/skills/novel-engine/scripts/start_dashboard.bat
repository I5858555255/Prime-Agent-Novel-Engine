@echo off
setlocal enabledelayedexpansion

set SCRIPT_DIR=%~dp0
set PYTHON=D:\Program Files\Python312\python.exe
set SRC=%SCRIPT_DIR%..\src

if not exist "%PYTHON%" (
    echo [ERROR] Python not found
    pause
    exit /b 1
)

if not exist "%SRC%\novel_engine\pipeline\web_dashboard.py" (
    echo [ERROR] Dashboard script not found
    echo [INFO] Looking for: %SRC%\novel_engine\pipeline\web_dashboard.py
    pause
    exit /b 1
)

echo ============================================================
echo   Novel-Engine Web Dashboard
echo ============================================================
echo.
echo [INFO] Starting dashboard...
echo [INFO] Script: %SRC%\novel_engine\pipeline\web_dashboard.py
echo [INFO] Python: %PYTHON%
echo.
pushd "%SRC%"
start "Dashboard" "%PYTHON%" -m novel_engine.pipeline.web_dashboard --port 8080
popd
echo [OK] Dashboard started
echo.
echo   Access: http://localhost:8080
echo.
timeout /t 2 /nobreak >nul
start "" "http://localhost:8080"

pause