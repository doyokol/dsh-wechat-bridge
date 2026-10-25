@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo 启动自建微信通道（reader + bridge server）...
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start-services.ps1"
echo.
echo 已启动。健康检查：http://127.0.0.1:17890/health
echo 控制面板：DSH 设置 -> 微信桥接
pause
