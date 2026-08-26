@echo off
REM loopctl - Loop Runtime entry point (project root).
REM No runtime logic here: forward argv unchanged, propagate the exit code.
node "%~dp0tools\loop-runtime\loopctl.mjs" %*
exit /b %ERRORLEVEL%
