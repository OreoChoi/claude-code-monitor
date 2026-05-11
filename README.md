# claude-code-monitor

A tiny, local-only web UI that streams your active **Claude Code** CLI session in real time.

It tails the JSONL session files Claude Code already writes to
`~/.claude/projects/*/<session>.jsonl`, parses them, and pushes events to a
browser via Server-Sent Events. Nothing is sent to the network. No wrapping of
the Claude CLI — it just observes the local files.

![status](https://img.shields.io/badge/status-experimental-orange) ![license](https://img.shields.io/badge/license-MIT-blue)

## Features

- **Auto-detects the active session** — watches `~/.claude/projects/` and follows whichever session was modified most recently. Switch projects without restarting.
- **Color-coded tool calls** — Skill (purple), Bash (green), Read/Edit/Write (orange), WebSearch/WebFetch (cyan), Agent/Task (red), thinking (yellow).
- **Live token counters** — input / output / cache_read / cache_create accumulated per session.
- **Tool call frequency** — sidebar shows how many times each tool was called.
- **Zero dependencies** — single Node script (~200 lines), no `npm install` needed.

## Requirements

- macOS (the included `.command` launchers are macOS-specific; the Node script itself runs anywhere)
- Node.js 18+
- Claude Code CLI installed (so that `~/.claude/projects/` exists)

## Install

```bash
git clone https://github.com/<your-user>/claude-code-monitor.git ~/claude-code-monitor
chmod +x ~/claude-code-monitor/*.command
```

## Usage

### Option A — double-click (macOS)

1. Open `~/claude-code-monitor/` in Finder
2. Double-click **`start.command`** to launch the monitor in the background
3. Open <http://localhost:7777> in your browser
4. Use Claude Code normally — events stream into the page
5. Double-click **`stop.command`** to shut down

### Option B — terminal

```bash
node ~/claude-code-monitor/monitor.mjs
# then open http://localhost:7777
```

Use `Ctrl-C` to stop.

## How it works

Claude Code persists every assistant message, tool call, tool result, and
usage metric as one JSON object per line in
`~/.claude/projects/<slugified-cwd>/<session-id>.jsonl`.

The monitor:

1. Scans `~/.claude/projects/` every 500 ms for the most-recently-modified `.jsonl`
2. Reads only the bytes appended since the last check (cheap)
3. Broadcasts each new line to all connected browsers via SSE
4. The browser script categorizes each line and renders it as a card

If a newer session appears (you started Claude Code in a different project),
the monitor switches over and the page resets automatically.

## Limitations

- Polls at 500 ms — events appear with up to ~1s delay
- Doesn't show token-by-token streaming; Claude Code writes completed messages
- Doesn't expose model internals (attention weights, hidden reasoning) — only
  surface-level actions and any `thinking` blocks the model chose to emit
- macOS-tested only; Linux works for the Node script but `.command` launchers won't

## Privacy

Everything is local. The server binds to `localhost:7777` only. No telemetry,
no remote calls, no analytics.

## License

MIT
