@echo off
setlocal
cd /d "%~dp0"

set "NODE_EXE=%LOCALAPPDATA%\Programs\nodejs\node.exe"
if exist "%NODE_EXE%" goto run

set "NODE_EXE=C:\Program Files\nodejs\node.exe"
if exist "%NODE_EXE%" goto run

set "NODE_EXE=%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
if exist "%NODE_EXE%" goto run

echo Node.js was not found. Install Node.js 18 or newer, then run this file again.
exit /b 1

:run
"%NODE_EXE%" monitor.mjs >> "%~dp0.codex-monitor.log" 2>> "%~dp0.codex-monitor.err"
