@echo off
setlocal

set "FOUND=0"
for /f "tokens=5" %%p in ('netstat -ano ^| findstr ":3000" ^| findstr "LISTENING"') do (
  set "FOUND=1"
  taskkill /PID %%p >nul 2>nul
  timeout /t 5 /nobreak >nul
  taskkill /PID %%p /F >nul 2>nul
  >nul 2>nul tasklist /FI "PID eq %%p" | findstr /R /C:" %%p " && (
    echo Failed to stop PID %%p.
  ) || (
    echo Stopped PID %%p.
  )
)

if "%FOUND%"=="0" echo No listener found on port 3000.

endlocal
