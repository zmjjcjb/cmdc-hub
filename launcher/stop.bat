@echo off
chcp 65001 >nul
setlocal

REM ============================================================
REM  停止 cmdc-hub 服务
REM ============================================================

where pm2 >nul 2>nul
if %errorlevel%==0 (
    pm2 stop cmdc-hub >nul 2>nul
    pm2 save >nul 2>nul
    echo 已通过 PM2 停止 cmdc-hub
) else (
    taskkill /F /IM node.exe /FI "WINDOWTITLE eq cmdc-server*" >nul 2>nul
    echo 已停止 node 进程
)

pause
