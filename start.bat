@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"
echo ==============================================
echo   正在启动算法雷达站（关闭本窗口即停止服务）
echo ==============================================

set "PYCMD="
py -3 -c "pass" >nul 2>&1 && set "PYCMD=py -3"
if not defined PYCMD python -c "pass" >nul 2>&1 && set "PYCMD=python"
if not defined PYCMD goto :nopython

%PYCMD% server.py
if errorlevel 1 goto :fail
goto :eof

:fail
echo.
echo 启动失败：请确认已安装 Python 3.8+ 并加入 PATH。
echo 也可以手动运行：python "%~dp0server.py"
pause
exit /b 1

:nopython
echo.
echo [错误] 未找到 Python（已尝试 py -3 与 python）。
echo 请先安装 Python 3.8+ 并勾选"Add Python to PATH"，然后重新双击本文件。
pause
exit /b 1
