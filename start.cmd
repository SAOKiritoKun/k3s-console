@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [错误] 未找到 Node.js，请先安装 Node.js 18 或更高版本：https://nodejs.org/
  pause
  exit /b 1
)

if not exist "node_modules\ssh2" (
  echo [信息] 首次运行，正在安装依赖 ssh2 ...
  call npm install --no-audit --no-fund
  if errorlevel 1 (
    echo [错误] 依赖安装失败，请检查网络或手动执行 npm install
    pause
    exit /b 1
  )
)

echo [信息] 正在启动 k3s 集群管家 ...
node app\server.js
pause
