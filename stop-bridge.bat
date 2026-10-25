@echo off
chcp 65001 >nul
echo 停止自建通道（reader 17891 / bridge 17890）...
for /f "tokens=5" %%p in ('netstat -ano ^| findstr ":17890 :17891" ^| findstr "LISTENING"') do (
  echo 结束 PID %%p
  taskkill /PID %%p /F >nul 2>&1
)
echo 已停止（微信本体不动）。
timeout /t 2 >nul
