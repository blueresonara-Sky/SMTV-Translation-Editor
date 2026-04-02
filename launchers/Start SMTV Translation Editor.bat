@echo off
setlocal

set "ROOT=%~dp0.."
cd /d "%ROOT%"

if not exist "node_modules" (
  echo Installing dependencies for the first run...
  call cmd /c npm install
  if errorlevel 1 (
    echo.
    echo Failed to install dependencies.
    pause
    exit /b 1
  )
)

echo Starting SMTV Translation Editor from source...
call cmd /c npm start

if errorlevel 1 (
  echo.
  echo The app did not start successfully.
  pause
  exit /b 1
)

endlocal
