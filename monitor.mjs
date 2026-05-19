#!/usr/bin/env node
// Claude Code Session Monitor
// Watches ~/.claude/projects/*/<session>.jsonl, streams to http://localhost:7777

import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const execFileP = promisify(execFile);
// node-pty is loaded on first PTY spawn so observation-only deployments
// (or environments lacking a native build) keep working.
let nodePtyPromise = null;
async function getNodePty() {
  if (!nodePtyPromise) {
    nodePtyPromise = import('node-pty').then((m) => m.default || m);
  }
  return nodePtyPromise;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = 7777;
const ROOT = process.env.CC_MONITOR_PROJECTS_DIR || path.join(os.homedir(), '.claude', 'projects');

if (!fs.existsSync(ROOT)) {
  console.error(`Not found: ${ROOT}`);
  process.exit(1);
}

const clients = new Set();
const send = (line) => { for (const r of clients) r.write(`data: ${line}\n\n`); };
const sendTo = (res, line) => res.write(`data: ${line}\n\n`);

let activeMs = 30 * 60 * 1000;             // session activity window, configurable via /config
const ACTIVE_MS_MIN = 60 * 1000;           // 1 min lower bound
const ACTIVE_MS_MAX = 24 * 60 * 60 * 1000; // 24 h upper bound
const TAIL_LINES = 50;
const watched = new Map();                 // sessionId -> { path, project, lastSize, lastMtime }

function sendSessionMeta(target, session, project, path, mtime) {
  let cwd = '';
  try { cwd = getCwdCached(path, mtime); } catch {}
  const meta = JSON.stringify({ __monitor: 'session', session, project, path, mtime, cwd });
  if (target) sendTo(target, meta);
  else send(meta);
}

function readMemoryIndex(memoryDir) {
  const indexPath = path.join(memoryDir, 'MEMORY.md');
  try {
    const text = fs.readFileSync(indexPath, 'utf-8');
    const items = [];
    for (const line of text.split('\n')) {
      const m = line.match(/^\s*-\s*\[([^\]]+)\]\(([^)]+)\)(?:\s*[—-]\s*(.*))?/);
      if (m) items.push({ title: m[1], file: m[2], desc: (m[3] || '').trim() });
    }
    return items;
  } catch { return []; }
}

function fileExists(p) { try { fs.accessSync(p); return true; } catch { return false; } }

function cwdFromJsonl(jsonlPath) {
  try {
    const lines = fs.readFileSync(jsonlPath, 'utf-8').split('\n');
    // Scan up to first 500 lines — metadata-only events at the head may push
    // the first message-bearing event (with `cwd`) past line 5.
    const max = Math.min(lines.length, 500);
    for (let i = 0; i < max; i++) {
      const ln = lines[i];
      if (!ln) continue;
      try { const j = JSON.parse(ln); if (j.cwd) return j.cwd; } catch {}
    }
  } catch {}
  return null;
}

function buildInventory(project, jsonlPath) {
  const homedir = process.env.HOME || '';
  const memoryDir = path.join(ROOT, project, 'memory');
  const memoryItems = readMemoryIndex(memoryDir);
  const claudeMd = [];
  const userCm = path.join(homedir, '.claude', 'CLAUDE.md');
  if (fileExists(userCm)) claudeMd.push({ scope: 'user', path: userCm });
  const cwd = cwdFromJsonl(jsonlPath);
  if (cwd) {
    const projCm = path.join(cwd, 'CLAUDE.md');
    if (fileExists(projCm)) claudeMd.push({ scope: 'project', path: projCm });
    const dotCm = path.join(cwd, '.claude', 'CLAUDE.md');
    if (fileExists(dotCm)) claudeMd.push({ scope: 'project-local', path: dotCm });
  }
  return { memoryItems, claudeMd, cwd };
}

function sendInventory(target, session, project, jsonlPath) {
  const inv = buildInventory(project, jsonlPath);
  const meta = JSON.stringify({ __monitor: 'inventory', session, ...inv });
  if (target) sendTo(target, meta);
  else send(meta);
}

function tailLines(fp, n) {
  try {
    const content = fs.readFileSync(fp, 'utf-8');
    return content.trim().split('\n').slice(-n).filter(Boolean);
  } catch { return []; }
}

function sendInitialState(res) {
  for (const [sid, w] of watched) {
    sendSessionMeta(res, sid, w.project, w.path, w.lastMtime);
    sendInventory(res, sid, w.project, w.path);
  }
}

const lineCountCache = new Map(); // path -> { mtime, lines }
function countLines(fp, mtime) {
  const cached = lineCountCache.get(fp);
  if (cached && cached.mtime === mtime) return cached.lines;
  try {
    const buf = fs.readFileSync(fp);
    let n = 0;
    for (let i = 0; i < buf.length; i++) if (buf[i] === 10) n++;
    lineCountCache.set(fp, { mtime, lines: n });
    return n;
  } catch { return 0; }
}

const cwdCache = new Map(); // path -> { mtime, cwd }
function getCwdCached(fp, mtime) {
  const cached = cwdCache.get(fp);
  if (cached && cached.mtime === mtime) return cached.cwd;
  const cwd = cwdFromJsonl(fp) || '';
  cwdCache.set(fp, { mtime, cwd });
  return cwd;
}

function listAllSessions() {
  const acc = [];
  for (const proj of fs.readdirSync(ROOT)) {
    const dir = path.join(ROOT, proj);
    let st; try { st = fs.statSync(dir); } catch { continue; }
    if (!st.isDirectory()) continue;
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.jsonl')) continue;
      const fp = path.join(dir, f);
      try {
        const s = fs.statSync(fp);
        acc.push({
          path: fp,
          project: proj,
          session: f.replace('.jsonl', ''),
          mtime: s.mtimeMs,
          size: s.size,
          lines: countLines(fp, s.mtimeMs),
          cwd: getCwdCached(fp, s.mtimeMs),
        });
      } catch {}
    }
  }
  acc.sort((a, b) => b.mtime - a.mtime);
  return acc;
}

function findActiveSessions() {
  const cutoff = Date.now() - activeMs;
  return listAllSessions().filter((s) => s.mtime >= cutoff);
}

function readRange(fp, start, end) {
  return new Promise((resolve) => {
    const stream = fs.createReadStream(fp, { start, end });
    let buf = '';
    stream.on('data', (c) => (buf += c));
    stream.on('end', () => resolve(buf));
    stream.on('error', () => resolve(''));
  });
}

async function poll() {
  const cutoff = Date.now() - activeMs;
  // 0. expire sessions whose mtime is now older than the active window
  for (const [sid, w] of [...watched]) {
    if (w.lastMtime < cutoff) {
      watched.delete(sid);
      for (const c of clients) sendTo(c, JSON.stringify({ __monitor: 'session-removed', session: sid }));
    }
  }
  const active = findActiveSessions();
  // 1. register new sessions (lazy: only meta + inventory, no tail content)
  for (const a of active) {
    if (!watched.has(a.session)) {
      const initialSize = (() => { try { return fs.statSync(a.path).size; } catch { return 0; } })();
      watched.set(a.session, { path: a.path, project: a.project, lastSize: initialSize, lastMtime: a.mtime });
      sendSessionMeta(null, a.session, a.project, a.path, a.mtime);
      sendInventory(null, a.session, a.project, a.path);
    }
  }
  // 2. check for new content in already-watched sessions
  for (const [sid, w] of watched) {
    try {
      const stat = fs.statSync(w.path);
      const size = stat.size;
      if (size < w.lastSize) w.lastSize = 0;
      if (size > w.lastSize) {
        const chunk = await readRange(w.path, w.lastSize, size);
        w.lastSize = size;
        w.lastMtime = stat.mtimeMs;
        chunk.split('\n').filter(Boolean).forEach(send);
      }
    } catch {}
  }
}

setInterval(poll, 500);
poll();

const HTML = String.raw`<!doctype html>
<html><head><meta charset="utf-8"><title>Claude Monitor</title>
<link rel="stylesheet" href="/assets/xterm.css">
<script>try{document.documentElement.classList.toggle('light',localStorage.getItem('cm-theme')==='light');if(localStorage.getItem('cm-side-open')==='false')document.documentElement.classList.add('side-closed')}catch{}</script>
<style>
  * { box-sizing: border-box; }
  ::-webkit-scrollbar { width: 10px; height: 10px; }
  ::-webkit-scrollbar-track { background: transparent; }
  ::-webkit-scrollbar-thumb { background: var(--color-border); border-radius: var(--radius-full); border: 2px solid transparent; background-clip: padding-box; }
  ::-webkit-scrollbar-thumb:hover { background: var(--color-border-strong); background-clip: padding-box; border: 2px solid transparent; }
  ::-webkit-scrollbar-corner { background: transparent; }
  * { scrollbar-width: thin; scrollbar-color: var(--color-border) transparent; }
  ::selection { background: var(--color-accent-subtle); color: var(--color-text); }
  :root {
    /* === Linear-inspired Design Tokens — Color (dark) === */
    --color-bg:            #08090A;
    --color-surface-1:     #101113;
    --color-surface-2:     #1A1B1E;
    --color-surface-3:     #222326;
    --color-surface-hover: #1F2023;
    --color-surface-active:#26272B;
    --color-border-subtle: #1F2023;
    --color-border:        #2A2B2F;
    --color-border-strong: #3A3B40;
    --color-text:          #F7F8F8;
    --color-text-secondary:#B4B8BD;
    --color-text-tertiary: #8A8F98;
    --color-text-disabled: #5C5F66;
    --color-text-on-accent:#FFFFFF;
    --color-accent:        #5E6AD2;
    --color-accent-hover:  #6F7BDB;
    --color-accent-active: #4C58C0;
    --color-accent-subtle: rgba(94,106,210,0.16);
    --color-accent-ring:   rgba(94,106,210,0.40);
    --color-success:        #4CB782;
    --color-success-subtle: rgba(76,183,130,0.14);
    --color-warning:        #F2C94C;
    --color-warning-subtle: rgba(242,201,76,0.14);
    --color-danger:         #EB5757;
    --color-danger-subtle:  rgba(235,87,87,0.14);
    --color-info:           #5E9EFF;
    --color-info-subtle:    rgba(94,158,255,0.14);

    /* === Spacing === */
    --space-1: 4px;
    --space-2: 8px;
    --space-3: 12px;
    --space-4: 16px;
    --space-5: 20px;
    --space-6: 24px;
    --space-7: 32px;
    --space-8: 40px;

    /* === Radius === */
    --radius-sm:   4px;
    --radius-md:   6px;
    --radius-lg:   8px;
    --radius-xl:   12px;
    --radius-full: 9999px;

    /* === Shadow === */
    --shadow-sm: 0 1px 2px rgba(0,0,0,0.30);
    --shadow-md: 0 4px 10px rgba(0,0,0,0.35), 0 1px 2px rgba(0,0,0,0.30);
    --shadow-lg: 0 10px 24px rgba(0,0,0,0.45), 0 2px 6px rgba(0,0,0,0.30);
    --shadow-xl: 0 24px 48px rgba(0,0,0,0.55), 0 4px 10px rgba(0,0,0,0.40);
    --shadow-focus: 0 0 0 3px var(--color-accent-ring);

    /* === Typography === */
    --font-sans: "Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
    --font-mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace;
    --font-size-xs:   12px;
    --font-size-sm:   13px;
    --font-size-base: 14px;
    --font-size-md:   15px;
    --font-size-lg:   17px;
    --font-size-xl:   20px;
    --font-size-2xl:  24px;
    --font-weight-regular: 400;
    --font-weight-medium:  510;
    --font-weight-semibold:590;
    --font-weight-bold:    700;
    --line-height-tight:  1.2;
    --line-height-base:   1.4;
    --letter-spacing-tight: -0.012em;

    /* === Z-index === */
    --z-sticky:   100;
    --z-dropdown: 1000;
    --z-drawer:   1100;
    --z-modal:    1200;

    /* === Motion === */
    --duration-fast:  120ms;
    --duration-base:  180ms;
    --duration-slow:  260ms;
    --ease-out:       cubic-bezier(0.22, 1, 0.36, 1);

    /* === Legacy aliases (mapped to new tokens) === */
    --bg: var(--color-bg);
    --bg-elev: var(--color-surface-1);
    --bg-side: var(--color-surface-1);
    --bg-card: var(--color-surface-2);
    --bg-card-result: var(--color-surface-1);
    --bg-control: var(--color-surface-2);
    --bg-control-hover: var(--color-surface-3);
    --bg-control-active: var(--color-surface-active);
    --bg-tab-hover: var(--color-surface-hover);
    --bg-row-hover: var(--color-surface-hover);
    --bg-row-active: var(--color-accent-subtle);
    --bg-tab-close-hover: rgba(235,87,87,0.16);
    --bg-code: var(--color-surface-1);
    --bg-inline-code: var(--color-surface-3);
    --bg-table-head: var(--color-surface-3);
    --bg-table-cell: var(--color-surface-2);
    --bg-card-user: #1e3654;
    --bg-card-text: #2c2c30;
    --bg-card-thinking: #3a2e17;
    --bg-card-skill: #261b33;
    --bg-card-skill-result: #1f1729;
    --bg-card-agent: #2d1d1d;
    --bg-card-bash: #1d2a1d;
    --bg-card-fileops: #2d241a;
    --bg-card-web: #1a2828;
    --text: var(--color-text);
    --text-strong: #FFFFFF;
    --text-h1: var(--color-text);
    --text-muted: var(--color-text-secondary);
    --text-dim: var(--color-text-tertiary);
    --text-dimmer: var(--color-text-disabled);
    --text-faint: #3D404A;
    --text-ctx: var(--color-text-secondary);
    --text-tool-pre: #A8D88F;
    --text-md-inline: #F2A672;
    --text-summary: var(--color-text);
    --text-tag: var(--color-text-tertiary);
    --text-toggle: var(--color-text-tertiary);
    --text-truncated: var(--color-text-tertiary);
    --text-tab: var(--color-text-secondary);
    --text-tab-active-count: var(--color-accent);
    --border: var(--color-border-subtle);
    --border-strong: var(--color-border);
    --border-card-default: var(--color-border);
    --border-table: var(--color-border);
    --accent-blue: var(--color-accent);
    --accent-blue-light: var(--color-accent-hover);
    --accent-green: var(--color-success);
    --accent-red: var(--color-danger);
    --accent-purple: #B07FE8;
    --accent-purple-light: #D9B8FF;
    --accent-orange: var(--color-warning);
    --accent-yellow: #FFD56E;
    --accent-cyan: #6DDDDD;
    --md-h2: #B8C5FF;
    --md-h3: #9EB0FF;
    --card-shadow: var(--shadow-sm);
    --result-opacity: 0.65;
    --avatar-text: var(--color-bg);
  }
  :root.light {
    --color-bg:            #FFFFFF;
    --color-surface-1:     #F7F8F9;
    --color-surface-2:     #FFFFFF;
    --color-surface-3:     #F0F1F3;
    --color-surface-hover: #F2F3F5;
    --color-surface-active:#E8EAED;
    --color-border-subtle: #ECEDEF;
    --color-border:        #DDDFE3;
    --color-border-strong: #C2C5CB;
    --color-text:          #0F1115;
    --color-text-secondary:#3D424C;
    --color-text-tertiary: #6B7280;
    --color-text-disabled: #A6ABB4;
    --color-text-on-accent:#FFFFFF;
    --color-accent:        #5E6AD2;
    --color-accent-hover:  #4C58C0;
    --color-accent-active: #3F4AAE;
    --color-accent-subtle: rgba(94,106,210,0.10);
    --color-accent-ring:   rgba(94,106,210,0.30);
    --color-success:        #2E9B6A;
    --color-success-subtle: rgba(46,155,106,0.12);
    --color-warning:        #C99B2E;
    --color-warning-subtle: rgba(201,155,46,0.12);
    --color-danger:         #D33A3A;
    --color-danger-subtle:  rgba(211,58,58,0.10);
    --color-info:           #2D7AE0;
    --color-info-subtle:    rgba(45,122,224,0.10);
    --shadow-sm: 0 1px 2px rgba(15,17,21,0.06);
    --shadow-md: 0 4px 10px rgba(15,17,21,0.08), 0 1px 2px rgba(15,17,21,0.04);
    --shadow-lg: 0 10px 24px rgba(15,17,21,0.10), 0 2px 6px rgba(15,17,21,0.06);
    --shadow-xl: 0 24px 48px rgba(15,17,21,0.14), 0 4px 10px rgba(15,17,21,0.08);

    /* Legacy alias overrides */
    --bg-card-user: #e8f1ff;
    --bg-card-thinking: #fff6dc;
    --bg-card-skill: #f3e8ff;
    --bg-card-skill-result: #faf3ff;
    --bg-card-agent: #ffe8e8;
    --bg-card-bash: #e6f5e6;
    --bg-card-fileops: #fff0d8;
    --bg-card-web: #dff2f2;
    --bg-tab-close-hover: #ffe0e0;
    --text-strong: #000;
    --text-faint: #C2C5CB;
    --text-tool-pre: #2d6b1e;
    --text-md-inline: #b8531a;
    --accent-purple: #7a3fbf;
    --accent-purple-light: #5e2da0;
    --accent-yellow: #b88a00;
    --accent-cyan: #2a8888;
    --md-h2: #0a4a7a;
    --md-h3: #0a4aaa;
    --result-opacity: 0.75;
    --avatar-text: #fff;
  }
  body { font: var(--font-weight-regular) var(--font-size-base)/var(--line-height-base) var(--font-sans); letter-spacing: var(--letter-spacing-tight); margin: 0; background: var(--color-bg); color: var(--color-text); display: grid; grid-template-columns: var(--side-w, 280px) 1fr var(--thread-w, 0px); grid-template-rows: auto 1fr; height: 100vh; overflow: hidden; transition: grid-template-columns var(--duration-base) var(--ease-out); -webkit-font-smoothing: antialiased; -moz-osx-font-smoothing: grayscale; }
  html { --thread-w: 0px; }
  html.thread-open { --thread-w: 460px; }
  html.side-closed { --side-w: 0px !important; }
  html:not(.thread-open) { --thread-w: 0px !important; }
  #tabs { display: flex; flex-direction: column; padding: var(--space-2); border-bottom: 1px solid var(--color-border-subtle); background: var(--color-surface-1); flex-shrink: 0; max-height: 50vh; overflow-y: auto; gap: 1px; }
  #tabs:empty::before { content: attr(data-empty); color: var(--color-text-tertiary); font-size: var(--font-size-xs); padding: var(--space-2); text-align: center; }
  .tab-group { margin-bottom: var(--space-1); }
  .tab-group-header { font-size: 10px; color: var(--color-text-tertiary); text-transform: uppercase; letter-spacing: 0.06em; padding: var(--space-2) var(--space-2) var(--space-1); font-family: var(--font-mono); font-weight: var(--font-weight-medium); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .tab { position: relative; background: transparent; color: var(--color-text-secondary); border: 1px solid transparent; padding: var(--space-1) var(--space-2); border-radius: var(--radius-md); cursor: pointer; font-size: var(--font-size-xs); font-family: var(--font-mono); display: flex; align-items: center; gap: var(--space-2); width: 100%; text-align: left; transition: background var(--duration-fast) var(--ease-out), color var(--duration-fast) var(--ease-out); }
  .tab:hover { background: var(--color-surface-hover); color: var(--color-text); }
  .tab.active { background: var(--color-accent-subtle); color: var(--color-text); }
  .tab.active::before { content: ''; position: absolute; left: 2px; top: 25%; bottom: 25%; width: 2px; background: var(--color-accent); border-radius: var(--radius-full); }
  .tab.stale { opacity: 0.5; }
  .tab.stale.active { opacity: 0.85; }
  .tab .tab-label { overflow: hidden; text-overflow: ellipsis; flex: 1; white-space: nowrap; }
  .tab .tab-count { color: var(--color-text-tertiary); font-size: 10px; flex-shrink: 0; }
  .tab.active .tab-count { color: var(--color-accent); }
  .tab .tab-close { color: var(--color-text-tertiary); padding: 0 var(--space-1); border-radius: var(--radius-sm); visibility: hidden; flex-shrink: 0; transition: color var(--duration-fast) var(--ease-out), background var(--duration-fast) var(--ease-out); }
  .tab:hover .tab-close { visibility: visible; }
  .tab .tab-close:hover { color: var(--color-danger); background: var(--color-danger-subtle); }
  .tab-pane { overflow-y: auto; padding: var(--space-4) var(--space-5); height: 100%; display: none; }
  .tab-pane.active { display: block; }
  header { grid-column: 1 / -1; padding: var(--space-2) var(--space-3); background: var(--color-surface-1); border-bottom: 1px solid var(--color-border-subtle); display: flex; align-items: center; gap: var(--space-3); }
  header h1 { font-size: var(--font-size-md); margin: 0; color: var(--color-text); font-weight: var(--font-weight-semibold); letter-spacing: var(--letter-spacing-tight); }
  header .meta { color: var(--color-text-tertiary); font-size: var(--font-size-xs); font-family: var(--font-mono); }
  header .meta.live { color: var(--color-success); }
  header .meta.reconnecting { color: var(--color-danger); }
  header .dot { width: 7px; height: 7px; border-radius: var(--radius-full); background: var(--color-success); box-shadow: 0 0 0 3px var(--color-success-subtle); animation: pulse 1.6s infinite var(--ease-out); }
  @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }
  #mainContainer { overflow: hidden; grid-column: 2; background: var(--color-bg); }

  /* PTY shell pane — appears above the card stream inside a tab pane when attached.
     Override the default .tab-pane (display:none) / .tab-pane.active (display:block). */
  .tab-pane.active { display: flex; flex-direction: column; padding: 0; overflow: hidden; height: 100%; min-height: 0; }
  .tab-pane.active.has-pty .turns-host { flex: 1 1 0%; min-height: 0; overflow-y: auto; padding: var(--space-4) var(--space-5); }
  .tab-pane.active.has-pty .pty-host { flex: 0 0 var(--pty-h, 260px); min-height: 200px; display: flex; flex-direction: column; border-top: 1px solid var(--color-border-subtle); }
  .tab-pane.active:not(.has-pty) .pty-host { display: none; }
  .tab-pane.active:not(.has-pty) .turns-host { flex: 1 1 100%; min-height: 0; overflow-y: auto; padding: var(--space-4) var(--space-5); }
  .pty-bar { display: flex; align-items: center; gap: var(--space-2); padding: var(--space-1) var(--space-3); background: var(--color-surface-1); border-bottom: 1px solid var(--color-border-subtle); font-size: 11px; color: var(--color-text-secondary); }
  .pty-bar .pty-status { color: var(--accent-purple); font-weight: var(--font-weight-semibold); }
  .pty-bar .pty-status.exited { color: var(--color-danger); }
  .pty-bar .pty-cwd { font-family: var(--font-mono); color: var(--color-text-tertiary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; flex: 1; min-width: 0; }
  .pty-bar button { background: transparent; border: 1px solid var(--color-border-subtle); color: var(--color-text-secondary); padding: 2px 8px; border-radius: var(--radius-sm); font-size: 11px; cursor: pointer; }
  .pty-bar button:hover { color: var(--color-text); border-color: var(--color-border); }
  .pty-bar button[data-act="respawn"] { background: var(--accent-purple); color: #fff; border-color: var(--accent-purple); }
  .pty-bar button[data-act="respawn"]:hover { filter: brightness(1.1); }
  .pty-bar { cursor: pointer; user-select: none; }
  .pty-bar .pty-status, .pty-bar .pty-cwd { pointer-events: none; }
  .pty-bar button { pointer-events: auto; }
  .pty-resizer { flex: 0 0 5px; background: var(--color-border-subtle); cursor: row-resize; transition: background 100ms ease-out; }
  .pty-resizer:hover, .pty-resizer.dragging { background: var(--accent-purple); }
  .tab-pane.active:not(.has-pty) .pty-resizer { display: none; }
  .tab-pane.active.pty-fullscreen .turns-host,
  .tab-pane.active.pty-fullscreen .attach-bar,
  .tab-pane.active.pty-fullscreen .pty-resizer { display: none; }
  .tab-pane.active.pty-fullscreen .pty-host { flex: 1 1 100%; }

  .attach-bar { display: flex; justify-content: flex-end; padding: var(--space-2) var(--space-4); border-top: 1px solid var(--color-border-subtle); background: var(--color-surface-1); }
  .attach-bar button { background: var(--accent-purple); color: #fff; border: none; padding: 6px 14px; border-radius: var(--radius-sm); font-size: 12px; cursor: pointer; font-weight: var(--font-weight-semibold); }
  .attach-bar button:hover { filter: brightness(1.1); }

  /* Resume-cost summary inside the confirm modal */
  .resume-cost { display: flex; flex-direction: column; gap: var(--space-3); }
  .resume-cost .intro { color: var(--color-text); font-size: 13.5px; line-height: 1.5; }
  .resume-cost .section-label { font-size: 11px; color: var(--color-text-tertiary); text-transform: uppercase; letter-spacing: 0.08em; font-weight: var(--font-weight-semibold); margin-top: var(--space-2); }
  .resume-cost .stats { display: grid; grid-template-columns: max-content 1fr; gap: 4px var(--space-3); padding: var(--space-3); background: var(--color-surface-1); border: 1px solid var(--color-border-subtle); border-radius: var(--radius-sm); }
  .resume-cost .stats .k { color: var(--color-text-secondary); font-size: 12.5px; font-family: var(--font-mono); }
  .resume-cost .stats .v { color: var(--color-text); font-size: 13px; font-family: var(--font-mono); text-align: right; }
  .resume-cost .stats .row-note { grid-column: 1 / -1; color: var(--color-text-tertiary); font-size: 11.5px; padding-top: 2px; border-top: 1px dashed var(--color-border-subtle); margin-top: 4px; }
  .resume-cost .stats .v.muted { color: var(--color-text-tertiary); }
  .resume-cost .estimate { display: flex; align-items: baseline; gap: var(--space-2); padding: var(--space-3); background: rgba(167, 139, 250, 0.08); border: 1px solid var(--accent-purple); border-radius: var(--radius-sm); }
  .resume-cost .estimate .num { font-family: var(--font-mono); font-size: 18px; font-weight: var(--font-weight-semibold); color: var(--accent-purple); }
  .resume-cost .estimate .label { color: var(--color-text-secondary); font-size: 12px; }
  .resume-cost .note { font-size: 12px; color: var(--color-text-tertiary); line-height: 1.55; }

  /* Token row pulse on update */
  .token-row { position: relative; transition: background var(--duration-base) var(--ease-out); }
  .token-row .token-val { transition: color var(--duration-base) var(--ease-out); }
  .token-row.token-bump { animation: tokenBump 800ms ease-out; }
  @keyframes tokenBump {
    0%   { background: transparent; }
    15%  { background: rgba(167, 139, 250, 0.22); }
    100% { background: transparent; }
  }
  .token-row.token-bump .token-val { color: var(--accent-purple); }
  .token-help { display: inline-flex; align-items: center; justify-content: center; width: 14px; height: 14px; margin-left: 6px; border: 1px solid var(--color-border); border-radius: 50%; color: var(--color-text-tertiary); font-size: 9px; font-weight: var(--font-weight-semibold); cursor: help; vertical-align: middle; line-height: 1; transition: color var(--duration-fast) var(--ease-out), border-color var(--duration-fast) var(--ease-out); }
  .token-help:hover { color: var(--accent-purple); border-color: var(--accent-purple); }
  #floatingTip { position: fixed; max-width: 280px; padding: 8px 10px; background: var(--color-surface-2); color: var(--color-text); border: 1px solid var(--color-border); border-radius: var(--radius-sm); box-shadow: var(--shadow-lg); font-size: 12px; line-height: 1.5; z-index: 9999; opacity: 0; pointer-events: none; transition: opacity 100ms ease-out; }
  #floatingTip.open { opacity: 1; }
  .attach-bar .attach-bar-note { flex: 1; font-size: 11px; color: var(--color-text-tertiary); align-self: center; padding-right: var(--space-3); }
  .tab-pane.active.has-pty .attach-bar { display: none; }
  .pty-term { flex: 1 1 auto; min-height: 160px; padding: var(--space-1) var(--space-2); background: #0c0d0f; overflow: hidden; position: relative; }
  .pty-term .xterm, .pty-term .xterm-viewport, .pty-term .xterm-screen { background: #0c0d0f !important; height: 100% !important; }

  /* Spawn modal */
  #spawnModal { display: none; }
  #spawnModal.open { display: flex; }
  .modal-body label { display: block; font-size: 12px; color: var(--color-text-secondary); margin: var(--space-2) 0 4px; }
  .modal-body input[type="text"] { width: 100%; padding: 8px 10px; border: 1px solid var(--color-border); border-radius: var(--radius-sm); background: var(--color-surface-1); color: var(--color-text); font-family: var(--font-mono); font-size: 13px; }
  .modal-body .hint { font-size: 11px; color: var(--color-text-tertiary); margin-top: 4px; }
  .modal-body .recent-cwds { display: flex; flex-direction: column; gap: 4px; margin-top: var(--space-2); max-height: 200px; overflow-y: auto; }
  .modal-body .recent-cwds button { text-align: left; padding: 6px 8px; background: var(--color-surface-1); border: 1px solid var(--color-border-subtle); border-radius: var(--radius-sm); color: var(--color-text-secondary); cursor: pointer; font-family: var(--font-mono); font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .modal-body .recent-cwds button:hover { color: var(--color-text); border-color: var(--color-border); }

  /* Tab indicator for PTY-attached sessions */
  .tab .tab-pty-mark { color: var(--accent-purple); margin-right: 4px; }
  #side { padding: 0; border-right: 1px solid var(--color-border-subtle); background: var(--color-surface-1); grid-column: 1; display: flex; flex-direction: column; overflow: hidden; min-width: 0; position: relative; }
  #sideInfo { overflow-y: auto; padding: var(--space-5) var(--space-4); flex: 1; min-height: 0; }
  #info .stat span:last-child { white-space: normal; word-break: break-all; overflow: visible; text-overflow: clip; }
  html.side-closed #side { display: none; }
  #thread { grid-column: 3; grid-row: 2; border-left: 1px solid var(--color-border-subtle); background: var(--color-surface-1); display: flex; flex-direction: column; overflow: hidden; min-width: 0; position: relative; }
  .col-resizer { position: absolute; top: 0; height: 100%; width: 6px; cursor: col-resize; z-index: 50; background: transparent; transition: background var(--duration-fast) var(--ease-out); }
  #side .col-resizer { right: -3px; }
  #thread .col-resizer { left: -3px; }
  .col-resizer::before { content: ''; position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); width: 2px; height: 32px; background: transparent; border-radius: var(--radius-full); transition: background var(--duration-fast) var(--ease-out); }
  .col-resizer:hover::before, .col-resizer.dragging::before { background: var(--color-accent); }
  html.dragging-col, html.dragging-col body { cursor: col-resize !important; user-select: none; }
  html.dragging-col body { transition: none !important; }
  html.dragging-col iframe { pointer-events: none; }
  html:not(.thread-open) #thread { display: none; }
  .thread-header { padding: var(--space-3) var(--space-4); border-bottom: 1px solid var(--color-border-subtle); display: flex; align-items: center; gap: var(--space-3); flex-shrink: 0; }
  .thread-title { font-size: var(--font-size-md); font-weight: var(--font-weight-semibold); color: var(--color-text); letter-spacing: var(--letter-spacing-tight); flex-shrink: 0; }
  .thread-sub { font-size: var(--font-size-xs); color: var(--color-text-tertiary); flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: var(--font-mono); }
  .thread-close-btn { width: 24px; height: 24px; display: inline-flex; align-items: center; justify-content: center; background: none; border: none; color: var(--color-text-tertiary); border-radius: var(--radius-sm); cursor: pointer; font-size: 18px; line-height: 1; transition: background var(--duration-fast) var(--ease-out), color var(--duration-fast) var(--ease-out); }
  .thread-close-btn:hover { background: var(--color-surface-hover); color: var(--color-text); }
  #threadBody { flex: 1; overflow-y: auto; padding: var(--space-4); min-width: 0; }
  .turn-events { display: contents; }
  #threadEmpty { padding: var(--space-7) var(--space-5); text-align: center; color: var(--color-text-tertiary); font-size: var(--font-size-sm); }
  .card.user.turn-card { cursor: pointer; transition: filter var(--duration-fast) var(--ease-out), box-shadow var(--duration-fast) var(--ease-out); }
  .card.user.turn-card:hover { filter: brightness(1.06); }
  .card.user.turn-active { box-shadow: 0 0 0 2px var(--color-accent), 0 0 0 6px var(--color-accent-ring); }
  .turn-summary { margin-top: var(--space-3); padding-top: var(--space-3); border-top: 1px solid var(--color-border-strong); display: flex; flex-direction: column; gap: var(--space-2); }
  .turn-meta { display: flex; gap: var(--space-1); flex-wrap: wrap; align-items: center; }
  .turn-meta > span { background: var(--color-surface-3); color: var(--color-text-secondary); padding: 1px var(--space-2); border-radius: var(--radius-full); font-family: var(--font-mono); font-size: 10px; line-height: 1.6; font-weight: var(--font-weight-medium); border: 1px solid var(--color-border-subtle); }
  .turn-meta .turn-skills { color: var(--accent-purple); background: transparent; padding: 0; border: none; display: inline-flex; align-items: center; flex-wrap: wrap; gap: var(--space-1); }
  .turn-meta .turn-skills .sk-step { background: rgba(176,127,232,0.14); border: 1px solid rgba(176,127,232,0.4); color: var(--accent-purple); padding: 1px var(--space-2); border-radius: var(--radius-full); display: inline-flex; align-items: center; gap: var(--space-1); font-size: 10px; font-family: var(--font-mono); font-weight: var(--font-weight-medium); cursor: pointer; transition: background var(--duration-fast) var(--ease-out), transform var(--duration-fast) var(--ease-out), border-color var(--duration-fast) var(--ease-out); }
  .turn-meta .turn-skills .sk-step:hover { background: rgba(176,127,232,0.22); border-color: var(--accent-purple); transform: translateY(-1px); }
  @keyframes flash-pulse { 0% { box-shadow: 0 0 0 0 var(--accent-purple); } 50% { box-shadow: 0 0 0 6px rgba(176,127,232,0.35); } 100% { box-shadow: 0 0 0 0 transparent; } }
  .card.flash-highlight { animation: flash-pulse 1.5s var(--ease-out); }
  .turn-meta .turn-skills .sk-step.sk-side { border-style: dashed; opacity: 0.85; }
  .turn-meta .turn-skills .sk-step.sk-soft { background: transparent; border-style: dashed; border-color: rgba(176,127,232,0.45); opacity: 0.75; cursor: help; }
  .turn-meta .turn-skills .sk-step.sk-soft:hover { background: rgba(176,127,232,0.10); opacity: 1; transform: none; }
  .turn-meta .turn-skills .sk-depth { font-size: 9px; opacity: 0.7; }
  .turn-meta .turn-skills .sk-count { background: var(--accent-purple); color: #fff; border-radius: var(--radius-full); padding: 0 var(--space-1); font-size: 9px; font-weight: var(--font-weight-bold); }
  .turn-meta .turn-agents { color: var(--color-danger); }
  .turn-meta .turn-duration { color: var(--color-text-tertiary); }
  .turn-preview { color: var(--color-text-secondary); font-size: var(--font-size-sm); line-height: 1.55; max-height: 3.1em; overflow: hidden; text-overflow: ellipsis; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; padding-left: var(--space-5); position: relative; }
  .turn-preview::before { content: '↳'; position: absolute; left: var(--space-1); top: 0; color: var(--accent-purple); font-weight: var(--font-weight-semibold); font-size: var(--font-size-md); line-height: 1.4; }
  .ctx-block { margin-bottom: var(--space-4); }
  .ctx-block:empty { display: none; }
  .ctx-head { color: var(--color-text-secondary); font-size: var(--font-size-xs); text-transform: uppercase; letter-spacing: 0.06em; margin: 0 0 var(--space-2); display: flex; justify-content: space-between; align-items: baseline; font-weight: var(--font-weight-semibold); font-family: var(--font-mono); }
  .ctx-head span:last-child { color: var(--color-text-tertiary); font-weight: var(--font-weight-regular); }
  .ctx-list { display: flex; flex-direction: column; gap: 2px; padding-left: var(--space-1); }
  .ctx-item { font-size: var(--font-size-sm); color: var(--color-text); font-family: var(--font-mono); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; padding: 1px 0; }
  .ctx-item .ctx-icon { color: var(--color-text-tertiary); margin-right: var(--space-2); }
  .card { padding: var(--space-2) var(--space-3); margin: var(--space-1) 0; border-radius: var(--radius-md); border: 1px solid var(--color-border-subtle); border-left: 2px solid var(--color-border); background: var(--color-surface-2); box-shadow: var(--shadow-sm); transition: background var(--duration-fast) var(--ease-out), border-color var(--duration-fast) var(--ease-out); }
  .card.user { background: var(--color-accent-subtle); margin: var(--space-7) var(--space-8) var(--space-3) auto; max-width: calc(100% - var(--space-8)); border: 1px solid transparent; border-radius: var(--radius-lg) var(--radius-lg) var(--radius-sm) var(--radius-lg); padding: var(--space-2) var(--space-3); position: relative; box-shadow: var(--shadow-sm); }
  .turn-divider { display: flex; align-items: center; margin: var(--space-7) calc(-1 * var(--space-4)); color: var(--color-text-tertiary); font-size: var(--font-size-xs); letter-spacing: 0.08em; pointer-events: none; user-select: none; text-transform: uppercase; }
  .turn-divider::before, .turn-divider::after { content: ''; flex: 1; border-top: 1px dashed var(--color-border); }
  .turn-divider span { padding: 0 var(--space-3); font-weight: var(--font-weight-semibold); }
  .card.text { background: var(--color-surface-2); margin: var(--space-7) auto var(--space-3) var(--space-8); max-width: calc(100% - var(--space-8)); border: 1px solid var(--color-border-subtle); border-radius: var(--radius-lg) var(--radius-lg) var(--radius-lg) var(--radius-sm); padding: var(--space-2) var(--space-3); position: relative; box-shadow: var(--shadow-sm); }
  .card.thinking { background: var(--color-warning-subtle); font-style: italic; margin: var(--space-7) auto var(--space-3) var(--space-8); max-width: calc(100% - var(--space-8)); border: 1px solid transparent; border-radius: var(--radius-lg) var(--radius-lg) var(--radius-lg) var(--radius-sm); padding: var(--space-2) var(--space-3); position: relative; color: var(--color-warning); }
  .card.user > .name > span:first-child, .card.text > .name > span:first-child, .card.thinking > .name > span:first-child { display: none; }
  .card.user > .name, .card.text > .name, .card.thinking > .name { margin-bottom: 2px; justify-content: flex-end; }
  .card.user::after, .card.text::before, .card.thinking::before { position: absolute; top: 0; width: 28px; height: 28px; border-radius: var(--radius-full); text-align: center; line-height: 28px; font-size: 11px; font-weight: var(--font-weight-semibold); color: var(--color-text-on-accent); font-family: var(--font-sans); letter-spacing: 0; text-transform: none; font-style: normal; box-shadow: var(--shadow-sm); }
  .card.user::after { content: 'U'; right: calc(-1 * var(--space-7) - 4px); background: var(--color-accent); }
  .card.text::before, .card.thinking::before { content: 'C'; left: calc(-1 * var(--space-7) - 4px); background: var(--accent-purple); }
  .card.tool { border-left-color: var(--color-success); }
  .card.tool-Skill { border-left-color: var(--accent-purple); background: var(--bg-card-skill); }
  .card.tool-result-skill { border-left-color: var(--accent-purple); background: var(--bg-card-skill-result); }
  .card.tool-result-skill .tag { color: var(--accent-purple-light); }
  .card.tool-Agent, .card.tool-Task { border-left-color: var(--color-danger); background: var(--bg-card-agent); }
  .card.tool-Bash { border-left-color: var(--color-success); background: var(--bg-card-bash); }
  .card.tool-Read, .card.tool-Write, .card.tool-Edit, .card.tool-NotebookEdit { border-left-color: var(--color-warning); background: var(--bg-card-fileops); }
  .card.tool-WebSearch, .card.tool-WebFetch { border-left-color: var(--accent-cyan); background: var(--bg-card-web); }
  .card.tool-result { border-left-color: var(--color-text-disabled); background: var(--color-surface-1); opacity: var(--result-opacity); font-size: var(--font-size-xs); }
  .card .name { color: var(--color-text-tertiary); font-size: 10px; margin-bottom: var(--space-1); letter-spacing: 0.06em; text-transform: uppercase; font-weight: var(--font-weight-medium); display: flex; justify-content: space-between; gap: var(--space-3); align-items: center; }
  .card .name .time { color: var(--color-text-tertiary); text-transform: none; font-family: var(--font-mono); flex-shrink: 0; opacity: 0.75; }
  .card pre { margin: 0; white-space: pre-wrap; word-break: break-word; font-family: inherit; line-height: var(--line-height-base); }
  .card.tool pre { font-family: var(--font-mono); font-size: 11.5px; color: var(--text-tool-pre); }
  .truncated { color: var(--color-text-tertiary); font-size: 10px; margin-top: var(--space-1); font-style: italic; }
  .card-images { display: flex; flex-wrap: wrap; gap: var(--space-2); margin-top: var(--space-3); padding-top: var(--space-3); border-top: 1px dashed var(--color-border-strong); }
  .card .name + .card-images { border-top: none; padding-top: 0; margin-top: var(--space-2); }
  .card-image-link { display: inline-flex; line-height: 0; border-radius: var(--radius-md); overflow: hidden; border: 1px solid var(--color-border-subtle); cursor: zoom-in; transition: transform var(--duration-fast) var(--ease-out), border-color var(--duration-fast) var(--ease-out), box-shadow var(--duration-fast) var(--ease-out); }
  .card-image-link:hover { transform: scale(1.02); border-color: var(--color-accent); box-shadow: var(--shadow-md); }
  .card-image { max-width: 240px; max-height: 200px; display: block; object-fit: cover; }
  #lightbox { position: fixed; inset: 0; background: rgba(8,9,10,0.88); backdrop-filter: blur(8px); -webkit-backdrop-filter: blur(8px); z-index: var(--z-modal); display: none; align-items: center; justify-content: center; cursor: zoom-out; padding: var(--space-6); opacity: 0; transition: opacity var(--duration-base) var(--ease-out); }
  #lightbox.open { display: flex; opacity: 1; }
  #lightbox img { max-width: 100%; max-height: 100%; border-radius: var(--radius-lg); box-shadow: var(--shadow-xl); }
  .card.collapsible { cursor: pointer; user-select: none; }
  .card.collapsible:hover { border-color: var(--color-border); }
  .card.collapsible.open { cursor: default; }
  .card.collapsible .summary { color: var(--color-text); text-transform: none; letter-spacing: 0; font-size: 12.5px; font-family: var(--font-mono); flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .card.collapsible .tag { color: var(--color-text-secondary); font-weight: var(--font-weight-semibold); margin-right: var(--space-2); flex-shrink: 0; }
  .card.collapsible .toggle { color: var(--color-text-tertiary); margin-right: var(--space-2); display: inline-block; width: 10px; flex-shrink: 0; transition: transform var(--duration-fast) var(--ease-out); }
  .card.collapsible.open .toggle { transform: rotate(90deg); color: var(--color-accent); }
  .card.collapsible .detail { display: none; margin-top: var(--space-2); border-top: 1px dashed var(--color-border-subtle); padding-top: var(--space-2); }
  .card.collapsible.open .detail { display: block; }
  .card.collapsible .header-row { display: flex; align-items: center; flex: 1; min-width: 0; }

  .askq { display: flex; flex-direction: column; gap: var(--space-4); padding: var(--space-1) 0; }
  .askq-q { display: flex; flex-direction: column; gap: var(--space-2); }
  .askq-q + .askq-q { border-top: 1px dashed var(--color-border-subtle); padding-top: var(--space-4); }
  .askq-q-head { display: flex; align-items: center; gap: var(--space-2); flex-wrap: wrap; }
  .askq-idx { font-family: var(--font-mono); font-size: 11px; color: var(--color-text-tertiary); letter-spacing: 0.04em; }
  .askq-chip { display: inline-block; padding: 1px 8px; border-radius: 999px; background: var(--color-surface-2); color: var(--color-text-secondary); font-size: 11px; font-weight: var(--font-weight-semibold); text-transform: uppercase; letter-spacing: 0.05em; }
  .askq-mode { font-size: 11px; color: var(--color-text-tertiary); }
  .askq-title { font-size: var(--font-size-md); color: var(--color-text); font-weight: var(--font-weight-semibold); line-height: 1.45; white-space: pre-wrap; word-break: break-word; }
  .askq-opts { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: var(--space-2); }
  .askq-opt { border: 1px solid var(--color-border-subtle); border-radius: var(--radius-sm); padding: var(--space-2) var(--space-3); background: var(--color-surface-1); }
  .askq-opt--rec { border-color: var(--accent-purple); }
  .askq-opt-label { display: flex; align-items: center; gap: var(--space-2); color: var(--color-text); font-weight: var(--font-weight-semibold); font-size: 13px; }
  .askq-opt-desc { color: var(--color-text-secondary); font-size: 12.5px; line-height: 1.5; margin-top: 4px; white-space: pre-wrap; word-break: break-word; }
  .askq-rec { font-size: 10px; padding: 1px 6px; border-radius: 999px; background: var(--accent-purple); color: #fff; letter-spacing: 0.04em; font-weight: var(--font-weight-semibold); text-transform: uppercase; }
  h3 { margin: var(--space-5) 0 var(--space-3); padding-top: var(--space-4); border-top: 1px solid var(--color-border); font-size: var(--font-size-md); color: var(--color-text); font-weight: var(--font-weight-semibold); letter-spacing: var(--letter-spacing-tight); }
  h3:first-child { margin-top: 0; padding-top: 0; border-top: none; }
  .stat { display: flex; justify-content: space-between; gap: var(--space-2); padding: var(--space-1) 0; font-size: var(--font-size-sm); border-bottom: 1px dashed var(--color-border-subtle); }
  .stat span:first-child { white-space: nowrap; flex-shrink: 0; color: var(--color-text-secondary); }
  .stat span:last-child { color: var(--color-success); font-family: var(--font-mono); min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; text-align: right; }
  .stat.tool-Skill span:last-child { color: var(--accent-purple); }
  .stat.tool-Agent span:last-child, .stat.tool-Task span:last-child { color: var(--color-danger); }
  #empty { text-align: center; color: var(--color-text-tertiary); padding: var(--space-8) var(--space-5); font-size: var(--font-size-sm); }
  .md { white-space: pre-wrap; line-height: 1.55; }
  .md h1, .md h2, .md h3 { font-weight: var(--font-weight-semibold); margin: var(--space-4) 0 var(--space-2); line-height: var(--line-height-tight); letter-spacing: var(--letter-spacing-tight); }
  .md h1 { font-size: var(--font-size-2xl); color: var(--color-text); font-weight: var(--font-weight-bold); margin-top: var(--space-5); }
  .md h2 { font-size: var(--font-size-xl); color: var(--md-h2); }
  .md h3 { font-size: var(--font-size-md); color: var(--md-h3); font-weight: var(--font-weight-semibold); }
  .md ul, .md ol { margin: var(--space-1) 0; padding-left: 22px; white-space: normal; }
  .md li { margin: 2px 0; }
  .md hr { border: 0; border-top: 1px solid var(--color-border-subtle); margin: var(--space-3) 0; }
  .md a { color: var(--color-accent); text-decoration: none; transition: color var(--duration-fast) var(--ease-out); }
  .md a:hover { color: var(--color-accent-hover); text-decoration: underline; }
  .md .md-inline { background: var(--color-surface-3); padding: 1px var(--space-2); border-radius: var(--radius-sm); font-family: var(--font-mono); font-size: 11.5px; color: var(--text-md-inline); white-space: nowrap; border: 1px solid var(--color-border-subtle); }
  .md .md-code { background: var(--color-surface-1); padding: var(--space-3); border-radius: var(--radius-md); overflow-x: auto; margin: var(--space-2) 0; white-space: pre; border: 1px solid var(--color-border-subtle); }
  .md .md-code code { font-family: var(--font-mono); font-size: 11.5px; color: var(--text-tool-pre); }
  .md .md-table { border-collapse: collapse; margin: var(--space-2) 0; font-size: var(--font-size-sm); white-space: normal; width: 100%; border-radius: var(--radius-md); overflow: hidden; }
  .md .md-table th, .md .md-table td { border: 1px solid var(--color-border-subtle); padding: var(--space-1) var(--space-3); text-align: left; vertical-align: top; }
  .md .md-table th { background: var(--color-surface-3); color: var(--color-text); font-weight: var(--font-weight-semibold); }
  .md .md-table td { background: var(--color-surface-2); }
  .md strong { color: var(--color-text); font-weight: var(--font-weight-semibold); }
  .stat.tool-row { cursor: pointer; user-select: none; padding: var(--space-1) var(--space-2); margin: 0 calc(-1 * var(--space-2)); border-radius: var(--radius-sm); border-bottom: 1px dashed var(--color-border-subtle); transition: background var(--duration-fast) var(--ease-out); }
  .stat.tool-row:hover { background: var(--color-surface-hover); }
  .stat.tool-row.active { background: var(--color-accent-subtle); color: var(--color-text); }
  .stat.tool-row.active span:first-child::before { content: '● '; color: var(--color-accent); }
  #pinHint { color: var(--color-text-tertiary); font-size: 10px; margin-top: var(--space-2); line-height: var(--line-height-base); font-style: italic; }
  #drawer { position: fixed; top: 0; right: 0; width: min(420px, 90vw); height: 100vh; background: var(--color-surface-1); border-left: 1px solid var(--color-border); z-index: var(--z-drawer); transform: translateX(100%); transition: transform var(--duration-slow) var(--ease-out); display: flex; flex-direction: column; box-shadow: var(--shadow-lg); }
  #drawer.open { transform: translateX(0); }
  #drawerBackdrop { position: fixed; inset: 0; background: rgba(8,9,10,0.64); backdrop-filter: blur(4px); -webkit-backdrop-filter: blur(4px); z-index: calc(var(--z-drawer) - 1); opacity: 0; pointer-events: none; transition: opacity var(--duration-base) var(--ease-out); }
  #drawerBackdrop.open { opacity: 1; pointer-events: auto; }
  .drawer-header { padding: var(--space-4) var(--space-5); border-bottom: 1px solid var(--color-border-subtle); display: flex; justify-content: space-between; align-items: center; flex-shrink: 0; }
  .drawer-title { font-size: var(--font-size-lg); font-weight: var(--font-weight-semibold); color: var(--color-text); letter-spacing: var(--letter-spacing-tight); }
  .drawer-close-btn { width: 24px; height: 24px; display: inline-flex; align-items: center; justify-content: center; background: none; border: none; color: var(--color-text-tertiary); border-radius: var(--radius-sm); cursor: pointer; font-size: 18px; line-height: 1; padding: 0; transition: background var(--duration-fast) var(--ease-out), color var(--duration-fast) var(--ease-out); }
  .drawer-close-btn:hover { background: var(--color-surface-hover); color: var(--color-text); }
  .drawer-body { flex: 1; overflow-y: auto; padding: var(--space-2) 0 var(--space-4); }
  .drawer-empty, .drawer-loading { padding: var(--space-6); text-align: center; color: var(--color-text-tertiary); font-size: var(--font-size-sm); }
  .drawer-project { margin-bottom: var(--space-4); }
  .drawer-project-head { display: flex; align-items: center; gap: var(--space-1); padding: 0 var(--space-1); }
  .drawer-project-name { display: flex; align-items: center; gap: var(--space-2); flex: 1; min-width: 0; padding: var(--space-2) var(--space-3); border: none; background: transparent; font-size: var(--font-size-xs); color: var(--color-text-secondary); text-transform: uppercase; letter-spacing: 0.06em; font-weight: var(--font-weight-semibold); font-family: var(--font-mono); cursor: pointer; border-radius: var(--radius-sm); text-align: left; transition: background var(--duration-fast) var(--ease-out), color var(--duration-fast) var(--ease-out); }
  .drawer-project-name:hover { background: var(--color-surface-hover); color: var(--color-text); }
  .drawer-project-pin { width: 28px; height: 28px; display: inline-flex; align-items: center; justify-content: center; flex-shrink: 0; background: transparent; border: none; border-radius: var(--radius-sm); cursor: pointer; color: var(--color-text-tertiary); opacity: 0.4; transition: opacity var(--duration-fast) var(--ease-out), color var(--duration-fast) var(--ease-out), background var(--duration-fast) var(--ease-out); }
  .drawer-project-pin:hover { opacity: 1; background: var(--color-surface-hover); color: var(--color-warning); }
  .drawer-project.pinned .drawer-project-pin { opacity: 1; color: var(--color-warning); }
  .drawer-project.pinned .drawer-project-pin svg { fill: var(--color-warning); }
  .drawer-project.pinned .drawer-project-label { color: var(--color-text); }
  .drawer-project-name .chevron { font-size: 10px; color: var(--color-text-tertiary); transition: transform var(--duration-fast) var(--ease-out); width: 10px; flex-shrink: 0; display: inline-block; }
  .drawer-project.collapsed .drawer-project-name .chevron { transform: rotate(-90deg); }
  .drawer-project-label { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .drawer-project-count { color: var(--color-text-tertiary); font-weight: var(--font-weight-regular); font-size: 10px; }
  .drawer-project.collapsed .drawer-project-body { display: none; }
  .drawer-date-group { padding: 0 var(--space-2); }
  .drawer-date-label { padding: var(--space-2) var(--space-3) var(--space-1); font-size: 10px; color: var(--color-text-tertiary); font-weight: var(--font-weight-medium); text-transform: uppercase; letter-spacing: 0.05em; }
  .drawer-session { padding: var(--space-2) var(--space-3); margin: 1px 0; border-radius: var(--radius-md); cursor: pointer; display: flex; align-items: center; gap: var(--space-2); font-size: var(--font-size-xs); font-family: var(--font-mono); color: var(--color-text-secondary); transition: background var(--duration-fast) var(--ease-out), color var(--duration-fast) var(--ease-out); }
  .drawer-session:hover { background: var(--color-surface-hover); color: var(--color-text); }
  .drawer-session.in-tabs { background: var(--color-accent-subtle); color: var(--color-text); }
  .drawer-session-id { flex: 1; }
  .drawer-session-time { color: var(--color-text-tertiary); font-size: 10px; flex-shrink: 0; }
  .session-dot { width: 6px; height: 6px; border-radius: var(--radius-full); background: var(--color-text-disabled); flex-shrink: 0; }
  .session-dot.live { background: var(--color-success); box-shadow: 0 0 0 2px var(--color-success-subtle); }
  .tab-loading { text-align: center; color: var(--color-text-tertiary); padding: var(--space-8) var(--space-5); font-size: var(--font-size-sm); }
  .drawer-search-row { padding: var(--space-3) var(--space-4); border-bottom: 1px solid var(--color-border-subtle); flex-shrink: 0; }
  #drawerSearch { width: 100%; height: 28px; background: var(--color-surface-2); color: var(--color-text); border: 1px solid var(--color-border); border-radius: var(--radius-md); padding: 0 var(--space-3); font-size: var(--font-size-sm); font-family: var(--font-sans); letter-spacing: var(--letter-spacing-tight); outline: none; transition: border-color var(--duration-fast) var(--ease-out), box-shadow var(--duration-fast) var(--ease-out); }
  #drawerSearch::placeholder { color: var(--color-text-tertiary); }
  #drawerSearch:hover { border-color: var(--color-border-strong); }
  #drawerSearch:focus { border-color: var(--color-accent); box-shadow: var(--shadow-focus); }
  .drawer-session-meta { color: var(--color-text-tertiary); font-size: 10px; flex-shrink: 0; margin-left: var(--space-1); }
  .drawer-session-del { background: none; border: none; color: var(--color-text-tertiary); cursor: pointer; padding: 0 var(--space-1); font-size: 14px; line-height: 1; opacity: 0; border-radius: var(--radius-sm); transition: opacity var(--duration-fast) var(--ease-out), color var(--duration-fast) var(--ease-out), background var(--duration-fast) var(--ease-out); }
  .drawer-session:hover .drawer-session-del { opacity: 1; }
  .drawer-session-del:hover { color: var(--color-danger); background: var(--color-danger-subtle); }

  /* ============================================================================
     ATOMIC COMPONENTS — Linear-inspired design system
     Atoms: .btn .input .select .label .badge
     Molecules: .form-row
     Organisms: .modal .toolbar
     ============================================================================ */

  /* ---- Button atom ---- */
  .btn { display: inline-flex; align-items: center; justify-content: center; gap: var(--space-2); height: 32px; padding: 0 var(--space-3); border: 1px solid transparent; border-radius: var(--radius-md); background: transparent; color: var(--color-text); font: var(--font-weight-medium) var(--font-size-base)/1 var(--font-sans); letter-spacing: var(--letter-spacing-tight); cursor: pointer; user-select: none; white-space: nowrap; transition: background var(--duration-fast) var(--ease-out), border-color var(--duration-fast) var(--ease-out), color var(--duration-fast) var(--ease-out), box-shadow var(--duration-fast) var(--ease-out), transform var(--duration-fast) var(--ease-out); }
  .btn:focus-visible { outline: none; box-shadow: var(--shadow-focus); }
  .btn:disabled { opacity: 0.5; cursor: not-allowed; }
  .btn:active:not(:disabled) { transform: translateY(0.5px); }
  .btn--primary { background: var(--color-accent); color: var(--color-text-on-accent); border-color: var(--color-accent); }
  .btn--primary:hover:not(:disabled)  { background: var(--color-accent-hover); border-color: var(--color-accent-hover); }
  .btn--primary:active:not(:disabled) { background: var(--color-accent-active); }
  .btn--secondary { background: var(--color-surface-2); border-color: var(--color-border); color: var(--color-text); }
  .btn--secondary:hover:not(:disabled)  { background: var(--color-surface-3); border-color: var(--color-border-strong); }
  .btn--secondary:active:not(:disabled) { background: var(--color-surface-active); }
  .btn--ghost { background: transparent; color: var(--color-text-secondary); }
  .btn--ghost:hover:not(:disabled)  { background: var(--color-surface-hover); color: var(--color-text); }
  .btn--ghost:active:not(:disabled) { background: var(--color-surface-active); }
  .btn--danger { background: var(--color-danger); color: #fff; border-color: var(--color-danger); }
  .btn--danger:hover:not(:disabled) { filter: brightness(1.08); }
  .btn--icon { width: 32px; padding: 0; }
  .btn--sm { height: 28px; padding: 0 var(--space-2); font-size: var(--font-size-sm); }
  .btn--sm.btn--icon { width: 28px; padding: 0; }
  .btn--lg { height: 38px; padding: 0 var(--space-4); font-size: var(--font-size-md); }
  .btn--lg.btn--icon { width: 38px; padding: 0; }

  /* ---- Input / Select atoms ---- */
  .input, .select { display: inline-flex; align-items: center; height: 32px; padding: 0 var(--space-3); background: var(--color-surface-2); border: 1px solid var(--color-border); border-radius: var(--radius-md); color: var(--color-text); font: var(--font-weight-regular) var(--font-size-base)/1 var(--font-sans); letter-spacing: var(--letter-spacing-tight); transition: border-color var(--duration-fast) var(--ease-out), box-shadow var(--duration-fast) var(--ease-out), background var(--duration-fast) var(--ease-out); }
  .input::placeholder { color: var(--color-text-tertiary); }
  .input:hover, .select:hover { border-color: var(--color-border-strong); }
  .input:focus, .select:focus { outline: none; border-color: var(--color-accent); box-shadow: var(--shadow-focus); }
  .select { appearance: none; padding-right: var(--space-7); cursor: pointer; background-image: linear-gradient(45deg, transparent 50%, var(--color-text-tertiary) 50%), linear-gradient(135deg, var(--color-text-tertiary) 50%, transparent 50%); background-position: calc(100% - 14px) 50%, calc(100% - 9px) 50%; background-size: 5px 5px; background-repeat: no-repeat; }
  .select--sm { height: 28px; font-size: var(--font-size-sm); padding: 0 var(--space-7) 0 var(--space-2); }

  /* ---- Label / Badge atoms ---- */
  .label { display: inline-block; font-size: var(--font-size-sm); font-weight: var(--font-weight-medium); color: var(--color-text-secondary); letter-spacing: var(--letter-spacing-tight); }
  .badge { display: inline-flex; align-items: center; gap: var(--space-1); height: 20px; padding: 0 var(--space-2); border-radius: var(--radius-full); background: var(--color-surface-3); color: var(--color-text-secondary); border: 1px solid var(--color-border-subtle); font-size: var(--font-size-xs); font-weight: var(--font-weight-medium); line-height: 1; }
  .badge--success { background: var(--color-success-subtle); color: var(--color-success); border-color: transparent; }
  .badge--warning { background: var(--color-warning-subtle); color: var(--color-warning); border-color: transparent; }
  .badge--danger  { background: var(--color-danger-subtle);  color: var(--color-danger);  border-color: transparent; }
  .badge--info    { background: var(--color-info-subtle);    color: var(--color-info);    border-color: transparent; }
  .badge--accent  { background: var(--color-accent-subtle);  color: var(--color-accent);  border-color: transparent; }

  /* ---- Form row molecule ---- */
  .form-row { display: flex; align-items: center; justify-content: space-between; gap: var(--space-4); min-height: 36px; padding: var(--space-2) 0; }
  .form-row + .form-row { border-top: 1px solid var(--color-border-subtle); }
  .form-row__label { color: var(--color-text-secondary); font-size: var(--font-size-sm); font-weight: var(--font-weight-medium); letter-spacing: var(--letter-spacing-tight); }
  .form-row__control { display: flex; justify-content: flex-end; min-width: 150px; }
  .form-row__control .select { width: 100%; }

  /* ---- Modal organism ---- */
  .modal-backdrop { position: fixed; inset: 0; background: rgba(8,9,10,0.64); backdrop-filter: blur(4px); -webkit-backdrop-filter: blur(4px); z-index: var(--z-modal); display: none; align-items: center; justify-content: center; opacity: 0; transition: opacity var(--duration-base) var(--ease-out); }
  .modal-backdrop.open { display: flex; opacity: 1; }
  .modal { width: min(440px, calc(100vw - var(--space-7))); max-height: calc(100vh - var(--space-8)); background: var(--color-surface-2); border: 1px solid var(--color-border); border-radius: var(--radius-xl); box-shadow: var(--shadow-xl); display: flex; flex-direction: column; overflow: hidden; transform: scale(0.96) translateY(4px); opacity: 0; transition: opacity var(--duration-base) var(--ease-out), transform var(--duration-base) var(--ease-out); }
  .modal-backdrop.open .modal { opacity: 1; transform: scale(1) translateY(0); }
  .modal__header { display: flex; align-items: center; justify-content: space-between; gap: var(--space-3); padding: var(--space-4) var(--space-5); border-bottom: 1px solid var(--color-border-subtle); }
  .modal__title { font-size: var(--font-size-lg); font-weight: var(--font-weight-semibold); color: var(--color-text); letter-spacing: var(--letter-spacing-tight); }
  .modal__close { width: 24px; height: 24px; display: inline-flex; align-items: center; justify-content: center; border: none; background: transparent; color: var(--color-text-tertiary); border-radius: var(--radius-sm); cursor: pointer; font-size: 18px; line-height: 1; transition: background var(--duration-fast) var(--ease-out), color var(--duration-fast) var(--ease-out); }
  .modal__close:hover { background: var(--color-surface-hover); color: var(--color-text); }
  .modal__body { padding: var(--space-3) var(--space-5) var(--space-5); overflow: auto; }

  /* ---- Toolbar organism ---- */
  .toolbar__group { display: inline-flex; align-items: center; gap: var(--space-1); }
  .toolbar__group + .toolbar__group { padding-left: var(--space-3); margin-left: var(--space-1); border-left: 1px solid var(--color-border-subtle); }
  .toolbar__spacer { flex: 1 1 auto; }
</style></head><body>
<header>
  <div class="toolbar__group">
    <button id="sideToggle" class="btn btn--ghost btn--icon" title="Toggle sidebar" aria-label="Toggle sidebar"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="4" y1="6" x2="20" y2="6"/><line x1="4" y1="12" x2="20" y2="12"/><line x1="4" y1="18" x2="20" y2="18"/></svg></button>
    <div class="dot"></div>
    <h1>Claude Monitor</h1>
  </div>
  <div class="meta" id="sess">no active session</div>
  <div class="toolbar__spacer"></div>
  <div class="toolbar__group">
    <select id="filter" class="select" title="Filter">
      <option value="all" data-i18n="all_events">All events</option>
      <option value="skill" data-i18n="skill_only">Skills + memory only</option>
      <option value="conv_skill" data-i18n="conv_skill">Conversation + Skills</option>
      <option value="tools" data-i18n="tools_only">Tool calls only</option>
      <option value="conversation" data-i18n="conv_only">Conversation only</option>
    </select>
    <button id="clearBtn" class="btn btn--ghost" data-i18n="clear">Clear</button>
  </div>
  <div class="toolbar__group">
    <button id="spawnBtn" class="btn btn--primary" title="Spawn a new claude session in a terminal" data-i18n="spawn_btn">+ Spawn</button>
    <button id="sessionsBtn" class="btn btn--secondary" data-i18n="sessions_btn">Sessions</button>
    <button id="settingsBtn" class="btn btn--ghost btn--icon" title="Settings / 설정" aria-label="Settings"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/></svg></button>
  </div>
  <div class="meta" id="conn">connecting…</div>
</header>
<div id="side">
  <div id="tabs" data-empty="—"></div>
  <div id="sideInfo">
    <h3 data-i18n="tokens_title">Tokens (this session)</h3>
    <div id="tokens"></div>
    <h3 data-i18n="session_title">Session</h3>
    <div id="info"><div class="stat"><span>—</span><span></span></div></div>
    <h3 data-i18n="context_title">My context</h3>
    <div id="ctx-memory" class="ctx-block"></div>
    <div id="ctx-claude" class="ctx-block"></div>
    <div id="ctx-skills" class="ctx-block"></div>
    <h3 data-i18n="tools_title">Tool calls (click to filter)</h3>
    <div id="tools"></div>
    <div id="pinHint"></div>
  </div>
  <div class="col-resizer" data-resize="side" title="드래그하여 너비 조절"></div>
</div>
<div id="mainContainer"><div id="empty" data-i18n="waiting">Waiting for activity… Launch Claude Code in any project.</div></div>
<div id="thread">
  <div class="col-resizer" data-resize="thread" title="드래그하여 너비 조절"></div>
  <div class="thread-header">
    <span class="thread-title" data-i18n="thread_title">Thread</span>
    <span class="thread-sub" id="threadSub"></span>
    <button id="threadClose" class="thread-close-btn" title="Close">×</button>
  </div>
  <div id="threadBody"></div>
</div>
<div id="drawerBackdrop"></div>
<div id="drawer">
  <div class="drawer-header">
    <span class="drawer-title" data-i18n="sessions_title">Session browser</span>
    <button id="drawerClose" class="drawer-close-btn" title="Close">×</button>
  </div>
  <div class="drawer-search-row">
    <input id="drawerSearch" type="text" data-i18n-ph="drawer_search_ph" placeholder="Search…" />
  </div>
  <div id="drawerList" class="drawer-body"></div>
</div>
<div id="lightbox" role="dialog" aria-modal="true" aria-label="Image viewer"><img id="lightboxImg" alt="" /></div>
<div id="settingsBackdrop" class="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="settingsTitle">
  <div class="modal">
    <div class="modal__header">
      <span id="settingsTitle" class="modal__title" data-i18n="settings_title">Settings</span>
      <button id="settingsClose" class="modal__close" title="Close" aria-label="Close">×</button>
    </div>
    <div class="modal__body">
      <div class="form-row">
        <label class="form-row__label" for="lang" data-i18n="settings_lang">Language</label>
        <div class="form-row__control">
          <select id="lang" class="select">
            <option value="ko">한국어</option>
            <option value="en">English</option>
          </select>
        </div>
      </div>
      <div class="form-row">
        <label class="form-row__label" for="theme" data-i18n="settings_theme">Theme</label>
        <div class="form-row__control">
          <select id="theme" class="select">
            <option value="dark" data-i18n="theme_dark">Dark</option>
            <option value="light" data-i18n="theme_light">Light</option>
          </select>
        </div>
      </div>
      <div class="form-row">
        <label class="form-row__label" for="window" data-i18n="settings_window">Active window</label>
        <div class="form-row__control">
          <select id="window" class="select">
            <option value="1800000" data-i18n="window_30m">30분</option>
            <option value="7200000" data-i18n="window_2h">2시간</option>
            <option value="21600000" data-i18n="window_6h">6시간</option>
            <option value="86400000" data-i18n="window_24h">24시간</option>
          </select>
        </div>
      </div>
    </div>
  </div>
</div>
<div id="confirmBackdrop" class="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="confirmTitle">
  <div class="modal">
    <div class="modal__header">
      <span id="confirmTitle" class="modal__title">확인</span>
      <button id="confirmClose" class="modal__close" title="Close" aria-label="Close">×</button>
    </div>
    <div class="modal__body modal-body">
      <div id="confirmBody"></div>
      <div class="form-row" style="margin-top: var(--space-4); display:flex; justify-content:flex-end; gap: var(--space-2);">
        <button id="confirmCancel" class="btn btn--ghost">취소</button>
        <button id="confirmOk" class="btn btn--primary">진행</button>
      </div>
    </div>
  </div>
</div>
<div id="spawnBackdrop" class="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="spawnTitle">
  <div class="modal">
    <div class="modal__header">
      <span id="spawnTitle" class="modal__title" data-i18n="spawn_title">Spawn Claude session</span>
      <button id="spawnClose" class="modal__close" title="Close" aria-label="Close">×</button>
    </div>
    <div class="modal__body modal-body">
      <label for="spawnCwd" data-i18n="spawn_cwd_label">Working directory</label>
      <input id="spawnCwd" type="text" placeholder="/path/to/project" autocomplete="off" spellcheck="false" />
      <div class="hint" data-i18n="spawn_cwd_hint">Claude will be spawned with this as its cwd. Recent paths below.</div>
      <div id="spawnRecent" class="recent-cwds"></div>
      <div class="form-row" style="margin-top: var(--space-3); display:flex; justify-content:flex-end; gap: var(--space-2);">
        <button id="spawnCancel" class="btn btn--ghost" data-i18n="cancel">Cancel</button>
        <button id="spawnConfirm" class="btn btn--primary" data-i18n="spawn_btn">+ Spawn</button>
      </div>
    </div>
  </div>
</div>
<script>
const i18n = {
  en: {
    no_session: 'no active session',
    live: 'live', connecting: 'connecting…', reconnecting: 'reconnecting…',
    all_events: 'All events', skill_only: 'Skills + memory only',
    conv_skill: 'Conversation + Skills',
    tools_only: 'Tool calls only', conv_only: 'Conversation only',
    clear: 'Clear',
    session_title: 'Session', tokens_title: 'Tokens (this session)',
    tools_title: 'Tool calls (click to filter)',
    context_title: 'My context',
    ctx_memory: 'Memory', ctx_claude: 'CLAUDE.md', ctx_skills: 'Skills loaded',
    pin_hint_off: 'Click a row to show only that tool',
    pin_hint_on: 'Showing: {tools} (click again to unpin)',
    waiting: 'Waiting for activity… Launch Claude Code in any project.',
    cleared: 'History cleared. New events will appear here.',
    label_user: 'user', label_claude: 'claude', label_thinking: 'thinking',
    label_result: 'result',
    redacted_thinking: '(redacted, signature {bytes} bytes)',
    turn_label: 'new turn',
    project: 'project', session_id: 'session',
    theme_dark: 'Dark', theme_light: 'Light',
    sessions_btn: 'Sessions', sessions_title: 'Session browser', sessions_empty: 'No sessions found',
    sessions_loading: 'Loading…', sessions_failed: 'Failed to load',
    spawn_btn: '+ Spawn', spawn_title: 'Spawn Claude session',
    spawn_cwd_label: 'Working directory',
    spawn_cwd_hint: 'Claude will be spawned with this as its cwd. Recent paths below.',
    cancel: 'Cancel',
    date_today: 'Today', date_yesterday: 'Yesterday', date_thisweek: 'This week', date_older: 'Older',
    window_30m: '30 min', window_2h: '2 hours', window_6h: '6 hours', window_24h: '24 hours',
    drawer_search_ph: 'Search project or ID…',
    drawer_no_match: 'No matching sessions',
    delete_confirm: 'Delete this session JSONL? This cannot be undone.',
    delete_failed: 'Delete failed',
    msg_count: 'msg',
    side_hide: 'Hide sidebar', side_show: 'Show sidebar',
    thread_title: 'Thread', thread_close: 'Close thread',
    thread_empty: 'Click a message on the left to open its thread.',
    turn_tools_n: '{n} tools', turn_skill: 'Skill: {name}', turn_agent: 'Agent',
    session_preview: '(session start)',
    settings_title: 'Settings', settings_lang: 'Language', settings_theme: 'Theme', settings_window: 'Active window',
  },
  ko: {
    no_session: '활성 세션 없음',
    live: '실시간', connecting: '연결 중…', reconnecting: '재연결 중…',
    all_events: '전체', skill_only: '스킬 + 메모리만',
    conv_skill: '대화 + 스킬',
    tools_only: '도구 호출만', conv_only: '대화만',
    clear: '지우기',
    session_title: '세션', tokens_title: '토큰 (이번 세션)',
    tools_title: '도구 호출 (클릭으로 필터)',
    context_title: '내 컨텍스트',
    ctx_memory: '메모리', ctx_claude: 'CLAUDE.md', ctx_skills: '로드된 스킬',
    pin_hint_off: '도구 행을 클릭하면 해당 도구만 표시',
    pin_hint_on: '표시 중: {tools} (다시 클릭하면 해제)',
    waiting: '활동 대기 중… 아무 프로젝트에서 Claude Code를 실행하세요.',
    cleared: '히스토리가 지워졌습니다. 새 이벤트가 여기에 표시됩니다.',
    label_user: '사용자', label_claude: '클로드', label_thinking: '사고',
    label_result: '결과',
    redacted_thinking: '(암호화됨, signature {bytes} bytes)',
    turn_label: '새로운 대화',
    project: '프로젝트', session_id: '세션',
    theme_dark: '다크', theme_light: '라이트',
    sessions_btn: '세션', sessions_title: '세션 브라우저', sessions_empty: '세션 없음',
    sessions_loading: '불러오는 중…', sessions_failed: '불러오기 실패',
    spawn_btn: '+ 새 세션', spawn_title: 'Claude 세션 시작',
    spawn_cwd_label: '작업 디렉터리',
    spawn_cwd_hint: '여기를 cwd로 해서 claude를 띄웁니다. 아래는 최근 사용 경로.',
    cancel: '취소',
    date_today: '오늘', date_yesterday: '어제', date_thisweek: '이번 주', date_older: '이전',
    window_30m: '30분', window_2h: '2시간', window_6h: '6시간', window_24h: '24시간',
    drawer_search_ph: '프로젝트명 / ID 검색…',
    drawer_no_match: '일치하는 세션 없음',
    delete_confirm: '이 세션 JSONL을 삭제하시겠습니까? 되돌릴 수 없습니다.',
    delete_failed: '삭제 실패',
    msg_count: '메시지',
    side_hide: '사이드바 숨기기', side_show: '사이드바 보이기',
    thread_title: '스레드', thread_close: '스레드 닫기',
    thread_empty: '왼쪽 메시지를 클릭하면 해당 스레드가 열려요.',
    turn_tools_n: '도구 {n}', turn_skill: '스킬: {name}', turn_agent: '에이전트',
    session_preview: '(세션 시작)',
    settings_title: '설정', settings_lang: '언어', settings_theme: '테마', settings_window: '활성 윈도우',
  },
};
let lang = localStorage.getItem('cm-lang') || 'ko';
function t(key, vars) {
  let s = (i18n[lang] && i18n[lang][key]) || (i18n.en && i18n.en[key]) || key;
  if (vars) for (const k in vars) s = s.split('{' + k + '}').join(vars[k]);
  return s;
}
function applyStaticI18n() {
  document.documentElement.lang = lang;
  for (const el of document.querySelectorAll('[data-i18n]')) {
    el.textContent = t(el.dataset.i18n);
  }
  for (const el of document.querySelectorAll('[data-i18n-ph]')) {
    el.placeholder = t(el.dataset.i18nPh);
  }
}

const mainContainer = document.getElementById('mainContainer');
const info = document.getElementById('info');
const tokensEl = document.getElementById('tokens');
const TOKEN_KEYS = ['input', 'output', 'cache_read', 'cache_create'];

// Floating tooltip — sidebar parents have overflow:hidden so an inline ::after
// gets clipped. Render once to body, position on hover.
const floatingTip = document.createElement('div');
floatingTip.id = 'floatingTip';
document.body.appendChild(floatingTip);
document.body.addEventListener('mouseover', (e) => {
  const t = e.target.closest('[data-tip]');
  if (!t) return;
  floatingTip.textContent = t.getAttribute('data-tip') || '';
  const r = t.getBoundingClientRect();
  floatingTip.classList.add('open');
  // Position above the trigger; fall back below if it would clip the viewport top
  const tipRect = floatingTip.getBoundingClientRect();
  const left = Math.max(8, Math.min(window.innerWidth - tipRect.width - 8, r.left + r.width / 2 - tipRect.width / 2));
  let top = r.top - tipRect.height - 8;
  if (top < 8) top = r.bottom + 8;
  floatingTip.style.left = left + 'px';
  floatingTip.style.top  = top  + 'px';
});
document.body.addEventListener('mouseout', (e) => {
  const t = e.target.closest('[data-tip]');
  if (!t) return;
  if (e.relatedTarget && t.contains(e.relatedTarget)) return;
  floatingTip.classList.remove('open');
});
const TOKEN_TIPS = {
  input: '이번 세션에서 모델로 보낸 새 입력 토큰의 누적. 캐시 적용 안 된 분량.',
  output: '모델이 생성한 토큰의 누적. 일반적으로 가장 비싼 항목.',
  cache_read: '이미 캐시된 prompt prefix를 재사용해서 읽은 토큰 누적. 정상 input의 약 1/10 가격으로 저렴. 단, claude --resume으로 새 프로세스를 띄우면 옛 캐시는 못 씀.',
  cache_create: '캐시에 새로 저장된 토큰 누적. 정상 input보다 약간 비싸지만 다음 턴부터 cache_read로 재사용돼 비용이 절감됨. resume 시 첫 메시지 비용 ≈ 이 값.',
};

function renderTokens(tab, opts) {
  opts = opts || {};
  if (!tab) { tokensEl.innerHTML = ''; return; }
  const existing = tokensEl.querySelectorAll('.token-row');
  if (existing.length !== TOKEN_KEYS.length) {
    tokensEl.innerHTML = TOKEN_KEYS.map((k) =>
      '<div class="stat token-row" data-key="' + k + '">' +
        '<span>' + k + '<span class="token-help" data-tip="' + esc(TOKEN_TIPS[k] || '') + '" aria-label="설명">?</span></span>' +
        '<span class="token-val">' + (tab.tokens[k] || 0).toLocaleString() + '</span>' +
      '</div>'
    ).join('');
    return;
  }
  existing.forEach((row) => {
    const k = row.dataset.key;
    const valEl = row.querySelector('.token-val');
    const newVal = tab.tokens[k] || 0;
    const oldVal = parseInt(valEl.textContent.replace(/[^\d-]/g, ''), 10) || 0;
    if (newVal === oldVal) return;
    if (opts.animate === false) {
      valEl.textContent = newVal.toLocaleString();
    } else {
      animateTokenCount(valEl, oldVal, newVal);
      row.classList.remove('token-bump');
      void row.offsetWidth; // restart animation
      row.classList.add('token-bump');
    }
  });
}

function animateTokenCount(el, from, to) {
  const dur = 500;
  const start = performance.now();
  function step(now) {
    const t = Math.min(1, (now - start) / dur);
    const eased = 1 - Math.pow(1 - t, 3);
    el.textContent = Math.round(from + (to - from) * eased).toLocaleString();
    if (t < 1) requestAnimationFrame(step);
  }
  requestAnimationFrame(step);
}
const toolsEl = document.getElementById('tools');
const sessEl = document.getElementById('sess');
const connEl = document.getElementById('conn');
const tabsBar = document.getElementById('tabs');

const tabs = new Map(); // sessionId -> { mainEl, tabEl, tokens, toolCounts, sessionId, project, path, cardCount }
let activeTabId = null;

function persistTabs() {
  try {
    const arr = [];
    for (const t of tabs.values()) arr.push({ session: t.sessionId, project: t.project, path: t.path, cwd: (t.inventory && t.inventory.cwd) || '' });
    localStorage.setItem('cm-open-tabs', JSON.stringify(arr));
    if (activeTabId) localStorage.setItem('cm-active-tab', activeTabId);
    else localStorage.removeItem('cm-active-tab');
  } catch {}
}
let currentFilter = 'all';
const pinnedTools = new Set();

const SKILL_PATH_RE = /\.claude\/(skills|projects\/[^"'\s]+?\/memory)/;

function cardMatchesFilter(card) {
  if (pinnedTools.size > 0) {
    for (const t of pinnedTools) {
      if (card.classList.contains('tool-' + t)) return true;
      if (t === 'Skill' && card.classList.contains('tool-result-skill')) return true;
    }
    if (card.classList.contains('thinking')) return true;
    return false;
  }
  if (currentFilter === 'all') return true;
  if (currentFilter === 'conversation') return card.classList.contains('user') || card.classList.contains('text') || card.classList.contains('thinking');
  if (currentFilter === 'tools') return card.classList.contains('tool') || card.classList.contains('tool-result');
  if (currentFilter === 'skill') return isSkillCard(card);
  if (currentFilter === 'conv_skill') {
    if (card.classList.contains('user') || card.classList.contains('text') || card.classList.contains('thinking')) return true;
    return isSkillCard(card);
  }
  return true;
}

function isSkillCard(card) {
  if (card.classList.contains('tool-Skill')) return true;
  if (card.classList.contains('tool-result-skill')) return true;
  if (card.classList.contains('tool-Read') || card.classList.contains('tool-Edit') || card.classList.contains('tool-Write')) {
    const summary = card.querySelector('.summary');
    if (summary && SKILL_PATH_RE.test(summary.textContent)) return true;
  }
  return false;
}

function applyFilterAll() {
  for (const tab of tabs.values()) {
    for (const turn of tab.turns) {
      for (const card of turn.eventsEl.children) {
        card.style.display = cardMatchesFilter(card) ? '' : 'none';
      }
      updateUserCardVisibility(turn);
    }
  }
}

function getActiveTab() { return activeTabId ? tabs.get(activeTabId) : null; }

function projectDisplayName(project, cwd) {
  if (cwd) return cwd.replace(/^\/Users\/[^/]+/, '~').replace(/^\/home\/[^/]+/, '~');
  return project.replace(/^-/, '').split('-').filter(Boolean).slice(-2).join('/') || 'project';
}

function updateTabGroupLabel(project, cwd) {
  for (const g of tabsBar.children) {
    if (g.dataset && g.dataset.project === project) {
      g.dataset.cwd = cwd;
      const head = g.querySelector('.tab-group-header');
      if (head) {
        head.textContent = projectDisplayName(project, cwd);
        head.title = cwd || project;
      }
      break;
    }
  }
}

function ensureTab(sessionId, project, path, cwd) {
  if (tabs.has(sessionId)) {
    const existing = tabs.get(sessionId);
    existing.tabEl.classList.remove('stale');
    if (cwd && !existing.cwd) updateTabGroupLabel(project, cwd);
    return existing;
  }
  const pane = document.createElement('div');
  pane.className = 'tab-pane';
  pane.dataset.session = sessionId;
  const ptyHost = document.createElement('div');
  ptyHost.className = 'pty-host';
  const turnsHost = document.createElement('div');
  turnsHost.className = 'turns-host';
  const attachBar = document.createElement('div');
  attachBar.className = 'attach-bar';
  attachBar.innerHTML = '<span class="attach-bar-note">이 세션 이어서 새 터미널 (--resume)</span><button data-act="attach">+ 터미널 열기</button>';
  const ptyResizer = document.createElement('div');
  ptyResizer.className = 'pty-resizer';
  ptyResizer.title = '드래그로 높이 조정';
  pane.appendChild(turnsHost);
  pane.appendChild(attachBar);
  pane.appendChild(ptyResizer);
  pane.appendChild(ptyHost);
  wirePtyResizer(pane, ptyHost, ptyResizer, sessionId);
  const _sid = sessionId;
  const _cwdParam = cwd;
  attachBar.querySelector('[data-act="attach"]').addEventListener('click', () => {
    const t = tabs.get(_sid);
    if (!t) return;
    const targetCwd = t.cwd || (t.inventory && t.inventory.cwd) || _cwdParam || '';
    if (!targetCwd) {
      // cwd unknown — open the spawn modal so the user can fill it in.
      setSpawnModal(true);
      return;
    }
    spawnAndAttachInline(t, targetCwd);
  });
  mainContainer.appendChild(pane);

  const projName = projectDisplayName(project, cwd);
  let group = null;
  for (const g of tabsBar.children) {
    if (g.dataset && g.dataset.project === project) { group = g; break; }
  }
  if (!group) {
    group = document.createElement('div');
    group.className = 'tab-group';
    group.dataset.project = project;
    if (cwd) group.dataset.cwd = cwd;
    group.innerHTML = '<div class="tab-group-header" title="' + esc(cwd || project) + '">' + esc(projName) + '</div>';
    tabsBar.appendChild(group);
  }
  const tabEl = document.createElement('button');
  tabEl.className = 'tab';
  tabEl.dataset.session = sessionId;
  tabEl.innerHTML =
    '<span class="tab-label" title="' + esc(sessionId) + '">' + esc(sessionId.slice(0, 8)) + '</span>' +
    '<span class="tab-count">0</span>' +
    '<span class="tab-close" title="Close">×</span>';
  group.appendChild(tabEl);

  tabEl.addEventListener('click', (e) => {
    if (e.target.classList.contains('tab-close')) { e.stopPropagation(); closeTab(sessionId); return; }
    switchTab(sessionId);
  });

  const placeholder = document.getElementById('empty');
  if (placeholder) placeholder.remove();

  const tab = {
    sessionId, project, path,
    mainEl: pane, tabEl,
    ptyHost, turnsHost,
    ptyId: null, term: null, fit: null, ws: null,
    cwd: cwd || '',
    tokens: { input: 0, output: 0, cache_read: 0, cache_create: 0 },
    toolCounts: {},
    cardCount: 0,
    skillToolUseIds: new Set(),
    skillNamesById: new Map(),
    skillsLoaded: new Set(),
    skillsAvailable: new Set(),
    inventory: null,
    loaded: false,
    loading: false,
    turns: [],
    currentTurn: null,
    turnsRoot: document.createElement('div'),
    turnSeq: 0,
    activeTurnId: null,
    eventsByUuid: new Map(),
  };
  tabs.set(sessionId, tab);
  if (!activeTabId) switchTab(sessionId);
  persistTabs();
  return tab;
}

function switchTab(sessionId) {
  if (activeThread && activeThread.tab.sessionId !== sessionId) closeThread();
  for (const [id, tab] of tabs) {
    const isActive = id === sessionId;
    tab.mainEl.classList.toggle('active', isActive);
    tab.tabEl.classList.toggle('active', isActive);
  }
  activeTabId = sessionId;
  const tab = tabs.get(sessionId);
  if (tab) {
    sessEl.dataset.hasSession = '1';
    sessEl.textContent = tab.project.replace(/^-/, '').replace(/-/g, '/') + ' / ' + sessionId.slice(0, 8);
    renderSide(tab);
    if (!tab.loaded && !tab.loading) loadTabContent(tab);
  }
  persistTabs();
}

async function loadTabContent(tab) {
  if (tab.loaded || tab.loading) return;
  tab.loading = true;
  const loadingEl = document.createElement('div');
  loadingEl.className = 'tab-loading';
  loadingEl.textContent = t('sessions_loading');
  tab.turnsHost.appendChild(loadingEl);
  try {
    const res = await fetch('/session/' + encodeURIComponent(tab.sessionId));
    if (!res.ok) return;
    let count = 0;
    const handleLine = (line) => {
      if (!line.trim()) return;
      let j; try { j = JSON.parse(line); } catch { return; }
      if (j.__monitor === 'inventory') {
        tab.inventory = { memoryItems: j.memoryItems || [], claudeMd: j.claudeMd || [], cwd: j.cwd || '' };
        if (j.cwd) updateTabGroupLabel(tab.project, j.cwd);
        if (tab.sessionId === activeTabId) renderSide(tab);
        return;
      }
      renderEvent(tab, j);
      count++;
      if (count % 50 === 0) loadingEl.textContent = t('sessions_loading') + ' · ' + count.toLocaleString();
    };
    if (res.body && res.body.getReader) {
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf('\n')) >= 0) {
          handleLine(buf.slice(0, idx));
          buf = buf.slice(idx + 1);
        }
      }
      if (buf) handleLine(buf);
    } else {
      const text = await res.text();
      for (const line of text.split('\n')) handleLine(line);
    }
    tab.loaded = true;
    if (tab.sessionId === activeTabId) renderSide(tab);
  } catch {}
  finally {
    tab.loading = false;
    loadingEl.remove();
  }
}

function closeTab(sessionId) {
  const tab = tabs.get(sessionId);
  if (!tab) return;
  if (activeThread && activeThread.tab === tab) closeThread();
  // If the tab owned a PTY, close the WS and tell the server to kill the
  // child. We forget the map entry so refresh won't try to reattach.
  if (tab.ptyId) {
    try { tab.ws && tab.ws.close(); } catch {}
    try { fetch('/pty/' + tab.ptyId, { method: 'DELETE' }); } catch {}
    forgetPtyForTab(sessionId);
  }
  const grp = tab.tabEl.parentElement;
  tab.tabEl.remove();
  if (grp && grp.classList.contains('tab-group') && !grp.querySelector('.tab')) grp.remove();
  tab.mainEl.remove();
  tabs.delete(sessionId);
  persistTabs();
  if (activeTabId === sessionId) {
    activeTabId = null;
    const next = tabs.keys().next().value;
    if (next) switchTab(next);
    else {
      sessEl.textContent = t('no_session');
      delete sessEl.dataset.hasSession;
      renderSide(null);
      if (!document.getElementById('empty')) {
        const el = document.createElement('div');
        el.id = 'empty';
        el.dataset.i18n = 'waiting';
        el.textContent = t('waiting');
        mainContainer.appendChild(el);
      }
    }
  }
}

const esc = (s) => String(s ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const time = (iso) => { try { return new Date(iso).toLocaleTimeString('en-GB'); } catch { return ''; } };

function md(text) {
  let s = esc(text);
  const blocks = [];
  const stash = (html) => { blocks.push(html); return '\x00B' + (blocks.length - 1) + '\x00'; };

  // code fence
  s = s.replace(/\x60\x60\x60([a-zA-Z]*)\n?([\s\S]*?)\x60\x60\x60/g, (_, lang, code) =>
    stash('<pre class="md-code"><code>' + code.replace(/^\n|\n$/g, '') + '</code></pre>'));
  // inline code
  s = s.replace(/\x60([^\x60\n]+)\x60/g, (_, code) =>
    stash('<code class="md-inline">' + code + '</code>'));

  // GFM tables
  s = s.replace(/(^\|.+\|\s*$\n^\|[-:| ]+\|\s*$\n(?:^\|.+\|\s*$\n?)+)/gm, (m) => {
    const lines = m.trim().split('\n');
    const cells = (row) => row.split('|').slice(1, -1).map((c) => c.trim());
    const headers = cells(lines[0]);
    const rows = lines.slice(2).map(cells);
    return stash(
      '<table class="md-table"><thead><tr>' +
        headers.map((c) => '<th>' + c + '</th>').join('') +
        '</tr></thead><tbody>' +
        rows.map((r) => '<tr>' + r.map((c) => '<td>' + c + '</td>').join('') + '</tr>').join('') +
        '</tbody></table>'
    );
  });

  // headings
  s = s.replace(/^### (.+)$/gm, (_, t) => stash('<h3>' + t + '</h3>'));
  s = s.replace(/^## (.+)$/gm,  (_, t) => stash('<h2>' + t + '</h2>'));
  s = s.replace(/^# (.+)$/gm,   (_, t) => stash('<h1>' + t + '</h1>'));

  // hr
  s = s.replace(/^---+$/gm, () => stash('<hr>'));

  // lists (unordered)
  s = s.replace(/(?:^[-*] .+(?:\n|$))+/gm, (m) =>
    stash('<ul>' + m.trim().split('\n').map((l) => '<li>' + l.replace(/^[-*] /, '') + '</li>').join('') + '</ul>'));
  // lists (ordered)
  s = s.replace(/(?:^\d+\. .+(?:\n|$))+/gm, (m) =>
    stash('<ol>' + m.trim().split('\n').map((l) => '<li>' + l.replace(/^\d+\. /, '') + '</li>').join('') + '</ol>'));

  // bold + italic
  s = s.replace(/\*\*([^*\n]+?)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^*\w])\*([^*\n]+?)\*(?!\*)/g, '$1<em>$2</em>');

  // links
  s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');

  // restore — iterative, because stashed blocks (e.g. tables) may themselves contain placeholders
  for (let i = 0; i < 8 && s.indexOf('\x00B') !== -1; i++) {
    s = s.replace(/\x00B(\d+)\x00/g, (_, idx) => blocks[idx]);
  }
  return s;
}

function renderSide(tab) {
  const memEl = document.getElementById('ctx-memory');
  const clEl = document.getElementById('ctx-claude');
  const skEl = document.getElementById('ctx-skills');
  if (tab) {
    const tabCwd = (tab.inventory && tab.inventory.cwd) || '';
    info.innerHTML = [
      [t('project'), projectDisplayName(tab.project, tabCwd), tabCwd || tab.path || ''],
      [t('session_id'), tab.sessionId.slice(0, 8) + '…', tab.sessionId],
    ].map(([k, v, full]) => '<div class="stat"><span>' + esc(k) + '</span><span title="' + esc(full) + '">' + esc(v) + '</span></div>').join('');
    renderTokens(tab, { animate: false });
    toolsEl.innerHTML = Object.entries(tab.toolCounts).sort((a, b) => b[1] - a[1]).map(([k, v]) =>
      '<div class="stat tool-row tool-' + esc(k) + (pinnedTools.has(k) ? ' active' : '') + '" data-tool="' + esc(k) + '"><span>' + esc(k) + '</span><span>' + v + '</span></div>'
    ).join('') || '<div class="stat"><span style="color:#444">—</span><span></span></div>';

    const inv = tab.inventory || { memoryItems: [], claudeMd: [] };
    memEl.innerHTML = renderCtxBlock(t('ctx_memory'), inv.memoryItems.length,
      inv.memoryItems.map((m) => '<div class="ctx-item" title="' + esc(m.desc) + '"><span class="ctx-icon">·</span>' + esc(m.title) + '</div>').join(''));
    clEl.innerHTML = renderCtxBlock(t('ctx_claude'), inv.claudeMd.length,
      inv.claudeMd.map((c) => '<div class="ctx-item" title="' + esc(c.path) + '"><span class="ctx-icon">·</span>' + esc(c.scope) + '</div>').join(''));
    const skills = [...tab.skillsLoaded];
    skEl.innerHTML = renderCtxBlock(t('ctx_skills'), skills.length,
      skills.map((s) => '<div class="ctx-item"><span class="ctx-icon">·</span>' + esc(s) + '</div>').join(''));
  } else {
    info.innerHTML = '<div class="stat"><span>—</span><span></span></div>';
    tokensEl.innerHTML = '';
    toolsEl.innerHTML = '<div class="stat"><span style="color:#444">—</span><span></span></div>';
    memEl.innerHTML = ''; clEl.innerHTML = ''; skEl.innerHTML = '';
  }
  const hint = document.getElementById('pinHint');
  if (hint) hint.textContent = pinnedTools.size
    ? t('pin_hint_on', { tools: [...pinnedTools].join(', ') })
    : t('pin_hint_off');
}

function renderCtxBlock(label, count, body) {
  if (!count) return '';
  return '<div class="ctx-head"><span>' + esc(label) + '</span><span>' + count + '</span></div><div class="ctx-list">' + body + '</div>';
}

function shortPath(p) {
  if (!p) return '';
  const parts = String(p).split('/').filter(Boolean);
  if (parts.length <= 2) return p;
  return '…/' + parts.slice(-2).join('/');
}

function summarize(name, input) {
  if (input == null) return '';
  if (typeof input !== 'object') return String(input).slice(0, 200);
  const o = input;
  switch (name) {
    case 'Bash':       return o.description || String(o.command || '').split('\n')[0];
    case 'Read':       return shortPath(o.file_path) + (o.offset ? ' (L' + o.offset + '–' + (o.offset + (o.limit || 100)) + ')' : '');
    case 'Write':      return shortPath(o.file_path) + ' (' + String(o.content || '').length.toLocaleString() + ' chars)';
    case 'Edit':       return shortPath(o.file_path) + (o.replace_all ? ' [replace all]' : '');
    case 'Glob':       return (o.pattern || '') + (o.path ? ' in ' + o.path : '');
    case 'Grep':       return '"' + (o.pattern || '') + '"' + (o.path ? ' in ' + o.path : '');
    case 'WebFetch':   return o.url || '';
    case 'WebSearch':  return '"' + (o.query || '') + '"';
    case 'Skill':      return (o.skill || '') + (o.args ? ' ' + o.args : '');
    case 'Agent':      return (o.description || '') + (o.subagent_type ? ' [' + o.subagent_type + ']' : '');
    case 'Task':
    case 'TaskCreate': return o.description || ((o.tasks || []).length + ' task(s)');
    case 'TaskUpdate': return (o.taskId || '') + (o.status ? ' → ' + o.status : '');
    case 'TodoWrite':  return ((o.todos || []).length) + ' todos';
    case 'ToolSearch': return o.query || '';
    case 'AskUserQuestion': return ((o.questions || []).length) + ' question(s)';
    case 'ScheduleWakeup':  return '+' + (o.delaySeconds || 0) + 's — ' + (o.reason || '');
    case 'NotebookEdit':    return o.notebook_path || '';
    default: {
      const k = Object.keys(o)[0];
      return k ? k + ': ' + String(o[k]).slice(0, 100) : '';
    }
  }
}

function shortenResult(text) {
  let s = (text || '').trim();
  // Strip noisy boilerplate
  s = s.replace(/\s*\(file state is current[^)]*\)/i, '');
  let m = s.match(/^The file (.+?) has been (updated|created|written)/i);
  if (m) return '✓ ' + m[2] + ' · ' + shortPath(m[1]);
  m = s.match(/^File created successfully at:\s*(.+)$/im);
  if (m) return '✓ created · ' + shortPath(m[1].trim());
  const firstNonEmpty = s.split('\n').find((l) => l.trim()) || s;
  return firstNonEmpty.trim().slice(0, 200);
}

function addCard(tab, cls, name, body, ts, opts) {
  opts = opts || {};
  const div = document.createElement('div');
  div.className = 'card ' + cls;
  if (ts) div.dataset.ts = ts;
  let html = '';
  if (name) html += '<div class="name"><span>' + esc(name) + '</span><span class="time">' + esc(time(ts)) + '</span></div>';
  const limit = opts.markdown ? 12000 : 3000;
  const text = String(body ?? '');
  if (opts.markdown) html += '<div class="md">' + md(text.slice(0, limit)) + '</div>';
  else if (text) html += '<pre>' + esc(text.slice(0, limit)) + '</pre>';
  if (text.length > limit) html += '<div class="truncated">… ' + (text.length - limit).toLocaleString() + ' more chars</div>';
  if (opts.images && opts.images.length) {
    html += '<div class="card-images">';
    for (const src of opts.images) {
      html += '<span class="card-image-link" role="button" tabindex="0"><img class="card-image" src="' + esc(src) + '" alt="attached image" loading="lazy"></span>';
    }
    html += '</div>';
  }
  div.innerHTML = html;
  if (cls === 'user') div.dataset.userText = text.slice(0, 200);
  appendCard(tab, div);
}

function addCollapsibleCard(tab, cls, tag, summary, detail, ts, data) {
  const div = document.createElement('div');
  div.className = 'card collapsible ' + cls;
  if (ts) div.dataset.ts = ts;
  if (tag) div.dataset.tag = tag;
  if (summary) div.dataset.summary = String(summary).slice(0, 200);
  if (data) {
    if (data.sidechain) div.dataset.sidechain = '1';
    if (data.toolUseId) div.dataset.toolUseId = data.toolUseId;
    if (data.parentSkillId) div.dataset.parentSkillId = data.parentSkillId;
  }
  const limit = 8000;
  let detailInner;
  if (data && data.detailHtml) {
    detailInner = data.detailHtml;
  } else {
    const text = String(detail ?? '');
    const moreNote = text.length > limit ? '<div class="truncated">… ' + (text.length - limit).toLocaleString() + ' more chars</div>' : '';
    detailInner = '<pre>' + esc(text.slice(0, limit)) + '</pre>' + moreNote;
  }
  div.innerHTML =
    '<div class="name">' +
      '<div class="header-row">' +
        '<span class="toggle">▶</span>' +
        '<span class="tag">' + esc(tag) + '</span>' +
        '<span class="summary">' + esc(summary || '(no summary)') + '</span>' +
      '</div>' +
      '<span class="time">' + esc(time(ts)) + '</span>' +
    '</div>' +
    '<div class="detail">' + detailInner + '</div>';
  appendCard(tab, div);
}

function renderAskUserQuestionDetail(input) {
  const questions = (input && Array.isArray(input.questions)) ? input.questions : [];
  if (questions.length === 0) return '<pre>' + esc(JSON.stringify(input, null, 2)) + '</pre>';
  const parts = ['<div class="askq">'];
  questions.forEach((q, i) => {
    parts.push('<div class="askq-q">');
    parts.push('<div class="askq-q-head">');
    parts.push('<span class="askq-idx">Q' + (i + 1) + '</span>');
    if (q.header) parts.push('<span class="askq-chip">' + esc(q.header) + '</span>');
    parts.push('<span class="askq-mode">' + (q.multiSelect ? '다중 선택' : '단일 선택') + '</span>');
    parts.push('</div>');
    parts.push('<div class="askq-title">' + esc(q.question || '') + '</div>');
    const opts = Array.isArray(q.options) ? q.options : [];
    if (opts.length) {
      parts.push('<ul class="askq-opts">');
      opts.forEach((o) => {
        const label = String(o.label || '');
        const isRec = /\(Recommended\)\s*$/i.test(label) || /\(추천\)\s*$/i.test(label);
        const cleanLabel = isRec ? label.replace(/\s*\((Recommended|추천)\)\s*$/i, '') : label;
        parts.push('<li class="askq-opt' + (isRec ? ' askq-opt--rec' : '') + '">');
        parts.push('<div class="askq-opt-label">' + esc(cleanLabel));
        if (isRec) parts.push('<span class="askq-rec">추천</span>');
        parts.push('</div>');
        if (o.description) parts.push('<div class="askq-opt-desc">' + esc(o.description) + '</div>');
        parts.push('</li>');
      });
      parts.push('</ul>');
    }
    parts.push('</div>');
  });
  parts.push('</div>');
  return parts.join('');
}

function addSkillResultCard(tab, skillName, body, ts) {
  const div = document.createElement('div');
  div.className = 'card collapsible tool-result tool-result-skill';
  if (ts) div.dataset.ts = ts;
  if (skillName) div.dataset.skill = skillName;
  const limit = 12000;
  const text = String(body ?? '');
  const moreNote = text.length > limit ? '<div class="truncated">… ' + (text.length - limit).toLocaleString() + ' more chars</div>' : '';
  const summary = shortenResult(text);
  div.innerHTML =
    '<div class="name">' +
      '<div class="header-row">' +
        '<span class="toggle">▶</span>' +
        '<span class="tag">SKILL · ' + esc(skillName) + '</span>' +
        '<span class="summary">' + esc(summary || '') + '</span>' +
      '</div>' +
      '<span class="time">' + esc(time(ts)) + '</span>' +
    '</div>' +
    '<div class="detail"><div class="md">' + md(text.slice(0, limit)) + '</div>' + moreNote + '</div>';
  appendCard(tab, div);
}

function appendCard(tab, div) {
  tab.cardCount++;
  const countEl = tab.tabEl.querySelector('.tab-count');
  if (countEl) countEl.textContent = tab.cardCount;

  if (div.classList.contains('user')) {
    startNewTurn(tab, div);
    return;
  }
  const turn = ensureCurrentTurn(tab, div.dataset.ts);
  const isLive = activeThread && activeThread.turn === turn;
  const tBody = isLive ? document.getElementById('threadBody') : null;
  const tBodyAtBottom = isLive ? (tBody.scrollTop + tBody.clientHeight >= tBody.scrollHeight - 40) : false;

  turn.eventsEl.appendChild(div);
  if (div.dataset.ts) turn.lastTs = div.dataset.ts;
  trackEventInTurn(turn, div);
  renderTurnSummary(turn);
  if (!cardMatchesFilter(div)) div.style.display = 'none';
  updateUserCardVisibility(turn);

  if (isLive && tBodyAtBottom) tBody.scrollTop = tBody.scrollHeight;
}

function startNewTurn(tab, userCard) {
  const turnId = 'turn-' + (++tab.turnSeq);
  const eventsEl = document.createElement('div');
  eventsEl.className = 'turn-events';
  eventsEl.dataset.turnId = turnId;
  tab.turnsRoot.appendChild(eventsEl);

  const sumEl = document.createElement('div');
  sumEl.className = 'turn-summary';
  sumEl.innerHTML =
    '<div class="turn-meta">' +
      '<span class="turn-tool-count" hidden></span>' +
      '<span class="turn-skills" hidden></span>' +
      '<span class="turn-agents" hidden></span>' +
      '<span class="turn-duration" hidden></span>' +
    '</div>' +
    '<div class="turn-preview" hidden></div>';
  userCard.appendChild(sumEl);
  userCard.classList.add('turn-card');
  userCard.dataset.turnId = turnId;

  const turn = {
    id: turnId, tab,
    userCardEl: userCard, eventsEl, summaryEl: sumEl,
    toolCount: 0, skills: new Set(), agents: new Set(),
    skillChain: [],
    softSkills: new Set(),
    firstClaudeText: null,
    startTs: userCard.dataset.ts || null,
    lastTs: userCard.dataset.ts || null,
  };
  tab.turns.push(turn);
  tab.currentTurn = turn;

  userCard.addEventListener('click', (e) => {
    if (e.target.closest('a, button, input, textarea')) return;
    if (window.getSelection && window.getSelection().toString()) return;
    const chip = e.target.closest('.sk-step');
    if (chip) {
      e.stopPropagation();
      openThread(turn);
      const step = chip.dataset.step;
      const target = turn.eventsEl.querySelector('.tool-Skill[data-skill-step="' + step + '"]');
      if (target) {
        target.classList.add('open');
        target.classList.add('flash-highlight');
        requestAnimationFrame(() => {
          target.scrollIntoView({ block: 'center', behavior: 'smooth' });
          setTimeout(() => target.classList.remove('flash-highlight'), 1600);
        });
      }
      return;
    }
    openThread(turn);
  });

  const mainEl = tab.turnsHost;
  const atBottom = mainEl.scrollTop + mainEl.clientHeight >= mainEl.scrollHeight - 40;
  mainEl.appendChild(userCard);
  if (atBottom && tab.sessionId === activeTabId) mainEl.scrollTop = mainEl.scrollHeight;
}

function ensureCurrentTurn(tab, ts) {
  if (tab.currentTurn) return tab.currentTurn;
  const userCard = document.createElement('div');
  userCard.className = 'card user prelude';
  if (ts) userCard.dataset.ts = ts;
  userCard.innerHTML =
    '<div class="name"><span></span><span class="time">' + esc(time(ts || '')) + '</span></div>' +
    '<pre>' + esc(t('session_preview')) + '</pre>';
  startNewTurn(tab, userCard);
  return tab.currentTurn;
}

function trackEventInTurn(turn, card) {
  const cls = card.classList;
  if (cls.contains('tool') && !cls.contains('tool-result')) {
    turn.toolCount++;
    const tag = card.dataset.tag || '';
    const sumText = card.dataset.summary || '';
    if (tag === 'Skill') {
      const skill = (sumText.split(/\s/)[0] || '').trim();
      if (skill) {
        turn.skills.add(skill);
        const step = turn.skillChain.length + 1;
        card.dataset.skillStep = String(step);
        turn.skillChain.push({
          name: skill,
          side: !!card.dataset.sidechain,
          step,
        });
      }
    } else if (tag === 'Agent' || tag === 'Task') {
      const m = sumText.match(/\[([^\]]+)\]/);
      turn.agents.add(m ? m[1] : tag);
    }
  } else if (cls.contains('tool-result-skill') && card.dataset.skill) {
    turn.skills.add(card.dataset.skill);
  }
  if (cls.contains('text')) {
    const mdEl = card.querySelector('.md');
    if (mdEl) {
      const txt = (mdEl.textContent || '').trim();
      if (txt && !turn.firstClaudeText) turn.firstClaudeText = txt.slice(0, 280);
      if (txt && turn.tab.skillsAvailable.size > 0) {
        for (const name of turn.tab.skillsAvailable) {
          if (turn.softSkills.has(name)) continue;
          if (turn.skills.has(name)) continue;
          const re = new RegExp('(^|[^a-zA-Z0-9_-])' + name + '(?![a-zA-Z0-9_-])');
          if (re.test(txt)) turn.softSkills.add(name);
        }
      }
    }
  }
}

function formatDuration(sec) {
  if (sec < 60) return Math.round(sec) + 's';
  const m = Math.floor(sec / 60);
  const s = Math.round(sec - m * 60);
  return m + 'm ' + (s ? s + 's' : '');
}

function renderTurnSummary(turn) {
  const meta = turn.summaryEl.querySelector('.turn-meta');
  const tcEl = meta.querySelector('.turn-tool-count');
  const skEl = meta.querySelector('.turn-skills');
  const agEl = meta.querySelector('.turn-agents');
  const duEl = meta.querySelector('.turn-duration');
  const prEl = turn.summaryEl.querySelector('.turn-preview');

  if (turn.toolCount > 0) {
    tcEl.textContent = t('turn_tools_n').replace('{n}', turn.toolCount);
    tcEl.hidden = false;
  } else tcEl.hidden = true;

  const hasChain = turn.skillChain.length > 0;
  const hasSoft = turn.softSkills.size > 0;
  if (hasChain || hasSoft) {
    const parts = [];
    if (hasChain) {
      const order = [];
      const map = new Map();
      for (const s of turn.skillChain) {
        const key = s.name + (s.side ? '|side' : '');
        if (!map.has(key)) { map.set(key, { name: s.name, side: s.side, count: 0, firstStep: s.step }); order.push(key); }
        map.get(key).count++;
      }
      for (const key of order) {
        const e = map.get(key);
        const title = esc(e.name) + (e.count > 1 ? ' ×' + e.count : '') + (e.side ? ' (sidechain)' : '');
        parts.push('<span class="sk-step' + (e.side ? ' sk-side' : '') + '" data-step="' + e.firstStep + '" title="' + title + '">' +
          (e.side ? '<span class="sk-depth">↳</span>' : '') +
          esc(e.name) +
          (e.count > 1 ? '<span class="sk-count">×' + e.count + '</span>' : '') +
        '</span>');
      }
    }
    if (hasSoft) {
      const chainNames = new Set(turn.skillChain.map((s) => s.name));
      for (const name of turn.softSkills) {
        if (chainNames.has(name)) continue;
        parts.push('<span class="sk-step sk-soft" title="' + esc(name) + ' (description-based)">' + esc(name) + '</span>');
      }
    }
    skEl.innerHTML = '🧩 ' + parts.join('');
    skEl.hidden = parts.length === 0;
  } else skEl.hidden = true;

  if (turn.agents.size > 0) {
    agEl.textContent = '🤖 ' + [...turn.agents].join(', ');
    agEl.hidden = false;
  } else agEl.hidden = true;

  duEl.hidden = true;
  if (turn.startTs && turn.lastTs && turn.startTs !== turn.lastTs) {
    try {
      const dur = (new Date(turn.lastTs) - new Date(turn.startTs)) / 1000;
      if (dur >= 1) { duEl.textContent = '⏱ ' + formatDuration(dur); duEl.hidden = false; }
    } catch {}
  }

  if (turn.firstClaudeText) {
    prEl.textContent = turn.firstClaudeText;
    prEl.hidden = false;
  } else prEl.hidden = true;
}

function updateUserCardVisibility(turn) {
  turn.userCardEl.style.display = turnMatchesFilter(turn) ? '' : 'none';
}

function turnMatchesFilter(turn) {
  if (pinnedTools.size > 0 || currentFilter === 'tools' || currentFilter === 'skill') {
    for (const c of turn.eventsEl.children) {
      if (cardMatchesFilter(c)) return true;
    }
    return false;
  }
  return true;
}

let activeThread = null;
const threadBodyEl = document.getElementById('threadBody');
const threadSubEl = document.getElementById('threadSub');

function openThread(turn) {
  if (activeThread && activeThread.turn === turn) return;
  closeThread();
  threadBodyEl.innerHTML = '';
  threadBodyEl.appendChild(turn.eventsEl);
  const userText = turn.userCardEl.dataset.userText || '';
  threadSubEl.textContent = userText || (turn.userCardEl.classList.contains('prelude') ? t('session_preview') : '');
  document.documentElement.classList.add('thread-open');
  turn.userCardEl.classList.add('turn-active');
  activeThread = { tab: turn.tab, turn };
  turn.tab.activeTurnId = turn.id;
  requestAnimationFrame(() => { threadBodyEl.scrollTop = threadBodyEl.scrollHeight; });
}

function closeThread() {
  if (activeThread) {
    activeThread.tab.turnsRoot.appendChild(activeThread.turn.eventsEl);
    activeThread.turn.userCardEl.classList.remove('turn-active');
    activeThread.tab.activeTurnId = null;
    activeThread = null;
  }
  threadBodyEl.innerHTML = '';
  threadSubEl.textContent = '';
  document.documentElement.classList.remove('thread-open');
}

document.getElementById('threadClose').addEventListener('click', closeThread);

document.body.addEventListener('click', (e) => {
  if (e.target.tagName === 'A') return;
  const card = e.target.closest('.card.collapsible');
  if (!card) return;
  if (!card.closest('#threadBody, #mainContainer')) return;
  if (window.getSelection && window.getSelection().toString()) return;
  card.classList.toggle('open');
});

document.getElementById('clearBtn').addEventListener('click', () => {
  const tab = getActiveTab();
  if (!tab) return;
  if (activeThread && activeThread.tab === tab) closeThread();
  tab.turnsHost.innerHTML = '';
  tab.turnsRoot.innerHTML = '';
  tab.turns = [];
  tab.currentTurn = null;
  tab.cardCount = 0;
  const countEl = tab.tabEl.querySelector('.tab-count');
  if (countEl) countEl.textContent = '0';
});

const langSel = document.getElementById('lang');
langSel.value = lang;
langSel.addEventListener('change', (e) => {
  lang = e.target.value;
  localStorage.setItem('cm-lang', lang);
  applyStaticI18n();
  sideToggleBtn.title = sideOpen ? t('side_hide') : t('side_show');
  if (!sessEl.dataset.hasSession) sessEl.textContent = t('no_session');
  if (connEl.dataset.state) connEl.textContent = t(connEl.dataset.state);
  renderSide(getActiveTab());
});

let sideOpen = localStorage.getItem('cm-side-open') !== 'false';
const sideToggleBtn = document.getElementById('sideToggle');
function applySide() {
  document.documentElement.classList.toggle('side-closed', !sideOpen);
  sideToggleBtn.title = sideOpen ? t('side_hide') : t('side_show');
}
sideToggleBtn.addEventListener('click', () => {
  sideOpen = !sideOpen;
  localStorage.setItem('cm-side-open', String(sideOpen));
  applySide();
});
applySide();

(function setupColResizers() {
  const conf = {
    side:   { varName: '--side-w',   key: 'cm-side-w',   def: 280, min: 200, max: 600, sign: +1 },
    thread: { varName: '--thread-w', key: 'cm-thread-w', def: 460, min: 280, max: 900, sign: -1 },
  };
  for (const [which, c] of Object.entries(conf)) {
    const saved = parseInt(localStorage.getItem(c.key) || '', 10);
    if (Number.isFinite(saved) && saved >= c.min && saved <= c.max) {
      document.documentElement.style.setProperty(c.varName, saved + 'px');
      c.def = saved;
    }
  }
  document.querySelectorAll('.col-resizer').forEach((handle) => {
    const c = conf[handle.dataset.resize];
    if (!c) return;
    handle.addEventListener('mousedown', (e) => {
      e.preventDefault();
      const startX = e.clientX;
      const startW = c.def;
      handle.classList.add('dragging');
      document.documentElement.classList.add('dragging-col');
      function onMove(ev) {
        const dx = (ev.clientX - startX) * c.sign;
        const w = Math.max(c.min, Math.min(c.max, startW + dx));
        document.documentElement.style.setProperty(c.varName, w + 'px');
        c._cur = w;
      }
      function onUp() {
        handle.classList.remove('dragging');
        document.documentElement.classList.remove('dragging-col');
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
        if (c._cur != null) { c.def = c._cur; localStorage.setItem(c.key, String(c._cur)); }
      }
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
    });
    handle.addEventListener('dblclick', () => {
      const reset = handle.dataset.resize === 'side' ? 280 : 460;
      document.documentElement.style.setProperty(c.varName, reset + 'px');
      c.def = reset;
      localStorage.setItem(c.key, String(reset));
    });
  });
})();

let theme = localStorage.getItem('cm-theme') || 'dark';
const themeSel = document.getElementById('theme');
themeSel.value = theme;
function applyTheme() { document.documentElement.classList.toggle('light', theme === 'light'); }
themeSel.addEventListener('change', (e) => {
  theme = e.target.value;
  localStorage.setItem('cm-theme', theme);
  applyTheme();
});
applyTheme();

// initial setup
applyStaticI18n();
sessEl.textContent = t('no_session');
connEl.dataset.state = 'connecting';
connEl.textContent = t('connecting');

document.getElementById('filter').addEventListener('change', (e) => {
  currentFilter = e.target.value;
  applyFilterAll();
});

toolsEl.addEventListener('click', (e) => {
  const row = e.target.closest('[data-tool]');
  if (!row) return;
  const tn = row.dataset.tool;
  if (pinnedTools.has(tn)) pinnedTools.delete(tn);
  else pinnedTools.add(tn);
  renderSide(getActiveTab());
  applyFilterAll();
});

function setConnState(state) {
  connEl.dataset.state = state;
  connEl.textContent = t(state);
  connEl.classList.remove('live', 'reconnecting');
  if (state === 'live' || state === 'reconnecting') connEl.classList.add(state);
}
function processLine(text) {
  let j;
  try { j = JSON.parse(text); } catch { return; }
  if (j.__monitor === 'config') {
    if (typeof j.activeMs === 'number') {
      clientActiveMs = j.activeMs;
      const sel = document.getElementById('window');
      const opt = [...sel.options].find((o) => Number(o.value) === j.activeMs);
      if (opt) sel.value = opt.value;
    }
    return;
  }
  if (j.__monitor === 'session') {
    ensureTab(j.session, j.project, j.path, j.cwd);
    tryMatchPendingPtyToSession(j.session, j.cwd);
    return;
  }
  if (j.__monitor === 'session-removed') {
    const tab = tabs.get(j.session);
    if (!tab) return;
    if (j.session === activeTabId) {
      tab.tabEl.classList.add('stale');
    } else {
      closeTab(j.session);
    }
    return;
  }
  if (j.__monitor === 'inventory') {
    const tab = tabs.get(j.session);
    if (tab) {
      tab.inventory = { memoryItems: j.memoryItems || [], claudeMd: j.claudeMd || [], cwd: j.cwd || '' };
      if (j.cwd) updateTabGroupLabel(tab.project, j.cwd);
      if (j.session === activeTabId) renderSide(tab);
    }
    return;
  }

  const sid = j.sessionId;
  if (!sid) return;
  const tab = tabs.get(sid);
  if (!tab) return;
  if (!tab.loaded) return;
  renderEvent(tab, j);
  if (sid === activeTabId) renderSide(tab);
}

function renderEvent(tab, j) {
  const ts = j.timestamp;
  if (j.uuid) {
    tab.eventsByUuid.set(j.uuid, {
      type: j.type,
      parentUuid: j.parentUuid,
      isMeta: !!j.isMeta,
      sourceToolUseID: j.sourceToolUseID || j.sourceToolUseId,
    });
  }
  if (j.type === 'user') {
    const srcId = j.sourceToolUseID || j.sourceToolUseId;
    if (j.isMeta && srcId && tab.skillToolUseIds.has(srcId)) {
      const skillName = tab.skillNamesById.get(srcId) || '';
      const c = j.message?.content;
      let text = '';
      if (Array.isArray(c)) text = c.filter((i) => i.type === 'text').map((i) => i.text).join('\n');
      else if (typeof c === 'string') text = c;
      addSkillResultCard(tab, skillName, text, ts);
    } else if (j.isMeta && !srcId) {
      // System-generated meta messages (image source markers, local-command caveats) — skip
      return;
    } else {
      const c = j.message?.content;
      if (Array.isArray(c)) {
        const userTexts = [];
        const userImages = [];
        for (const item of c) {
          if (item.type === 'tool_result') {
            let body = item.content;
            if (Array.isArray(body)) body = body.map((x) => x.text ?? JSON.stringify(x)).join('\n');
            else if (typeof body !== 'string') body = JSON.stringify(body);
            addCollapsibleCard(tab, 'tool-result', t('label_result'), shortenResult(body), body, ts);
          } else if (item.type === 'text') {
            userTexts.push(item.text);
          } else if (item.type === 'image' && item.source) {
            const s = item.source;
            if (s.type === 'base64' && s.data) {
              userImages.push('data:' + (s.media_type || 'image/png') + ';base64,' + s.data);
            } else if (s.type === 'url' && s.url) {
              userImages.push(s.url);
            }
          }
        }
        if (userTexts.length > 0 || userImages.length > 0) {
          addCard(tab, 'user', t('label_user'), userTexts.join('\n\n'), ts, { images: userImages });
        }
      } else if (typeof c === 'string') {
        addCard(tab, 'user', t('label_user'), c, ts);
      }
    }
  } else if (j.type === 'attachment' && j.attachment?.type === 'skill_listing') {
    const content = String(j.attachment.content || '');
    const re = /^[\t ]*-[\t ]+([a-zA-Z][a-zA-Z0-9_-]*)[\t ]*:/gm;
    let m;
    let changed = false;
    while ((m = re.exec(content)) !== null) {
      const name = m[1];
      if (!tab.skillsAvailable.has(name)) {
        tab.skillsAvailable.add(name);
        tab.skillsLoaded.add(name);
        changed = true;
      }
    }
    if (changed && tab.sessionId === activeTabId) renderSide(tab);
  } else if (j.type === 'assistant' && j.message?.content) {
    for (const c of j.message.content) {
      if (c.type === 'text') addCard(tab, 'text', t('label_claude'), c.text, ts, { markdown: true });
      else if (c.type === 'thinking') { /* skipped: redacted by Anthropic */ }
      else if (c.type === 'tool_use') {
        tab.toolCounts[c.name] = (tab.toolCounts[c.name] || 0) + 1;
        const summary = summarize(c.name, c.input);
        const detail = typeof c.input === 'string' ? c.input : JSON.stringify(c.input, null, 2);
        const cardData = { sidechain: !!j.isSidechain, toolUseId: c.id || null };
        if (c.name === 'AskUserQuestion' && c.input && typeof c.input === 'object') {
          cardData.detailHtml = renderAskUserQuestionDetail(c.input);
        }
        addCollapsibleCard(tab, 'tool tool-' + c.name, c.name, summary, detail, ts, cardData);
        if (c.name === 'Skill' && c.id) {
          tab.skillToolUseIds.add(c.id);
          const skillName = (c.input && c.input.skill) || '';
          tab.skillNamesById.set(c.id, skillName);
          if (skillName) tab.skillsLoaded.add(skillName);
        }
      }
    }
    const u = j.message.usage;
    if (u) {
      tab.tokens.input += u.input_tokens || 0;
      tab.tokens.output += u.output_tokens || 0;
      tab.tokens.cache_read += u.cache_read_input_tokens || 0;
      tab.tokens.cache_create += u.cache_creation_input_tokens || 0;
      if (tab.sessionId === activeTabId) renderTokens(tab, { animate: true });
    }
  }
}
try {
  const savedTabs = JSON.parse(localStorage.getItem('cm-open-tabs') || '[]');
  const savedActive = localStorage.getItem('cm-active-tab');
  for (const s of savedTabs) {
    if (s && s.session && s.project && s.path) {
      ensureTab(s.session, s.project, s.path, s.cwd || '');
    }
  }
  if (savedActive && tabs.has(savedActive)) switchTab(savedActive);
} catch {}

// Reattach to PTYs that survived the page reload (server keeps them alive).
(async () => {
  let map;
  try { map = loadPtyMap(); } catch { return; }
  if (!map.size) return;
  let alive;
  try {
    const res = await fetch('/pty');
    if (!res.ok) return;
    alive = new Map((await res.json()).map((p) => [p.id, p]));
  } catch { return; }
  for (const [sessionId, { ptyId, cwd }] of map) {
    if (!alive.has(ptyId) || alive.get(ptyId).exited) {
      forgetPtyForTab(sessionId);
      continue;
    }
    let tab = tabs.get(sessionId);
    if (!tab) {
      // Tab not in saved tabs (placeholder, or session that fell out of window).
      // Re-create a placeholder so the user sees the terminal back.
      const project = (cwd || '').split('/').filter(Boolean).join('-') || 'pty';
      ensureTab(sessionId, project, '', cwd);
      tab = tabs.get(sessionId);
      if (tab) tab.isPtyPlaceholder = sessionId.startsWith('pty:');
    }
    if (tab) attachPtyToTab(tab, ptyId, cwd);
    if (!activeTabId) switchTab(sessionId);
  }
})();

const es = new EventSource('/events');
es.onopen = () => setConnState('live');
es.onerror = () => setConnState('reconnecting');
es.onmessage = (e) => processLine(e.data);

let clientActiveMs = parseInt(localStorage.getItem('cm-active-window') || '', 10);
if (!Number.isFinite(clientActiveMs)) clientActiveMs = 30 * 60 * 1000;
const windowSel = document.getElementById('window');
windowSel.value = String(clientActiveMs);
windowSel.addEventListener('change', async (e) => {
  const v = parseInt(e.target.value, 10);
  if (!Number.isFinite(v)) return;
  localStorage.setItem('cm-active-window', String(v));
  try { await fetch('/config?activeMs=' + v); } catch {}
});
fetch('/config?activeMs=' + clientActiveMs).catch(() => {});

const lightboxEl = document.getElementById('lightbox');
const lightboxImg = document.getElementById('lightboxImg');
function openLightbox(src) { lightboxImg.src = src; lightboxEl.classList.add('open'); }
function closeLightbox() { lightboxEl.classList.remove('open'); lightboxImg.removeAttribute('src'); }
lightboxEl.addEventListener('click', closeLightbox);
document.addEventListener('click', (e) => {
  const link = e.target.closest('.card-image-link');
  if (link) { e.preventDefault(); e.stopPropagation(); const img = link.querySelector('img'); if (img) openLightbox(img.src); }
}, true);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && lightboxEl.classList.contains('open')) closeLightbox(); });

const settingsBackdrop = document.getElementById('settingsBackdrop');
const settingsCloseBtn = document.getElementById('settingsClose');
const settingsBtn = document.getElementById('settingsBtn');
function setSettings(open) { settingsBackdrop.classList.toggle('open', open); }
settingsBtn.addEventListener('click', () => setSettings(true));
settingsCloseBtn.addEventListener('click', () => setSettings(false));
settingsBackdrop.addEventListener('click', (e) => { if (e.target === settingsBackdrop) setSettings(false); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && settingsBackdrop.classList.contains('open')) setSettings(false); });

// ── Confirm modal (replaces native confirm) ─────────────────────────────────
const confirmBackdrop = document.getElementById('confirmBackdrop');
const confirmTitleEl  = document.getElementById('confirmTitle');
const confirmBodyEl   = document.getElementById('confirmBody');
const confirmCloseBtn = document.getElementById('confirmClose');
const confirmCancelBtn= document.getElementById('confirmCancel');
const confirmOkBtn    = document.getElementById('confirmOk');
let confirmResolve = null;
function confirmDialog({ title, bodyHtml, okText, cancelText, okClass }) {
  confirmTitleEl.textContent = title || '확인';
  confirmBodyEl.innerHTML = bodyHtml || '';
  confirmOkBtn.textContent = okText || '진행';
  confirmCancelBtn.textContent = cancelText || '취소';
  confirmOkBtn.className = 'btn ' + (okClass || 'btn--primary');
  confirmBackdrop.classList.add('open');
  return new Promise((resolve) => { confirmResolve = resolve; });
}
function closeConfirm(result) {
  confirmBackdrop.classList.remove('open');
  const r = confirmResolve; confirmResolve = null;
  if (r) r(result);
}
confirmOkBtn.addEventListener('click', () => closeConfirm(true));
confirmCancelBtn.addEventListener('click', () => closeConfirm(false));
confirmCloseBtn.addEventListener('click', () => closeConfirm(false));
confirmBackdrop.addEventListener('click', (e) => { if (e.target === confirmBackdrop) closeConfirm(false); });
document.addEventListener('keydown', (e) => {
  if (!confirmBackdrop.classList.contains('open')) return;
  if (e.key === 'Escape') closeConfirm(false);
  else if (e.key === 'Enter') closeConfirm(true);
});

// ── Spawn modal + PTY tracking ──────────────────────────────────────────────
const spawnBackdrop = document.getElementById('spawnBackdrop');
const spawnCloseBtn = document.getElementById('spawnClose');
const spawnBtn = document.getElementById('spawnBtn');
const spawnCwdInput = document.getElementById('spawnCwd');
const spawnRecentEl = document.getElementById('spawnRecent');
const spawnConfirmBtn = document.getElementById('spawnConfirm');
const spawnCancelBtn = document.getElementById('spawnCancel');

// Pending PTYs keyed by normalized cwd → ptyId. When a JSONL session with the
// same cwd arrives, we attach the PTY to that tab.
const pendingPtysByCwd = new Map();
function normCwd(p) { return String(p || '').trim().replace(/\/+$/, '') || ''; }

// Persist sessionId → ptyId in localStorage so a page reload can reattach to
// the still-running PTY (server keeps PTY alive across reconnects).
function loadPtyMap() {
  try { return new Map(Object.entries(JSON.parse(localStorage.getItem('cm-pty-map') || '{}'))); }
  catch { return new Map(); }
}
function savePtyMap(map) {
  try { localStorage.setItem('cm-pty-map', JSON.stringify(Object.fromEntries(map))); } catch {}
}
function rememberPtyForTab(sessionId, ptyId, cwd) {
  const map = loadPtyMap();
  map.set(sessionId, { ptyId, cwd: cwd || '' });
  savePtyMap(map);
}
function forgetPtyForTab(sessionId) {
  const map = loadPtyMap();
  if (map.delete(sessionId)) savePtyMap(map);
}
function rekeyPtyForTab(fromSessionId, toSessionId) {
  const map = loadPtyMap();
  const e = map.get(fromSessionId);
  if (!e) return;
  map.delete(fromSessionId);
  map.set(toSessionId, e);
  savePtyMap(map);
}

function setSpawnModal(open) {
  spawnBackdrop.classList.toggle('open', open);
  if (open) {
    const active = getActiveTab();
    const activeCwd = (active && (active.cwd || (active.inventory && active.inventory.cwd))) || '';
    spawnCwdInput.value = activeCwd || lastSpawnCwd() || (collectKnownCwds()[0] || '');
    renderRecentCwds();
    setTimeout(() => { spawnCwdInput.focus(); spawnCwdInput.select(); }, 0);
  }
}
function lastSpawnCwd() { try { return localStorage.getItem('cm-last-spawn-cwd') || ''; } catch { return ''; } }
function rememberSpawnCwd(cwd) {
  try {
    localStorage.setItem('cm-last-spawn-cwd', cwd);
    const list = JSON.parse(localStorage.getItem('cm-recent-cwds') || '[]').filter((x) => x !== cwd);
    list.unshift(cwd);
    localStorage.setItem('cm-recent-cwds', JSON.stringify(list.slice(0, 10)));
  } catch {}
}
function recentSavedCwds() {
  try { return JSON.parse(localStorage.getItem('cm-recent-cwds') || '[]'); } catch { return []; }
}
function collectKnownCwds() {
  const set = new Set(recentSavedCwds());
  for (const tab of tabs.values()) if (tab.cwd) set.add(tab.cwd);
  return [...set];
}
function renderRecentCwds() {
  spawnRecentEl.innerHTML = '';
  for (const cwd of collectKnownCwds().slice(0, 12)) {
    const b = document.createElement('button');
    b.textContent = cwd;
    b.title = cwd;
    b.addEventListener('click', () => { spawnCwdInput.value = cwd; });
    spawnRecentEl.appendChild(b);
  }
}

spawnBtn.addEventListener('click', () => setSpawnModal(true));
spawnCloseBtn.addEventListener('click', () => setSpawnModal(false));
spawnCancelBtn.addEventListener('click', () => setSpawnModal(false));
spawnBackdrop.addEventListener('click', (e) => { if (e.target === spawnBackdrop) setSpawnModal(false); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && spawnBackdrop.classList.contains('open')) setSpawnModal(false); });
spawnCwdInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); spawnConfirmBtn.click(); } });

// Per-tab pty pane height (px). Stored across reloads.
function loadPtyHeight(sessionId) {
  try { const m = JSON.parse(localStorage.getItem('cm-pty-heights') || '{}'); return Number(m[sessionId]) || 0; } catch { return 0; }
}
function savePtyHeight(sessionId, h) {
  try {
    const m = JSON.parse(localStorage.getItem('cm-pty-heights') || '{}');
    m[sessionId] = h;
    localStorage.setItem('cm-pty-heights', JSON.stringify(m));
  } catch {}
}

function applyPtyHeight(pane, ptyHost, sessionId) {
  const saved = loadPtyHeight(sessionId);
  if (saved > 0) pane.style.setProperty('--pty-h', saved + 'px');
}

function wirePtyResizer(pane, ptyHost, resizer, sessionId) {
  applyPtyHeight(pane, ptyHost, sessionId);
  resizer.addEventListener('mousedown', (ev) => {
    ev.preventDefault();
    resizer.classList.add('dragging');
    const paneRect = pane.getBoundingClientRect();
    const startY = ev.clientY;
    const startH = ptyHost.getBoundingClientRect().height;
    function onMove(e) {
      const dy = e.clientY - startY;
      let next = startH - dy;
      const minH = 120;
      const maxH = paneRect.height - 60;
      next = Math.max(minH, Math.min(maxH, next));
      pane.style.setProperty('--pty-h', next + 'px');
    }
    function onUp() {
      resizer.classList.remove('dragging');
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      const finalH = ptyHost.getBoundingClientRect().height;
      savePtyHeight(sessionId, Math.round(finalH));
      const tab = tabs.get(sessionId);
      if (tab && tab.fit) { try { tab.fit.fit(); } catch {} }
    }
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
}

async function spawnAndAttachInline(tab, cwd) {
  if (!tab || !cwd) return null;
  // Resume from the tab's existing session if it's a real (non-placeholder) one,
  // so the new claude inherits prior conversation context. --fork-session keeps
  // its writes in a new JSONL so the original session isn't mutated.
  const resume = tab.sessionId && !tab.sessionId.startsWith('pty:') ? tab.sessionId : null;
  // Make sure historical events are processed so tab.tokens reflects the real
  // session size before we decide whether to warn.
  if (resume && !tab.loaded) {
    try { await loadTabContent(tab); } catch {}
  }
  // Warn before resuming a long session. Resume cost ≈ entire conversation
  // is re-sent and re-cached in the new claude process (the original process's
  // cache_read doesn't transfer). output + cache_create is the proxy for
  // "how much the new process has to ingest".
  if (resume) {
    const tk = tab.tokens || {};
    const out = tk.output || 0;
    const inTok = tk.input || 0;
    const cr = tk.cache_read || 0;
    const cc = tk.cache_create || 0;
    // Best proxy: cache_create alone ≈ unique conversation tokens accumulated.
    // output is already part of the cached prompt body, so adding it would
    // double-count. cache_read is a hit counter, not transferable to a new process.
    const resendEstimate = cc;
    const heavy = resendEstimate >= 10000 || (tab.cardCount || 0) >= 30;
    if (heavy) {
      const fmt = (n) => n.toLocaleString();
      const bodyHtml =
        '<div class="resume-cost">' +
          '<div class="intro">이전 대화를 들고 새 터미널을 엽니다. 터미널 자체는 즉시 뜨고, <strong>첫 메시지를 보낼 때</strong> 히스토리가 모델에 전송되며 cache_create로 청구됩니다.</div>' +
          '<div class="section-label">이 세션 누적</div>' +
          '<div class="stats">' +
            '<span class="k">카드</span><span class="v">' + (tab.cardCount || 0) + '</span>' +
            '<span class="k">output</span><span class="v muted">' + fmt(out) + '</span>' +
            '<span class="k">input (비캐시)</span><span class="v muted">' + fmt(inTok) + '</span>' +
            '<span class="k">cache_read</span><span class="v muted">' + fmt(cr) + '</span>' +
            '<span class="k">cache_create</span><span class="v">' + fmt(cc) + '</span>' +
            '<div class="row-note">cache_create ≈ 실제 대화 길이. cache_read는 옛 프로세스 캐시 히트 누적으로 새 프로세스에선 무효.</div>' +
          '</div>' +
          '<div class="section-label">resume 추정 비용 (첫 메시지)</div>' +
          '<div class="estimate"><span class="num">≈ ' + fmt(resendEstimate) + '</span><span class="label">토큰 cache_create</span></div>' +
          '<div class="note">새 claude가 옛 대화 위에서 이어 작업. <code>--fork-session</code>으로 별개 JSONL에 기록되니 원본은 안 건드림.</div>' +
        '</div>';
      const ok = await confirmDialog({ title: '터미널 열기 — 비용 확인', bodyHtml, okText: '진행', cancelText: '취소' });
      if (!ok) return null;
    }
  }
  try {
    const res = await fetch('/pty', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cwd, cols: 100, rows: 30, resume }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      alert('Spawn failed: ' + (err.message || res.statusText));
      return null;
    }
    const { id } = await res.json();
    rememberSpawnCwd(normCwd(cwd));
    await attachPtyToTab(tab, id, cwd);
    return id;
  } catch (err) {
    alert('Spawn failed: ' + (err.message || err));
    return null;
  }
}

async function spawnInCwd(cwd) {
  if (!cwd) return null;
  try {
    const res = await fetch('/pty', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cwd, cols: 100, rows: 30 }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      alert('Spawn failed: ' + (err.message || res.statusText));
      return null;
    }
    const { id } = await res.json();
    const ncwd = normCwd(cwd);
    rememberSpawnCwd(ncwd);
    pendingPtysByCwd.set(ncwd, id);
    const placeholderId = 'pty:' + id;
    ensureTab(placeholderId, cwd.split('/').filter(Boolean).join('-') || 'pty', '', cwd);
    const tab = tabs.get(placeholderId);
    if (tab) {
      tab.cwd = cwd;
      tab.isPtyPlaceholder = true;
      attachPtyToTab(tab, id, cwd);
      switchTab(placeholderId);
    }
    return id;
  } catch (err) {
    alert('Spawn failed: ' + (err.message || err));
    return null;
  }
}

spawnConfirmBtn.addEventListener('click', async () => {
  const cwd = (spawnCwdInput.value || '').trim();
  if (!cwd) { spawnCwdInput.focus(); return; }
  spawnConfirmBtn.disabled = true;
  try {
    const id = await spawnInCwd(cwd);
    if (id) setSpawnModal(false);
  } finally {
    spawnConfirmBtn.disabled = false;
  }
});

// xterm.js dynamic imports (deferred — only loaded the first time a PTY is opened)
let xtermModulePromise = null;
function loadXtermModule() {
  if (!xtermModulePromise) {
    xtermModulePromise = Promise.all([
      import('/assets/xterm.mjs'),
      import('/assets/xterm-fit.mjs'),
    ]).then(([t, f]) => ({ Terminal: t.Terminal, FitAddon: f.FitAddon }));
  }
  return xtermModulePromise;
}

async function attachPtyToTab(tab, ptyId, cwd) {
  if (tab.ptyId) return; // already attached
  tab.ptyId = ptyId;
  tab.ptyCwd = cwd || tab.cwd || '';
  rememberPtyForTab(tab.sessionId, ptyId, tab.ptyCwd);
  tab.mainEl.classList.add('has-pty');
  // Mark the tab visually
  const label = tab.tabEl.querySelector('.tab-label');
  if (label && !label.previousSibling?.classList?.contains('tab-pty-mark')) {
    const mark = document.createElement('span');
    mark.className = 'tab-pty-mark';
    mark.textContent = '⬢';
    mark.title = 'attached PTY';
    label.parentNode.insertBefore(mark, label);
  }

  const ptyBar = document.createElement('div');
  ptyBar.className = 'pty-bar';
  ptyBar.innerHTML =
    '<span class="pty-status" data-pty-status>live</span>' +
    '<span class="pty-cwd" title="' + esc(tab.ptyCwd) + '">' + esc(tab.ptyCwd) + '</span>' +
    '<button data-act="respawn" hidden>다시 띄우기</button>' +
    '<button data-act="kill" title="Kill terminal">×</button>';
  const termEl = document.createElement('div');
  termEl.className = 'pty-term';
  tab.ptyHost.innerHTML = '';
  tab.ptyHost.appendChild(ptyBar);
  tab.ptyHost.appendChild(termEl);

  ptyBar.querySelector('[data-act="kill"]').addEventListener('click', async () => {
    try { await fetch('/pty/' + ptyId, { method: 'DELETE' }); } catch {}
  });
  // Click the bar (not its buttons) to toggle full-screen for this tab pane.
  ptyBar.addEventListener('click', (e) => {
    if (e.target.closest('button')) return;
    tab.mainEl.classList.toggle('pty-fullscreen');
    requestAnimationFrame(() => { try { tab.fit && tab.fit.fit(); } catch {} });
  });
  ptyBar.querySelector('[data-act="respawn"]').addEventListener('click', async () => {
    const cwdCopy = tab.ptyCwd || '';
    // Tear down current xterm + state for this tab
    try { tab.ws && tab.ws.close(); } catch {}
    try { tab.term && tab.term.dispose(); } catch {}
    forgetPtyForTab(tab.sessionId);
    tab.ptyId = null; tab.term = null; tab.fit = null; tab.ws = null;
    tab.mainEl.classList.remove('has-pty');
    tab.ptyHost.innerHTML = '';
    if (cwdCopy) await spawnAndAttachInline(tab, cwdCopy);
  });

  let mod;
  try { mod = await loadXtermModule(); }
  catch (err) {
    termEl.innerHTML = '<div style="color:#fca5a5;padding:12px;font-family:ui-monospace,Menlo,monospace;font-size:12px">xterm load failed: ' + esc(String(err)) + '</div>';
    return;
  }
  const { Terminal, FitAddon } = mod;
  const term = new Terminal({
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
    fontSize: 13,
    theme: { background: '#0c0d0f' },
    cursorBlink: true,
    convertEol: true,
    scrollback: 5000,
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  // Wait until termEl has a non-zero size before opening — xterm gives up if the
  // container is 0×0 at open() time.
  await new Promise((resolve) => {
    const tryOnce = () => {
      if (termEl.clientWidth > 0 && termEl.clientHeight > 0) resolve();
      else requestAnimationFrame(tryOnce);
    };
    tryOnce();
  });
  term.open(termEl);
  try { fit.fit(); } catch {}
  term.focus();
  // Wheel events forward to tmux through xterm default mouse handling.
  // The backend session has mouse=on so tmux interprets wheel as enter-copy
  // mode and scrolls. claude (alt-screen TUI) never sees the event.
  tab.term = term;
  tab.fit = fit;

  const wsProto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(wsProto + '//' + location.host + '/pty/' + ptyId);
  tab.ws = ws;
  ws.addEventListener('open', () => {
    ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
  });
  ws.addEventListener('message', (ev) => {
    let msg; try { msg = JSON.parse(ev.data); } catch { return; }
    if (msg.type === 'data') term.write(msg.data);
    else if (msg.type === 'exit') {
      const st = ptyBar.querySelector('[data-pty-status]');
      if (st) { st.textContent = 'exited (' + (msg.exitCode ?? '?') + ')'; st.classList.add('exited'); }
      forgetPtyForTab(tab.sessionId);
    }
  });
  ws.addEventListener('close', () => {
    const st = ptyBar.querySelector('[data-pty-status]');
    if (st && !st.classList.contains('exited')) { st.textContent = 'disconnected'; st.classList.add('exited'); }
    const re = ptyBar.querySelector('[data-act="respawn"]');
    if (re) re.hidden = false;
  });
  term.onData((data) => { if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'input', data })); });
  term.onResize(({ cols, rows }) => {
    if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'resize', cols, rows }));
  });

  // Refit on resize
  const ro = new ResizeObserver(() => { try { fit.fit(); } catch {} });
  ro.observe(termEl);
}

function tryMatchPendingPtyToSession(sessionId, cwd) {
  const ncwd = normCwd(cwd);
  if (!ncwd) return;
  const ptyId = pendingPtysByCwd.get(ncwd);
  if (!ptyId) return;
  pendingPtysByCwd.delete(ncwd);
  // Move the PTY from the placeholder tab onto the real session tab, then drop
  // the placeholder so the user sees a single unified tab.
  const placeholderId = 'pty:' + ptyId;
  const realTab = tabs.get(sessionId);
  const placeholderTab = tabs.get(placeholderId);
  if (!realTab) return;
  if (placeholderTab && placeholderTab !== realTab) {
    const wasActive = activeTabId === placeholderId;
    // Move PTY DOM nodes (xterm, bar) into real tab's ptyHost — preserves
    // xterm renderer state, WS bindings, and event listeners.
    realTab.ptyHost.innerHTML = '';
    while (placeholderTab.ptyHost.firstChild) {
      realTab.ptyHost.appendChild(placeholderTab.ptyHost.firstChild);
    }
    realTab.mainEl.classList.add('has-pty');
    placeholderTab.mainEl.classList.remove('has-pty');
    realTab.ptyId = placeholderTab.ptyId;
    realTab.term = placeholderTab.term;
    realTab.fit = placeholderTab.fit;
    realTab.ws = placeholderTab.ws;
    realTab.ptyCwd = placeholderTab.ptyCwd;
    // Mirror the ⬢ marker
    const label = realTab.tabEl.querySelector('.tab-label');
    if (label && !label.previousSibling?.classList?.contains('tab-pty-mark')) {
      const mark = document.createElement('span');
      mark.className = 'tab-pty-mark';
      mark.textContent = '⬢';
      mark.title = 'attached PTY';
      label.parentNode.insertBefore(mark, label);
    }
    // Reparent xterm DOM (term.open() works for re-mount and re-attaches renderer)
    const newContainer = realTab.ptyHost.querySelector('.pty-term');
    if (newContainer && realTab.term) {
      try { realTab.term.open(newContainer); } catch {}
      requestAnimationFrame(() => { try { realTab.fit.fit(); } catch {} });
    }
    rekeyPtyForTab(placeholderId, realTab.sessionId);
    // Clear the placeholder's PTY refs so closeTab below doesn't try to kill
    // the PTY we just transferred.
    placeholderTab.ptyId = null;
    placeholderTab.term = null;
    placeholderTab.fit = null;
    placeholderTab.ws = null;
    // Switch first, then drop placeholder — avoids closeTab's auto-pick falling
    // back to some unrelated tab.
    if (wasActive) switchTab(realTab.sessionId);
    closeTab(placeholderId);
  } else {
    attachPtyToTab(realTab, ptyId, cwd);
  }
}

const drawerEl = document.getElementById('drawer');
const drawerBackdropEl = document.getElementById('drawerBackdrop');
const drawerListEl = document.getElementById('drawerList');
const drawerSearchInput = document.getElementById('drawerSearch');
const sessionDataMap = new Map();
let lastSessionList = [];

drawerSearchInput.addEventListener('input', () => {
  if (lastSessionList.length) renderSessionList(lastSessionList);
});

function setDrawer(open) {
  drawerEl.classList.toggle('open', open);
  drawerBackdropEl.classList.toggle('open', open);
  if (open) refreshSessionList();
}

document.getElementById('sessionsBtn').addEventListener('click', () => setDrawer(true));
document.getElementById('drawerClose').addEventListener('click', () => setDrawer(false));
drawerBackdropEl.addEventListener('click', () => setDrawer(false));
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && drawerEl.classList.contains('open')) setDrawer(false); });

async function refreshSessionList() {
  drawerListEl.innerHTML = '<div class="drawer-loading">' + esc(t('sessions_loading')) + '</div>';
  try {
    const res = await fetch('/sessions');
    const list = await res.json();
    lastSessionList = list;
    renderSessionList(list);
  } catch {
    drawerListEl.innerHTML = '<div class="drawer-loading">' + esc(t('sessions_failed')) + '</div>';
  }
}

function dateBucket(mtime) {
  const today = new Date(); today.setHours(0,0,0,0);
  const tToday = today.getTime();
  const tYest = tToday - 86400000;
  const tWeek = tToday - 6 * 86400000;
  if (mtime >= tToday) return 'today';
  if (mtime >= tYest) return 'yesterday';
  if (mtime >= tWeek) return 'thisweek';
  return 'older';
}

function renderSessionList(list) {
  sessionDataMap.clear();
  list.forEach((s) => sessionDataMap.set(s.session, s));

  const q = (drawerSearchInput.value || '').trim().toLowerCase();
  const filtered = q
    ? list.filter((s) => s.project.toLowerCase().includes(q) || s.session.toLowerCase().includes(q))
    : list;

  const byProject = new Map();
  for (const s of filtered) {
    if (!byProject.has(s.project)) byProject.set(s.project, []);
    byProject.get(s.project).push(s);
  }
  const isPinned = (proj) => localStorage.getItem('cm-drawer-pin-' + proj) === '1';
  const sortedProjects = [...byProject.entries()].sort((a, b) => {
    const pa = isPinned(a[0]), pb = isPinned(b[0]);
    if (pa !== pb) return pa ? -1 : 1;
    return b[1][0].mtime - a[1][0].mtime;
  });

  const now = Date.now();
  const html = [];
  const shortenCwd = (cwd) => cwd.replace(/^\/Users\/[^/]+/, '~').replace(/^\/home\/[^/]+/, '~');
  for (const [proj, items] of sortedProjects) {
    const cwd = items[0].cwd || '';
    const projName = cwd ? shortenCwd(cwd) : (proj.replace(/^-/, '').split('-').filter(Boolean).slice(-2).join('/') || proj);
    const collapsed = localStorage.getItem('cm-drawer-proj-' + proj) !== '0';
    const pinned = isPinned(proj);
    html.push('<div class="drawer-project' + (collapsed ? ' collapsed' : '') + (pinned ? ' pinned' : '') + '" data-proj="' + esc(proj) + '">');
    html.push('<div class="drawer-project-head">');
    html.push('<button type="button" class="drawer-project-name" data-toggle-proj="' + esc(proj) + '" title="' + esc(cwd || proj) + '" aria-expanded="' + (!collapsed) + '">');
    html.push('<span class="chevron" aria-hidden="true">▾</span>');
    html.push('<span class="drawer-project-label">' + esc(projName) + '</span>');
    html.push('<span class="drawer-project-count">' + items.length + '</span>');
    html.push('</button>');
    html.push('<button type="button" class="drawer-project-pin" data-pin-proj="' + esc(proj) + '" title="' + (pinned ? 'Unpin' : 'Pin to top') + '" aria-pressed="' + pinned + '">');
    html.push('<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>');
    html.push('</button>');
    html.push('</div>');
    html.push('<div class="drawer-project-body">');
    const grouped = { today: [], yesterday: [], thisweek: [], older: [] };
    for (const s of items) grouped[dateBucket(s.mtime)].push(s);
    for (const key of ['today', 'yesterday', 'thisweek', 'older']) {
      const arr = grouped[key];
      if (!arr.length) continue;
      html.push('<div class="drawer-date-group">');
      html.push('<div class="drawer-date-label">' + esc(t('date_' + key)) + ' · ' + arr.length + '</div>');
      for (const s of arr) {
        const isLive = (now - s.mtime) < clientActiveMs;
        const inTabs = tabs.has(s.session);
        const timeStr = new Date(s.mtime).toLocaleString();
        const lineLabel = (s.lines || 0).toLocaleString() + ' ' + t('msg_count');
        html.push('<div class="drawer-session' + (inTabs ? ' in-tabs' : '') + '" data-session="' + esc(s.session) + '" title="' + esc(s.session) + '">');
        html.push('<span class="session-dot' + (isLive ? ' live' : '') + '"></span>');
        html.push('<span class="drawer-session-id">' + esc(s.session.slice(0, 8)) + '</span>');
        html.push('<span class="drawer-session-meta">' + esc(lineLabel) + '</span>');
        html.push('<span class="drawer-session-time">' + esc(timeStr) + '</span>');
        html.push('<button class="drawer-session-del" data-del="' + esc(s.session) + '" title="Delete">×</button>');
        html.push('</div>');
      }
      html.push('</div>');
    }
    html.push('</div>');
    html.push('</div>');
  }
  if (!html.length) html.push('<div class="drawer-empty">' + esc(t(q ? 'drawer_no_match' : 'sessions_empty')) + '</div>');
  drawerListEl.innerHTML = html.join('');
}

drawerListEl.addEventListener('click', async (e) => {
  const pinBtn = e.target.closest('[data-pin-proj]');
  if (pinBtn) {
    e.stopPropagation();
    const proj = pinBtn.dataset.pinProj;
    const wasPinned = localStorage.getItem('cm-drawer-pin-' + proj) === '1';
    if (wasPinned) localStorage.removeItem('cm-drawer-pin-' + proj);
    else localStorage.setItem('cm-drawer-pin-' + proj, '1');
    renderSessionList(lastSessionList);
    return;
  }
  const toggleBtn = e.target.closest('[data-toggle-proj]');
  if (toggleBtn) {
    e.stopPropagation();
    const proj = toggleBtn.dataset.toggleProj;
    const projEl = toggleBtn.closest('.drawer-project');
    const willCollapse = !projEl.classList.contains('collapsed');
    projEl.classList.toggle('collapsed', willCollapse);
    toggleBtn.setAttribute('aria-expanded', String(!willCollapse));
    localStorage.setItem('cm-drawer-proj-' + proj, willCollapse ? '1' : '0');
    return;
  }
  const delBtn = e.target.closest('[data-del]');
  if (delBtn) {
    e.stopPropagation();
    const sid = delBtn.dataset.del;
    if (!confirm(t('delete_confirm'))) return;
    try {
      const r = await fetch('/session/' + encodeURIComponent(sid), { method: 'DELETE' });
      if (!r.ok) throw new Error('bad status');
      lastSessionList = lastSessionList.filter((s) => s.session !== sid);
      renderSessionList(lastSessionList);
      if (tabs.has(sid)) closeTab(sid);
    } catch { alert(t('delete_failed')); }
    return;
  }
  const row = e.target.closest('.drawer-session');
  if (!row) return;
  const sd = sessionDataMap.get(row.dataset.session);
  if (!sd) return;
  if (!tabs.has(sd.session)) {
    processLine(JSON.stringify({ __monitor: 'session', session: sd.session, project: sd.project, path: sd.path, mtime: sd.mtime, cwd: sd.cwd || '' }));
  }
  switchTab(sd.session);
  setDrawer(false);
});
</script></body></html>`;

// ────────────────────────────────────────────────────────────────────────────
// PTY backend — spawn `claude` per browser tab, bridge stdio over WebSocket.
// Observation (JSONL tail) handles the cards; PTY handles direct input/output.
// ────────────────────────────────────────────────────────────────────────────
const ptys = new Map(); // ptyId -> { proc, cwd, cols, rows, buffer, sockets:Set, exited }
const PTY_BUFFER_MAX = 200_000; // bytes of recent output kept for reconnects

function findClaudeBin() {
  if (process.env.CC_MONITOR_CLAUDE_BIN) return process.env.CC_MONITOR_CLAUDE_BIN;
  // Walk PATH first — covers nvm-style installs, ~/.local/bin, etc.
  const pathEntries = (process.env.PATH || '').split(path.delimiter);
  for (const dir of pathEntries) {
    if (!dir) continue;
    const fp = path.join(dir, 'claude');
    try { fs.accessSync(fp, fs.constants.X_OK); return fp; } catch {}
  }
  // Common install locations as fallback.
  const candidates = [
    path.join(os.homedir(), '.local', 'bin', 'claude'),
    path.join(os.homedir(), '.claude', 'local', 'claude'),
    '/opt/homebrew/bin/claude',
    '/usr/local/bin/claude',
  ];
  for (const c of candidates) { try { fs.accessSync(c, fs.constants.X_OK); return c; } catch {} }
  return 'claude';
}

function findTmuxBin() {
  if (process.env.CC_MONITOR_TMUX_BIN) return process.env.CC_MONITOR_TMUX_BIN;
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    const fp = path.join(dir, 'tmux');
    try { fs.accessSync(fp, fs.constants.X_OK); return fp; } catch {}
  }
  for (const c of ['/opt/homebrew/bin/tmux', '/usr/local/bin/tmux', '/usr/bin/tmux']) {
    try { fs.accessSync(c, fs.constants.X_OK); return c; } catch {}
  }
  return null;
}

const TMUX_BIN = findTmuxBin();
const TMUX_PREFIX = 'cm-';
const tmuxName = (ptyId) => TMUX_PREFIX + ptyId;

// Spawns a tmux session running `claude`, then returns a local PTY attached
// to that tmux session. The session outlives this monitor process, so when
// monitor restarts the tmux session (and claude) survive.
async function spawnClaudePty(ptyId, cwd, cols, rows, resumeSessionId) {
  if (!TMUX_BIN) {
    throw new Error('tmux not found. Install: `brew install tmux` (macOS) or `apt install tmux` (linux).');
  }
  if (process.platform === 'darwin' && process.arch === 'x64' && os.cpus()[0]?.model?.match(/Apple/i)) {
    throw new Error(
      'Detected x64 Node on Apple Silicon. node-pty requires native architecture. ' +
      'Switch to arm64 Node (e.g. `nvm install 20 && nvm use 20` on an arm64 shell).'
    );
  }
  const claudeBin = findClaudeBin();
  const name = tmuxName(ptyId);
  const safeCwd = cwd && fs.existsSync(cwd) ? cwd : (process.env.HOME || process.cwd());
  const newArgs = [
    'new-session', '-d', '-s', name,
    '-x', String(cols || 100), '-y', String(rows || 30),
    '-c', safeCwd,
    '--', claudeBin,
  ];
  if (resumeSessionId) newArgs.push('--resume', String(resumeSessionId), '--fork-session');
  await execFileP(TMUX_BIN, newArgs);
  // Hide tmux status bar so the terminal looks like a plain shell
  await execFileP(TMUX_BIN, ['set-option', '-t', name, 'status', 'off']).catch(() => {});
  await execFileP(TMUX_BIN, ['set-option', '-t', name, 'history-limit', '50000']).catch(() => {});
  // Follow the attached client's size so the inner pane resizes with the browser.
  await execFileP(TMUX_BIN, ['set-option', '-t', name, 'window-size', 'latest']).catch(() => {});
  await execFileP(TMUX_BIN, ['set-window-option', '-t', name, 'aggressive-resize', 'on']).catch(() => {});
  // Mouse on: wheel enters copy-mode + scrolls. Right scroll past last line exits.
  await execFileP(TMUX_BIN, ['set-option', '-t', name, 'mouse', 'on']).catch(() => {});
  return attachLocalToTmux(name, cols, rows, safeCwd);
}

async function attachLocalToTmux(sessionName, cols, rows, cwd) {
  const pty = await getNodePty();
  const env = { ...process.env, TERM: 'xterm-256color' };
  return pty.spawn(TMUX_BIN, ['attach-session', '-t', sessionName], {
    name: 'xterm-256color',
    cwd: cwd || process.env.HOME || '/tmp',
    cols: cols || 100,
    rows: rows || 30,
    env,
  });
}

async function killTmuxSession(ptyId) {
  if (!TMUX_BIN) return;
  await execFileP(TMUX_BIN, ['kill-session', '-t', tmuxName(ptyId)]).catch(() => {});
}

async function listTmuxClaudeSessions() {
  if (!TMUX_BIN) return [];
  try {
    const { stdout } = await execFileP(TMUX_BIN, [
      'list-sessions', '-F',
      '#{session_name}|#{session_path}|#{window_width}|#{window_height}',
    ]);
    return stdout.split('\n').filter(Boolean).filter((l) => l.startsWith(TMUX_PREFIX)).map((line) => {
      const [name, sessionPath, w, h] = line.split('|');
      return {
        ptyId: name.slice(TMUX_PREFIX.length),
        name,
        cwd: sessionPath || '',
        cols: parseInt(w, 10) || 100,
        rows: parseInt(h, 10) || 30,
      };
    });
  } catch { return []; }
}

function registerPtyEntry({ id, proc, cwd, cols, rows }) {
  const pty = { proc, cwd, cols, rows, buffer: '', sockets: new Set(), exited: false };
  ptys.set(id, pty);
  proc.onData((data) => {
    pty.buffer = (pty.buffer + data).slice(-PTY_BUFFER_MAX);
    broadcastPty(pty, { type: 'data', data });
  });
  proc.onExit(({ exitCode, signal }) => {
    pty.exited = true;
    broadcastPty(pty, { type: 'exit', exitCode, signal });
    setTimeout(() => {
      for (const ws of pty.sockets) { try { ws.close(); } catch {} }
      ptys.delete(id);
    }, 5_000);
  });
  return pty;
}

async function rehydrateFromTmux() {
  if (!TMUX_BIN) return;
  const sessions = await listTmuxClaudeSessions();
  for (const s of sessions) {
    if (ptys.has(s.ptyId)) continue;
    try {
      const proc = await attachLocalToTmux(s.name, s.cols, s.rows, s.cwd);
      registerPtyEntry({ id: s.ptyId, proc, cwd: s.cwd, cols: s.cols, rows: s.rows });
      console.log('rehydrated tmux session:', s.name);
    } catch (err) {
      console.error('rehydrate failed for', s.name, err.message);
    }
  }
}

function attachSocket(pty, ws) {
  pty.sockets.add(ws);
  // Replay buffered output so the reconnecting tab catches up.
  if (pty.buffer && pty.buffer.length) {
    try { ws.send(JSON.stringify({ type: 'data', data: pty.buffer })); } catch {}
  }
  ws.on('message', (raw) => {
    let msg; try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (msg.type === 'input' && typeof msg.data === 'string') {
      try { pty.proc.write(msg.data); } catch {}
    } else if (msg.type === 'resize' && Number.isFinite(msg.cols) && Number.isFinite(msg.rows)) {
      pty.cols = msg.cols; pty.rows = msg.rows;
      try { pty.proc.resize(msg.cols, msg.rows); } catch {}
    }
  });
  ws.on('close', () => pty.sockets.delete(ws));
  ws.on('error', () => pty.sockets.delete(ws));
}

function broadcastPty(pty, frame) {
  const payload = JSON.stringify(frame);
  for (const ws of pty.sockets) {
    if (ws.readyState === 1) { try { ws.send(payload); } catch {} }
  }
}

async function readJsonBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let len = 0; const chunks = [];
    req.on('data', (c) => { len += c.length; if (len > limit) { req.destroy(); reject(new Error('body too large')); return; } chunks.push(c); });
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf-8') || '{}')); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

function serveStatic(req, res, fp, contentType) {
  try {
    const st = fs.statSync(fp);
    res.writeHead(200, {
      'Content-Type': contentType,
      'Content-Length': st.size,
      'Cache-Control': 'public, max-age=86400',
    });
    fs.createReadStream(fp).pipe(res);
  } catch {
    res.writeHead(404); res.end('not found');
  }
}

const XTERM_ASSETS = {
  '/assets/xterm.css':       { fp: path.join(__dirname, 'node_modules/@xterm/xterm/css/xterm.css'),               type: 'text/css; charset=utf-8' },
  '/assets/xterm.mjs':       { fp: path.join(__dirname, 'node_modules/@xterm/xterm/lib/xterm.mjs'),               type: 'application/javascript; charset=utf-8' },
  '/assets/xterm-fit.mjs':   { fp: path.join(__dirname, 'node_modules/@xterm/addon-fit/lib/addon-fit.mjs'),       type: 'application/javascript; charset=utf-8' },
};

const server = http.createServer((req, res) => {
  if (req.url === '/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.write(': connected\n\n');
    clients.add(res);
    sendTo(res, JSON.stringify({ __monitor: 'config', activeMs }));
    sendInitialState(res);
    req.on('close', () => clients.delete(res));
    return;
  }
  if (req.url.startsWith('/config')) {
    const u = new URL(req.url, 'http://x');
    const raw = u.searchParams.get('activeMs');
    if (raw !== null) {
      const v = parseInt(raw, 10);
      if (Number.isFinite(v) && v >= ACTIVE_MS_MIN && v <= ACTIVE_MS_MAX) {
        activeMs = v;
        const cutoff = Date.now() - activeMs;
        for (const [sid, w] of [...watched]) {
          if (w.lastMtime < cutoff) {
            watched.delete(sid);
            for (const c of clients) sendTo(c, JSON.stringify({ __monitor: 'session-removed', session: sid }));
          }
        }
        for (const c of clients) sendTo(c, JSON.stringify({ __monitor: 'config', activeMs }));
        poll();
      } else {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'invalid', min: ACTIVE_MS_MIN, max: ACTIVE_MS_MAX }));
        return;
      }
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ activeMs }));
    return;
  }
  if (req.url === '/health') {
    res.writeHead(200); res.end('ok'); return;
  }
  if (req.url === '/sessions') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(listAllSessions()));
    return;
  }
  if (req.url.startsWith('/session/')) {
    const id = decodeURIComponent(req.url.slice('/session/'.length).split('?')[0]);
    const found = listAllSessions().find((x) => x.session === id);
    if (!found) { res.writeHead(404); res.end('not found'); return; }
    if (req.method === 'DELETE') {
      try { fs.unlinkSync(found.path); } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: String(err.message || err) }));
        return;
      }
      lineCountCache.delete(found.path);
      if (watched.has(id)) {
        watched.delete(id);
        for (const c of clients) sendTo(c, JSON.stringify({ __monitor: 'session-removed', session: id }));
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    let snapshotSize = 0;
    try { snapshotSize = fs.statSync(found.path).size; } catch {}
    const existing = watched.get(id);
    if (!existing) {
      watched.set(id, { path: found.path, project: found.project, lastSize: snapshotSize, lastMtime: found.mtime });
    } else if (existing.lastSize < snapshotSize) {
      existing.lastSize = snapshotSize;
    }
    res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8' });
    const inv = buildInventory(found.project, found.path);
    res.write(JSON.stringify({ __monitor: 'inventory', session: id, ...inv }) + '\n');
    if (snapshotSize > 0) {
      fs.createReadStream(found.path, { start: 0, end: snapshotSize - 1 }).pipe(res);
    } else {
      res.end();
    }
    return;
  }
  if (XTERM_ASSETS[req.url]) {
    const a = XTERM_ASSETS[req.url];
    serveStatic(req, res, a.fp, a.type);
    return;
  }
  if (req.url === '/pty' && req.method === 'GET') {
    const list = [...ptys.entries()].map(([id, p]) => ({
      id, cwd: p.cwd, cols: p.cols, rows: p.rows, exited: !!p.exited, attached: p.sockets.size > 0,
    }));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(list));
    return;
  }
  if (req.url === '/pty' && req.method === 'POST') {
    readJsonBody(req).then(async (body) => {
      const cwd = body.cwd || process.env.HOME || process.cwd();
      const cols = Number.isFinite(body.cols) ? body.cols : 100;
      const rows = Number.isFinite(body.rows) ? body.rows : 30;
      const resume = typeof body.resume === 'string' ? body.resume : null;
      const id = crypto.randomUUID();
      let proc;
      try { proc = await spawnClaudePty(id, cwd, cols, rows, resume); }
      catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'spawn_failed', message: String(err.message || err) }));
        return;
      }
      registerPtyEntry({ id, proc, cwd, cols, rows });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id, cwd, cols, rows }));
    }).catch((err) => {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'bad_body', message: String(err.message || err) }));
    });
    return;
  }
  if (req.url.startsWith('/pty/') && req.method === 'DELETE') {
    const id = req.url.slice('/pty/'.length);
    const pty = ptys.get(id);
    if (!pty) { res.writeHead(404); res.end('not found'); return; }
    // Tell tmux to kill the session — local PTY (attach) will exit naturally.
    killTmuxSession(id).finally(() => {
      try { pty.proc.kill(); } catch {}
    });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(HTML);
});

const wss = new WebSocketServer({ noServer: true });
server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://localhost');
  const m = url.pathname.match(/^\/pty\/([0-9a-f-]{36})$/i);
  if (!m) { socket.destroy(); return; }
  const pty = ptys.get(m[1]);
  if (!pty) { socket.write('HTTP/1.1 404 Not Found\r\n\r\n'); socket.destroy(); return; }
  wss.handleUpgrade(req, socket, head, (ws) => attachSocket(pty, ws));
});

server.listen(PORT, () => {
  console.log(`Claude Monitor → http://localhost:${PORT}`);
  rehydrateFromTmux().catch((err) => console.error('rehydrate error:', err));
});

// Shutdown: detach from tmux locally; tmux sessions stay alive so claude
// survives until explicitly killed via DELETE /pty/:id.
function detachAllPtys() {
  for (const pty of ptys.values()) { try { pty.proc.kill(); } catch {} }
}
process.on('SIGINT', () => { detachAllPtys(); process.exit(0); });
process.on('SIGTERM', () => { detachAllPtys(); process.exit(0); });
