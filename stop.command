#!/bin/bash
# Double-click to stop Claude Code Monitor.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SCRIPT="$SCRIPT_DIR/monitor.mjs"

if pgrep -f "$SCRIPT" > /dev/null; then
  pkill -f "$SCRIPT"
  echo "Stopped."
else
  # also try legacy path
  if pgrep -f "claude-monitor.mjs" > /dev/null; then
    pkill -f "claude-monitor.mjs"
    echo "Stopped (legacy)."
  else
    echo "Not running."
  fi
fi

sleep 2
osascript -e 'tell application "Terminal" to close (every window whose name contains "stop.command")' &
exit 0
