@echo off
setlocal enabledelayedexpansion

set SCRIPT_DIR=%~dp0
set PYTHON=D:\Program Files\Python312\python.exe
set POETRY=D:\Program Files\Python312\Scripts\poetry.exe
set PROJECT=%SCRIPT_DIR%
set SRC=%PROJECT%src\novel_engine

if not exist "%PYTHON%" (
    echo [ERROR] Python not found: %PYTHON%
    pause
    exit /b 1
)

if not exist "%SRC%" (
    echo [ERROR] Source dir not found: %SRC%
    pause
    exit /b 1
)

echo ============================================================
echo   Novel-Engine Generator
echo ============================================================
echo.

if not exist "%PROJECT%\.venv" (
    echo [INFO] Installing dependencies...
    pushd "%PROJECT%"
    "%POETRY%" install
    popd
)

set MODE=mock
set SCRIPT=mini_test_runner.py
if /i "%~1"==real set MODE=real
if /i "%~1"==production set SCRIPT=production_runner.py

if "%MODE%"==real (
    echo [INFO] Mode: Real API
    pushd "%SRC%"
    "%POETRY%" run python %SCRIPT% --real
) else (
    echo [INFO] Mode: Mock
    pushd "%SRC%"
    "%POETRY%" run python %SCRIPT%
)
popd

if errorlevel 1 (
    echo [WARN] Generation completed with errors
) else (
    echo [OK] Generation completed successfully
)

echo.
echo [Output] %SRC%\chapters\novel\

if "%MODE%"==real (
    choice /C YN /M "Open Web Dashboard"
    if not errorlevel 2 start "" "%PROJECT%start_dashboard.bat"
)

pause
