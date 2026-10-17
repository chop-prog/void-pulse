@echo off
rem Double-click to play: starts a tiny local server and opens the game in your browser.
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed. Get it from https://nodejs.org and run this file again.
  pause
  exit /b 1
)
node scripts\serve.js --open
pause
