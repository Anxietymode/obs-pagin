@echo off
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js not found. Install LTS from https://nodejs.org and reopen this file.
  pause
  exit /b 1
)

if not exist node_modules\ws (
  echo Installing dependency ws...
  call npm install --no-audit --no-fund
)

:menu
echo.
echo === obs-tuner ===
echo 1) Full check and plan
echo 2) Doctor only
echo 3) Write OBS profile
echo 4) Apply filters to running OBS
echo 5) Check last OBS log
echo 6) Exit
echo.
set /p choice=Choose 1-6:

if "%choice%"=="1" goto run_all
if "%choice%"=="2" goto run_doctor
if "%choice%"=="3" goto run_profile
if "%choice%"=="4" goto run_filters
if "%choice%"=="5" goto run_check
if "%choice%"=="6" exit /b 0
echo Unknown choice.
goto menu

:run_all
node src\cli.js all
goto done

:run_doctor
node src\cli.js doctor
goto done

:run_profile
node src\cli.js profile --apply
goto done

:run_filters
set /p target=Scene name (default "Scene"): 
if "%target%"=="" set target=Scene
node src\cli.js filters --apply --target "%target%"
goto done

:run_check
node src\cli.js check
goto done

:done
echo.
pause
goto menu
