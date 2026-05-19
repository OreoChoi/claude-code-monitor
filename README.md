# claude-code-monitor

**English** | [한국어](./README.ko.md)

> A local web UI for **Claude Code**: observe any running session (by tailing JSONL) AND spawn new sessions with an attached in-browser terminal. Everything stays on `localhost`.

![hero](./docs/screenshots/hero.png)

![status](https://img.shields.io/badge/status-experimental-orange) ![license](https://img.shields.io/badge/license-MIT-blue) ![node](https://img.shields.io/badge/node-%E2%89%A518-brightgreen)

---

## ⚡ 30-second start

```bash
# 1. Clone
git clone https://github.com/OreoChoi/claude-code-monitor.git ~/claude-code-monitor

# 2. Run
node ~/claude-code-monitor/monitor.mjs

# 3. Open in your browser
open http://localhost:7777
```

No `npm install` needed. On macOS you can also double-click `start.command`.

---

## ✨ Features

- **Turn-grouped card stream** — every user message starts a turn. Click it to expand all tool calls, results, and assistant text for that turn in the right-side drawer.
- **Inline Skill bodies** — when Claude invokes a `Skill`, the loaded `SKILL.md` body renders as markdown right inside the tool card. Tables, code blocks, lists — all there.
- **"My context" sidebar** — what Claude is currently holding: project memory entries, loaded `CLAUDE.md` files, skills invoked in this session.
- **Multi-session tabs** — every Claude Code session active in the last 30 minutes gets its own tab. Independent stream and counters per tab.
- **5 smart filters** — All / Skills + memory / Conversation + Skills / Tools only / Conversation only. Click any tool row in the sidebar to pin-filter to just that tool.
- **Color-coded tool calls** — Skill (purple), Bash (green), Read/Edit/Write (orange), Web (cyan), Agent/Task (red).
- **Structured AskUserQuestion rendering** — when Claude presents choices, the call expands into per-question cards (header chip, options, descriptions) instead of a JSON blob. Options ending in `(Recommended)` get a purple border.
- **Live token counters** — input / output / cache_read / cache_create accumulated per session.
- **i18n** — Korean / English (toggle in settings, persisted in localStorage).
- **Zero dependencies** — single Node script using only standard modules.

---

## 🖼 Screens

| Skill body expanded | English UI |
|---|---|
| ![skill](./docs/screenshots/skill-expanded.png) | ![i18n](./docs/screenshots/i18n.png) |

More screens and how to use them → **[User Guide](./docs/GUIDE.md)**

---

## 📦 Install

Three options:

**A. Double-click (macOS)**
```bash
git clone https://github.com/OreoChoi/claude-code-monitor.git ~/claude-code-monitor
chmod +x ~/claude-code-monitor/*.command
# Double-click start.command in Finder
```

**B. Terminal**
```bash
node ~/claude-code-monitor/monitor.mjs
# Ctrl-C to stop
```

**C. npx (no install)**
```bash
npx -y github:OreoChoi/claude-code-monitor
```

Then open <http://localhost:7777> and use Claude Code normally — events stream in.

---

## 🧠 How it works

Claude Code persists every assistant message, tool call, tool result, and token usage as one JSON object per line in `~/.claude/projects/<slugified-cwd>/<session-id>.jsonl`. This tool:

1. Scans that directory every 500 ms for any `.jsonl` modified within the last 30 minutes
2. Registers each active session as a tab and reads only the bytes appended since the last check
3. Broadcasts each new line to all connected browsers via SSE
4. The browser categorizes each line and renders it as a card

Full mechanics, troubleshooting, and FAQ → [GUIDE.md](./docs/GUIDE.md).

---

## 🔒 Privacy

Everything is local. The server binds to `localhost:7777` only. No telemetry, no remote calls, no analytics.

## 📋 Requirements

- Node.js 18+
- macOS or Linux (`.command` launchers are macOS-only)
- Claude Code CLI installed (so that `~/.claude/projects/` exists)

## 📝 License

MIT — see [LICENSE](./LICENSE).
