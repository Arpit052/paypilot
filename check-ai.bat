@echo off
title PayPilot AI check
cd /d "%~dp0"
if not exist node_modules\express call npm install --omit=dev
node scripts\check-ai.js
pause
