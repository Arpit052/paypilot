@echo off
title PayPilot
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo  Node.js nahi mila. Pehle https://nodejs.org se LTS version install karo,
  echo  phir is file ko dobara double-click karo.
  echo.
  pause
  exit /b
)
taskkill /F /IM node.exe >nul 2>nul
if not exist data\db.json node scripts\seed.js
echo.
echo  PayPilot start ho raha hai... browser apne aap khul jayega.
echo  Band karne ke liye yeh window close kar do.
echo.
start "" cmd /c "timeout /t 2 >nul & start http://localhost:3000"
node server.js
pause
