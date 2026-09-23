@echo off
cd /d "%~dp0.."
if not exist "logs" mkdir "logs"
echo [%date% %time%] starting server > logs\run-127-3000.log
D:\node.exe backend\server.js >> logs\run-127-3000.log 2>&1
echo [%date% %time%] server exited with code %errorlevel% >> logs\run-127-3000.log
pause
