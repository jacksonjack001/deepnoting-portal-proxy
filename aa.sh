#!/usr/bin/env bash
set -euo pipefail

BASE_DIR="$(cd "$(dirname "$0")" && pwd)"
LOG_DIR="$BASE_DIR/.logs"
NODE_BIN="${NODE_BIN:-$(command -v node)}"

mkdir -p "$LOG_DIR"

case "${1:-help}" in
  ports)
    echo "Claude 代理：42069"
    echo "Codex 代理：8080"
    echo "状态 API：42124"
    ;;

  start-claude)
    pkill -f "$BASE_DIR/claude-code-proxy/server/server.js" 2>/dev/null || true
    cd "$BASE_DIR/claude-code-proxy"
    setsid -f bash -lc "cd '$BASE_DIR/claude-code-proxy' && exec '$NODE_BIN' server/server.js >>'$LOG_DIR/claude-code-proxy.log' 2>&1"
    echo "Claude 代理已启动：42069"
    ;;

  stop-claude)
    pkill -f "$BASE_DIR/claude-code-proxy/server/server.js" 2>/dev/null || true
    echo "Claude 代理已停止"
    ;;

  start-status)
    pkill -f "$BASE_DIR/ai-token-status-api.js" 2>/dev/null || true
    cd "$BASE_DIR"
    setsid -f bash -lc "cd '$BASE_DIR' && export CLAUDE_STATUS_BASE_URL='http://127.0.0.1:42069' CODEX_STATUS_BASE_URL='http://127.0.0.1:8080'; exec '$NODE_BIN' '$BASE_DIR/ai-token-status-api.js' >>'$LOG_DIR/ai-token-status-api.log' 2>&1"
    echo "状态 API 已启动：42124"
    ;;

  stop-status)
    pkill -f "$BASE_DIR/ai-token-status-api.js" 2>/dev/null || true
    echo "状态 API 已停止"
    ;;

  health)
    echo "Claude:"
    curl -sS http://127.0.0.1:42069/auth/status || true
    printf '\n---\n'
    echo "Status API:"
    curl -sS http://127.0.0.1:42124/health || true
    ;;

  logs)
    echo "Claude 日志：$LOG_DIR/claude-code-proxy.log"
    echo "状态 API 日志：$LOG_DIR/ai-token-status-api.log"
    ;;

  *)
    echo "用法: ./aa.sh {ports|start-claude|stop-claude|start-status|stop-status|health|logs}"
    ;;
esac
