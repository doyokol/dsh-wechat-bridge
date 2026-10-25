@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo 启动微信（自建通道副本 4.1.10.27，hook 端口 30002）...
start "" "%~dp0runtime\wechat-4.1.10.27\Weixin.exe" StartPort=30002
timeout /t 3 >nul
echo 微信已拉起。等登录后，桥接服务会自动连上 hook。
pause
