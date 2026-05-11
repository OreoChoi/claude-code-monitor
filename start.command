#!/bin/bash
# Double-click to start Claude Code Monitor in the background.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
NODE_BIN="$(command -v node)"
[ -z "$NODE_BIN" ] && [ -x "$HOME/.nvm/versions/node/v22.22.1/bin/node" ] && NODE_BIN="$HOME/.nvm/versions/node/v22.22.1/bin/node"
SCRIPT="$SCRIPT_DIR/monitor.mjs"
LOG="/tmp/claude-code-monitor.log"

if [ -z "$NODE_BIN" ]; then
  echo "Node.js not found. Install Node 18+ first."
  read -n 1
  exit 1
fi

if pgrep -f "claude-code-monitor.*monitor.mjs" > /dev/null || pgrep -f "$SCRIPT" > /dev/null; then
  echo "Claude Code Monitor is already running."
else
  nohup "$NODE_BIN" "$SCRIPT" > "$LOG" 2>&1 &
  disown
  sleep 0.6
  echo "Claude Code Monitor started (PID $(pgrep -f "$SCRIPT"))"
fi

echo
echo "Open: http://localhost:7777"
echo "Log:  $LOG"
echo
echo "This window will close in 3 seconds…"
sleep 3
osascript -e 'tell application "Terminal" to close (every window whose name contains "start.command")' &
exit 0
