@echo off
title PayPilot
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo  Node.js was not found. Install the LTS version from https://nodejs.org
  echo  and then double-click this file again.
  echo.
  pause
  exit /b
)
taskkill /F /IM node.exe >nul 2>nul
if not exist node_modules\express (
  echo  First run: installing required packages...
  call npm install --omit=dev
)
if not exist data\paypilot.db node scripts\seed.js
echo.
echo  Starting PayPilot... your browser will open automatically.
echo  Close this window to stop the app.
echo.
start "" cmd /c "timeout /t 2 >nul & start http://localhost:3000"
node server.js
pause
