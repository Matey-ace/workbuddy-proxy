@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"

title WorkBuddy Proxy

echo.
echo  ============================================
echo    WorkBuddy 额度 -^> 通用 Agent API
echo  ============================================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo  [X] 未检测到 Node.js
  echo      请先安装: https://nodejs.org/
  echo.
  pause
  exit /b 1
)

if not exist "node_modules" (
  echo  [*] 首次运行，安装依赖...
  call npm install --no-audit --no-fund
  echo.
)

echo  [*] 正在启动服务...
echo.
node src\server.js

if errorlevel 1 (
  echo.
  echo  [X] 服务异常退出
  pause
)
