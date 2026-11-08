@echo off
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo 未检测到 Node.js，请先安装 https://nodejs.org/
  pause
  exit /b 1
)
if not exist "node_modules" (
  echo 首次运行，正在安装依赖...
  call npm install --no-audit --no-fund
)
start "" /min cmd /c "node scripts\launch.js"
