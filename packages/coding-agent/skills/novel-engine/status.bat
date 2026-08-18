@echo off
setlocal enabledelayedexpansion

set SCRIPT_DIR=%~dp0
set PYTHON=D:\Program Files\Python312\python.exe
set PROJECT=%SCRIPT_DIR%
set SRC=%PROJECT%src\novel_engine

if "%~1"==chapters (
    echo [Generated Chapters]
    if exist "%SRC%\chapters\novel" (
        dir /b "%SRC%\chapters\novel\*.txt" 2>nul | sort
    ) else (
        echo (No chapters generated yet)
    )
    pause
    exit /b 0
)

if "%~1"==clean (
    echo [Clean] Removing runtime data...
    if exist "%SRC%\runtime" del "%SRC%\runtime\*.json" 2>nul
    if exist "%SRC%\chapters" (
        rmdir "%SRC%\chapters\novel" /s /q 2>nul
        rmdir "%SRC%\chapters\synopsis" /s /q 2>nul
        rmdir "%SRC%\chapters\outline" /s /q 2>nul
    )
    echo [OK] Runtime data cleaned
    pause
    exit /b 0
)

cls
echo ============================================================
echo   Novel-Engine Status
echo ============================================================
echo.
echo [Generated Chapters]
if exist "%SRC%\chapters\novel" (
    dir /b "%SRC%\chapters\novel\*.txt" 2>nul | sort
) else (
    echo  (None)
)
echo.
echo [Commands]
echo   generate.bat              - Run generation
echo   start_dashboard.bat       - Start web dashboard
echo   status.bat chapters       - List chapters
echo   status.bat clean          - Clean runtime data
echo.
pause
