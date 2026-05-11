# claude-code-monitor

**English** | [한국어](./README.ko.md)

A tiny, local-only web UI that streams your active **Claude Code** CLI session in real time.

It tails the JSONL session files Claude Code already writes to
`~/.claude/projects/*/<session>.jsonl`, parses them, and pushes events to a
browser via Server-Sent Events. Nothing is sent to the network. No wrapping of
the Claude CLI — it just observes the local files.

![status](https://img.shields.io/badge/status-experimental-orange) ![license](https://img.shields.io/badge/license-MIT-blue) ![node](https://img.shields.io/badge/node-%E2%89%A518-brightgreen)

## Features

- **Multi-session tabs** — every Claude Code session active in the last 30 minutes gets its own tab. Click to switch, × to close. Independent card stream and counters per tab.
- **Skill calls expanded** — when Claude invokes a `Skill`, the loaded `SKILL.md` body is shown right below the tool call, fully rendered as markdown (tables, code blocks, lists).
- **"My context" sidebar** — shows what Claude is currently working with: project memory entries, loaded `CLAUDE.md` files, and which skills were invoked in this session.
- **Smart filters** — *All events*, *Skills + memory only*, *Conversation + Skills*, *Tools only*, *Conversation only*. Click any tool row in the sidebar to pin-filter to just that tool.
- **Turn dividers** — each user message starts a new visually separated turn (`── new turn ──`), so it's easy to see which question triggered which actions.
- **Markdown rendering** — Claude's text responses render as markdown (GFM-flavored tables, code blocks, lists, links, bold/italic). Zero-dependency parser inline in the script.
- **Color-coded tool calls** — Skill (purple), Bash (green), Read/Edit/Write (orange), WebSearch/WebFetch (cyan), Agent/Task (red).
- **Live token counters** — input / output / cache_read / cache_create accumulated per session.
- **Tool call frequency** — sidebar shows how many times each tool was called.
- **i18n** — Korean / English toggle in the top right (persisted in localStorage).
- **Zero dependencies** — single Node script, no `npm install` needed.

## Requirements

- macOS or Linux (the included `.command` launchers are macOS-only; the Node script itself runs anywhere)
- Node.js 18+
- Claude Code CLI installed (so that `~/.claude/projects/` exists)

## Install

```bash
git clone https://github.com/OreoChoi/claude-code-monitor.git ~/claude-code-monitor
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

### Option C — npx (no install)

```bash
npx -y github:OreoChoi/claude-code-monitor
```

## How it works

Claude Code persists every assistant message, tool call, tool result, and
usage metric as one JSON object per line in
`~/.claude/projects/<slugified-cwd>/<session-id>.jsonl`.

The monitor:

1. Scans `~/.claude/projects/` every 500 ms for any `.jsonl` modified within the last 30 minutes
2. Registers each active session as a tab and reads only the bytes appended since the last check
3. Broadcasts each new line to all connected browsers via SSE
4. The browser categorizes each line (user, assistant text, thinking, tool_use, tool_result, skill body) and renders it as a card

When the model invokes a `Skill`, the body that follows (delivered by Claude Code as a meta user message linked to the tool call by `sourceToolUseID`) is detected and rendered as a markdown card right below the tool call.

The "My context" panel is built at session-register time by reading
`~/.claude/CLAUDE.md`, the project's `CLAUDE.md`, and the project's `memory/MEMORY.md` index.

## Limitations

- Polls at 500 ms — events appear with up to ~1s delay
- Doesn't show token-by-token streaming; Claude Code writes completed messages
- Doesn't expose model internals (attention weights, redacted thinking is encrypted by Anthropic and unreadable). Only surface-level actions and any *plaintext* `thinking` blocks the model chose to emit.
- macOS-tested only; Linux works for the Node script but `.command` launchers won't

## Privacy

Everything is local. The server binds to `localhost:7777` only. No telemetry,
no remote calls, no analytics. The browser fetches from your own machine.

## License

MIT — see [LICENSE](./LICENSE).
