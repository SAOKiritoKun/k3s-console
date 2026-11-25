#!/usr/bin/env sh
set -e
cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo "[错误] 未找到 Node.js，请先安装 Node.js 18 或更高版本：https://nodejs.org/" >&2
  exit 1
fi

if [ ! -d node_modules/ssh2 ]; then
  echo "[信息] 首次运行，正在安装依赖 ssh2 ..."
  npm install --no-audit --no-fund
fi

echo "[信息] 正在启动 k3s 集群管家 ..."
exec node app/server.js
