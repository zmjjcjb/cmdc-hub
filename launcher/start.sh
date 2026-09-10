#!/usr/bin/env bash
# cmdc-hub 启动脚本 — 幂等，点击即拉起服务并打开 Dashboard
set -euo pipefail

# 用 cd 处理路径中的空格，避免 PM2/脚本参数解析踩坑
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
PROJECT_DIR="$( cd "$SCRIPT_DIR/.." && pwd )"
SERVER_FILE="$PROJECT_DIR/cmdc-server.mjs"
PM2="$HOME/.local/bin/pm2"
APP_NAME="cmdc-hub"
PORT=8888
MAX_WAIT=15  # 秒

check_port() {
    curl -s -o /dev/null -m 1 "http://127.0.0.1:$PORT/api/logs" && return 0
    return 1
}

wait_up() {
    local i=0
    while [ $i -lt $MAX_WAIT ]; do
        if check_port; then
            return 0
        fi
        sleep 0.5
        i=$((i + 1))
    done
    return 1
}

open_dashboard() {
    xdg-open "http://127.0.0.1:$PORT/" >/dev/null 2>&1 &
}

action="${1:-start}"

case "$action" in
    start|open)
        if check_port; then
            open_dashboard
            exit 0
        fi

        # 切换到项目目录再启动，规避路径中带空格的问题
        cd "$PROJECT_DIR"

        if [ -x "$PM2" ]; then
            # 用 --cwd 显式指定工作目录，避免空格拆分
            "$PM2" describe "$APP_NAME" >/dev/null 2>&1 && IS_REGISTERED=1 || IS_REGISTERED=0
            if [ "$IS_REGISTERED" = "1" ]; then
                "$PM2" restart "$APP_NAME" >/dev/null 2>&1 || true
            else
                "$PM2" start cmdc-server.mjs \
                    --name "$APP_NAME" \
                    --cwd "$PROJECT_DIR" \
                    --merge-logs \
                    --no-autorestart >/dev/null 2>&1
            fi
            "$PM2" save >/dev/null 2>&1 || true
        else
            node "$SERVER_FILE" >/dev/null 2>&1 &
        fi

        if wait_up; then
            open_dashboard
        else
            echo "服务启动超时，请检查日志" >&2
            exit 1
        fi
        ;;

    stop)
        if [ -x "$PM2" ]; then
            "$PM2" stop "$APP_NAME" >/dev/null 2>&1 || true
            "$PM2" save >/dev/null 2>&1 || true
        else
            pkill -f "cmdc-server.mjs" >/dev/null 2>&1 || true
        fi
        ;;

    restart)
        cd "$PROJECT_DIR"
        if [ -x "$PM2" ]; then
            "$PM2" describe "$APP_NAME" >/dev/null 2>&1 && \
                "$PM2" restart "$APP_NAME" >/dev/null 2>&1 || \
                "$PM2" start cmdc-server.mjs --name "$APP_NAME" --cwd "$PROJECT_DIR" --merge-logs --no-autorestart >/dev/null 2>&1
            "$PM2" save >/dev/null 2>&1 || true
        else
            pkill -f "cmdc-server.mjs" >/dev/null 2>&1 || true
            node "$SERVER_FILE" >/dev/null 2>&1 &
        fi
        wait_up && open_dashboard || true
        ;;

    *)
        echo "用法: $0 [start|stop|restart]"
        exit 1
        ;;
esac
