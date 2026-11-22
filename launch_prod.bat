@echo off
REM Novel Engine Production Launcher (portable: all paths relative to this script's dir)
REM Usage: launch_prod.bat [chapters] [start_from] [resume_checkpoint]
REM Example: launch_prod.bat 3800 1 0
REM          launch_prod.bat 0 1 1500  (resume from chapter 1500)
REM
REM API Key Setup:
REM   Keys are read from %~dp0.env if present (3 var names injected below).
REM   See .env.example at repo root for the variable list and load-chain notes.

set "PYTHONPATH=%~dp0packages\coding-agent\skills\novel-engine\src"
set NOVEL_ENGINE_REAL_LANG_ENFORCE=1

REM Load API keys from repo-root .env if available
if exist "%~dp0.env" (
    for /F "usebackq tokens=1,2 delims==" %%a in ("%~dp0.env") do (
        if "%%a"=="LLM_API_KEY" set "LLM_API_KEY=%%b"
        if "%%a"=="AGNES_API_KEY" set "AGNES_API_KEY=%%b"
        if "%%a"=="AGNES_TOKEN_API_KEY" set "AGNES_TOKEN_API_KEY=%%b"
    )
)

set "LOG_FILE=%~dp0production_console.log"

echo ============================================
echo Novel Engine Production Launcher
echo ============================================
echo Primary:   SiliconFlow (DeepSeek-V3.2)
echo Fallback:  Agnes AI (agnes-2.5-flash)
echo.

if "%~1"=="" (
    echo No chapter count specified. Starting full production ^(3800 chapters^).
    set CHAPTERS=3800
) else (
    set CHAPTERS=%~1
)

if "%~2"=="" (
    set START_FROM=1
) else (
    set START_FROM=%~2
)

if "%~3"=="" (
    set RESUME=0
) else (
    set RESUME=%~3
)

echo Chapters: %CHAPTERS%
echo Start from: %START_FROM%
echo Resume from: %RESUME%
echo Log: %LOG_FILE%
echo.

cd /d "%~dp0packages\coding-agent\skills\novel-engine\src\novel_engine\pipeline"
python production_runner.py %CHAPTERS% --real %START_FROM% %RESUME% >> "%LOG_FILE%" 2>&1

echo.
echo Production finished. Check %LOG_FILE% for details.
pause
