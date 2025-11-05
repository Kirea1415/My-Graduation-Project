@echo off
REM SafeKeyS quick launcher for Windows
cd /d %~dp0

REM Install deps if node_modules missing
if not exist node_modules (
  echo Installing dependencies...
  cmd /c npm install
)

REM Start dev server in a new terminal window
start "SafeKeyS Server" cmd /k "npm run dev"

REM Small delay then open browser
timeout /t 3 >nul
start "" http://localhost:3000

echo SafeKeyS is launching. If the browser did not open, visit: http://localhost:3000
exit /b 0


