@echo off
chcp 65001 >nul
title AI vs 洛谷 - 本地运行
cd /d "%~dp0"

echo ============================================
echo   AI vs 洛谷 · 本地启动（Cloudflare Workers）
echo ============================================

where node >nul 2>nul
if errorlevel 1 (
  echo [错误] 未检测到 Node.js，请先安装 Node 18+：https://nodejs.org/
  pause
  exit /b 1
)

if not exist frontend\node_modules (
  echo [1/3] 首次运行：安装前端依赖（约 1-2 分钟）...
  call npm --prefix frontend install --no-fund --no-audit
)
if not exist node_modules\wrangler (
  echo [1/3] 首次运行：安装后端工具（约 1 分钟）...
  call npm install --no-fund --no-audit
)
if not exist frontend\dist\index.html (
  echo [2/3] 构建前端...
  call npm --prefix frontend run build
)

echo [3/3] 启动本地服务（http://127.0.0.1:8788）...
echo       首次使用：打开页面后点「登录 / 注册 → 初始化站长」创建站长账号。
echo       如需导入旧站数据：npm run seed
start "" cmd /c "timeout /t 14 /nobreak >nul && start http://127.0.0.1:8788/"
call node_modules\.bin\wrangler.cmd pages dev frontend/dist --port 8788
pause
