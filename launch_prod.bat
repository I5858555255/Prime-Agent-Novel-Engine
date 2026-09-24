@echo off
REM Novel Engine Production Launcher
REM Usage: launch_prod.bat [chapters] [start_from] [resume_checkpoint]
REM Example: launch_prod.bat 3800 1 0
REM          launch_prod.bat 0 1 1500  (resume from chapter 1500)
REM
REM API Key Setup:
REM   Primary:   LLM_API_KEY (SiliconFlow / DeepSeek-V3.2) - set via environment or .env
REM   Fallback:  AGNES_API_KEY (Agnes AI) - set via environment or .env
REM   Both are read from .env if present.

set PYTHONPATH=D:\AI\Prime-Agent-Novel-Engine\Prime-Agent-Novel-Engine\packages\coding-agent\skills\novel-engine\src
set NOVEL_ENGINE_REAL_LANG_ENFORCE=1

REM Load API keys from .env if available
if exist .env (
    for /F "usebackq tokens=1,2 delims==" %%a in (.env) do (
        if "%%a"=="LLM_API_KEY" set LLM_API_KEY=%%b
        if "%%a"=="AGNES_API_KEY" set AGNES_API_KEY=%%b
    )
)

set LOG_FILE=D:\AI\Prime-Agent-Novel-Engine\Prime-Agent-Novel-Engine\production_console.log

echo ============================================
echo Novel Engine Production Launcher
echo ============================================
echo Primary:   SiliconFlow (DeepSeek-V3.2)
echo Fallback:  Agnes AI (agnes-2.5-flash)
echo.

if "%~1"=="" (
    echo No chapter count specified. Starting full production (3800 chapters).
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

cd /d D:\AI\Prime-Agent-Novel-Engine\Prime-Agent-Novel-Engine\packages\coding-agent\skills\novel-engine\src\novel_engine\pipeline
python production_runner.py %CHAPTERS% --real %START_FROM% %RESUME% >> "%LOG_FILE%" 2>&1

echo.
echo Production finished. Check %LOG_FILE% for details.
pause
