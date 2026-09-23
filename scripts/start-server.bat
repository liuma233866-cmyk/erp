@echo off
setlocal

set "ROOT=%~dp0.."
for /f "tokens=5" %%p in ('netstat -ano ^| findstr ":3000" ^| findstr "LISTENING"') do (
  echo Server already running with PID %%p.
  exit /b 0
)

start "ERP Server" cmd /k "cd /d %ROOT% && node backend\server.js"
echo Server launch requested. Keep the opened ERP Server window running.

endlocal
