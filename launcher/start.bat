@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion

REM ============================================================
REM  cmdc-hub 启动脚本 (Windows)
REM  点击即拉起服务并打开 Dashboard，幂等（已运行则只打开面板）
REM ============================================================

REM 切换到脚本所在目录
cd /d "%~dp0"
cd ..

set "SERVER_FILE=%cd%\cmdc-server.mjs"
set "PORT=8888"
set "MAX_WAIT=15"

REM 检查服务是否已在运行
curl -s -o nul -m 1 "http://127.0.0.1:%PORT%/api/logs"
if %errorlevel%==0 (
    REM 已运行，直接打开面板
    start "" "http://127.0.0.1:%PORT%/"
    exit /b 0
)

REM 优先用 PM2，没有就直接 node 后台跑
where pm2 >nul 2>nul
if %errorlevel%==0 (
    pm2 describe cmdc-hub >nul 2>nul
    if %errorlevel%==0 (
        pm2 restart cmdc-hub >nul
    ) else (
        pm2 start "%SERVER_FILE%" --name cmdc-hub --merge-logs --no-autorestart >nul
    )
    pm2 save >nul 2>nul
) else (
    REM 用 start /B 后台运行 node
    start /B node "%SERVER_FILE%" >nul 2>nul
)

REM 等待服务启动
set "waited=0"
:wait_loop
curl -s -o nul -m 1 "http://127.0.0.1:%PORT%/api/logs"
if %errorlevel%==0 goto :ready
timeout /t 1 /nobreak >nul
set /a waited+=1
if %waited% lss %MAX_WAIT% goto :wait_loop

echo 服务启动超时，请检查日志
exit /b 1

:ready
start "" "http://127.0.0.1:%PORT%/"
exit /b 0
