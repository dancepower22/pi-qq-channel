#!/bin/bash
# qq-bridge 起停脚本（幂等；用 PID 文件，不用 pkill 关键字）
cd "$(dirname "$0")"
PID=/tmp/qqbridge.pid
LOG=/tmp/qqbridge.out
case "$1" in
  start)
    if [ -f "$PID" ] && kill -0 "$(cat $PID)" 2>/dev/null; then echo "已在跑 PID $(cat $PID)"; exit 0; fi
    nohup node bridge.js "$@" > "$LOG" 2>&1 &
    echo $! > "$PID"; sleep 2
    echo "已启动 PID $(cat $PID) ｜ 日志 $LOG"
    ;;
  stop)
    [ -f "$PID" ] && kill "$(cat $PID)" 2>/dev/null && rm -f "$PID" && echo "已停" || echo "没在跑"
    ;;
  status)
    [ -f "$PID" ] && kill -0 "$(cat $PID)" 2>/dev/null && echo "运行中 PID $(cat $PID)" || echo "未运行"
    ;;
  log) tail -n 40 "$LOG" ;;
  *) echo "用法: ./run.sh {start|stop|status|log}"; exit 1;;
esac
