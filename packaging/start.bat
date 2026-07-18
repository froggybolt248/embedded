@echo off
rem Portable-bundle launcher: sits next to node\ and apps\server\dist\ in the unzipped bundle.
cd /d "%~dp0"
set EMBEDDED_PORT=4517
set EMBEDDED_SEEDS_DIR=%~dp0seeds
start "" cmd /c "timeout /t 2 /nobreak >nul & start http://127.0.0.1:4517"
"%~dp0node\node.exe" "%~dp0apps\server\dist\main.js"
pause
