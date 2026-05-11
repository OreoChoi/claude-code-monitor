#!/usr/bin/env node
// Claude Code Session Monitor
// Watches ~/.claude/projects/*/<session>.jsonl, streams to http://localhost:7777

import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import os from 'node:os';

const PORT = 7777;
const ROOT = path.join(os.homedir(), '.claude', 'projects');

if (!fs.existsSync(ROOT)) {
  console.error(`Not found: ${ROOT}`);
  process.exit(1);
}

const clients = new Set();
const send = (line) => { for (const r of clients) r.write(`data: ${line}\n\n`); };
const sendTo = (res, line) => res.write(`data: ${line}\n\n`);

const ACTIVE_MS = 30 * 60 * 1000;          // 30 min window
const TAIL_LINES = 50;
const watched = new Map();                 // sessionId -> { path, project, lastSize, lastMtime }

function sendSessionMeta(target, session, project, path, mtime) {
  const meta = JSON.stringify({ __monitor: 'session', session, project, path, mtime });
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
    const head = fs.readFileSync(jsonlPath, 'utf-8').split('\n').slice(0, 5);
    for (const ln of head) {
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
    for (const ln of tailLines(w.path, TAIL_LINES)) sendTo(res, ln);
  }
}

function findActiveSessions() {
  const cutoff = Date.now() - ACTIVE_MS;
  const acc = [];
  for (const proj of fs.readdirSync(ROOT)) {
    const dir = path.join(ROOT, proj);
    let st; try { st = fs.statSync(dir); } catch { continue; }
    if (!st.isDirectory()) continue;
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.jsonl')) continue;
      const fp = path.join(dir, f);
      try {
        const m = fs.statSync(fp).mtimeMs;
        if (m < cutoff) continue;
        acc.push({ path: fp, project: proj, session: f.replace('.jsonl', ''), mtime: m });
      } catch {}
    }
  }
  acc.sort((a, b) => b.mtime - a.mtime);
  return acc;
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
  const active = findActiveSessions();
  // 1. register new sessions
  for (const a of active) {
    if (!watched.has(a.session)) {
      const initialSize = (() => { try { return fs.statSync(a.path).size; } catch { return 0; } })();
      watched.set(a.session, { path: a.path, project: a.project, lastSize: initialSize, lastMtime: a.mtime });
      sendSessionMeta(null, a.session, a.project, a.path, a.mtime);
      sendInventory(null, a.session, a.project, a.path);
      for (const ln of tailLines(a.path, TAIL_LINES)) send(ln);
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
<style>
  * { box-sizing: border-box; }
  body { font: 13px -apple-system, BlinkMacSystemFont, sans-serif; margin: 0; background: #1a1a1a; color: #e0e0e0; display: grid; grid-template-columns: 1fr 320px; grid-template-rows: auto auto 1fr; height: 100vh; overflow: hidden; }
  #tabs { grid-column: 1 / -1; display: flex; gap: 4px; padding: 4px 12px 0; background: #0f0f0f; border-bottom: 1px solid #2a2a2a; overflow-x: auto; align-items: end; }
  #tabs:empty::before { content: attr(data-empty); color: #555; font-size: 11px; padding: 6px 4px; }
  .tab { background: #1a1a1a; color: #aaa; border: 1px solid #2a2a2a; border-bottom: none; padding: 5px 10px; border-radius: 5px 5px 0 0; cursor: pointer; font-size: 11px; font-family: ui-monospace, monospace; display: inline-flex; align-items: center; gap: 6px; white-space: nowrap; max-width: 240px; }
  .tab:hover { background: #222; color: #ddd; }
  .tab.active { background: #1a1a1a; color: #fff; border-color: #4af; border-bottom: 1px solid #1a1a1a; margin-bottom: -1px; }
  .tab .tab-label { overflow: hidden; text-overflow: ellipsis; }
  .tab .tab-count { color: #555; font-size: 10px; }
  .tab.active .tab-count { color: #4af; }
  .tab .tab-close { color: #555; padding: 0 2px; border-radius: 3px; }
  .tab .tab-close:hover { color: #f66; background: #2a1414; }
  .tab-pane { overflow-y: auto; padding: 12px 16px; height: 100%; display: none; }
  .tab-pane.active { display: block; }
  header { grid-column: 1 / -1; padding: 8px 14px; background: #0f0f0f; border-bottom: 1px solid #2a2a2a; display: flex; align-items: center; gap: 14px; }
  header h1 { font-size: 13px; margin: 0; color: #ddd; font-weight: 600; }
  header .meta { color: #888; font-size: 11px; font-family: ui-monospace, monospace; }
  header .dot { width: 8px; height: 8px; border-radius: 50%; background: #6c6; animation: pulse 1.5s infinite; }
  @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.3; } }
  #mainContainer { overflow: hidden; }
  #side { overflow-y: auto; padding: 12px 14px; border-left: 1px solid #2a2a2a; background: #151515; }
  .ctx-block { margin-bottom: 10px; }
  .ctx-block:empty { display: none; }
  .ctx-head { color: #888; font-size: 10px; text-transform: uppercase; letter-spacing: .04em; margin: 2px 0 4px; display: flex; justify-content: space-between; }
  .ctx-head span:last-child { color: #555; }
  .ctx-list { display: flex; flex-direction: column; gap: 2px; }
  .ctx-item { font-size: 11px; color: #bbb; font-family: ui-monospace, monospace; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .ctx-item .ctx-icon { color: #555; margin-right: 4px; }
  .card { padding: 6px 11px; margin: 4px 0; border-radius: 6px; border-left: 3px solid #555; background: #242424; box-shadow: 0 1px 2px rgba(0,0,0,0.25); }
  .card.user { border-color: #4af; background: #1a2533; }
  .turn-divider { display: flex; align-items: center; margin: 28px -16px; color: #888; font-size: 13px; letter-spacing: 0.06em; pointer-events: none; user-select: none; }
  .turn-divider::before, .turn-divider::after { content: ''; flex: 1; border-top: 1px dashed #3a3a3a; }
  .turn-divider span { padding: 0 14px; font-weight: 600; }
  .card.text { border-color: #888; background: #222; }
  .card.thinking { border-color: #fc4; background: #2a2418; font-style: italic; }
  .card.tool { border-color: #6c6; }
  .card.tool-Skill { border-color: #b6f; background: #261b33; }
  .card.tool-result-skill { border-color: #b6f; background: #1f1729; }
  .card.tool-result-skill .tag { color: #d9b8ff; }
  .card.tool-Agent, .card.tool-Task { border-color: #f66; background: #2d1d1d; }
  .card.tool-Bash { border-color: #6c6; background: #1d2a1d; }
  .card.tool-Read, .card.tool-Write, .card.tool-Edit, .card.tool-NotebookEdit { border-color: #fa4; background: #2d241a; }
  .card.tool-WebSearch, .card.tool-WebFetch { border-color: #4cc; background: #1a2828; }
  .card.tool-result { border-color: #444; background: #1c1c1c; opacity: 0.65; font-size: 11px; }
  .card .name { color: #aaa; font-size: 10px; margin-bottom: 5px; letter-spacing: 0.5px; text-transform: uppercase; display: flex; justify-content: space-between; gap: 12px; align-items: center; }
  .card .name .time { color: #555; text-transform: none; font-family: ui-monospace, monospace; flex-shrink: 0; }
  .card pre { margin: 0; white-space: pre-wrap; word-break: break-word; font-family: inherit; line-height: 1.5; }
  .card.tool pre { font-family: ui-monospace, monospace; font-size: 11.5px; color: #cda; }
  .truncated { color: #666; font-size: 10px; margin-top: 4px; }
  .card.collapsible { cursor: pointer; user-select: none; }
  .card.collapsible.open { cursor: default; }
  .card.collapsible .summary { color: #dde; text-transform: none; letter-spacing: 0; font-size: 12.5px; font-family: ui-monospace, monospace; flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .card.collapsible .tag { color: #999; font-weight: 600; margin-right: 8px; flex-shrink: 0; }
  .card.collapsible .toggle { color: #777; margin-right: 6px; display: inline-block; width: 10px; flex-shrink: 0; transition: transform 0.15s; }
  .card.collapsible.open .toggle { transform: rotate(90deg); }
  .card.collapsible .detail { display: none; margin-top: 8px; border-top: 1px dashed #3a3a3a; padding-top: 8px; }
  .card.collapsible.open .detail { display: block; }
  .card.collapsible .header-row { display: flex; align-items: center; flex: 1; min-width: 0; }
  h3 { margin: 14px 0 6px; font-size: 10px; color: #777; text-transform: uppercase; letter-spacing: 1px; font-weight: 600; }
  h3:first-child { margin-top: 0; }
  .stat { display: flex; justify-content: space-between; padding: 3px 0; font-size: 12px; border-bottom: 1px dotted #2a2a2a; }
  .stat span:last-child { color: #6c6; font-family: ui-monospace, monospace; }
  .stat.tool-Skill span:last-child { color: #b6f; }
  .stat.tool-Agent span:last-child, .stat.tool-Task span:last-child { color: #f66; }
  #empty { text-align: center; color: #555; padding: 40px 20px; font-size: 12px; }
  .md { white-space: pre-wrap; line-height: 1.55; }
  .md h1, .md h2, .md h3 { font-weight: 600; margin: 10px 0 4px; line-height: 1.3; }
  .md h1 { font-size: 16px; color: #fff; }
  .md h2 { font-size: 14px; color: #cdf; }
  .md h3 { font-size: 13px; color: #aaf; }
  .md ul, .md ol { margin: 4px 0; padding-left: 22px; white-space: normal; }
  .md li { margin: 2px 0; }
  .md hr { border: 0; border-top: 1px solid #3a3a3a; margin: 10px 0; }
  .md a { color: #6cf; text-decoration: none; }
  .md a:hover { text-decoration: underline; }
  .md .md-inline { background: #2f2f2f; padding: 1px 6px; border-radius: 3px; font-family: ui-monospace, monospace; font-size: 11.5px; color: #fb8; white-space: nowrap; }
  .md .md-code { background: #141414; padding: 9px 11px; border-radius: 5px; overflow-x: auto; margin: 6px 0; white-space: pre; }
  .md .md-code code { font-family: ui-monospace, monospace; font-size: 11.5px; color: #cda; }
  .md .md-table { border-collapse: collapse; margin: 6px 0; font-size: 12px; white-space: normal; }
  .md .md-table { width: 100%; }
  .md .md-table th, .md .md-table td { border: 1px solid #555; padding: 5px 9px; text-align: left; vertical-align: top; }
  .md .md-table th { background: #2a2a2a; color: #aaf; font-weight: 600; }
  .md .md-table td { background: #1c1c1c; }
  .md strong { color: #fff; }
  #clearBtn, #filter, #lang { background: #2a2a2a; color: #ccc; border: 1px solid #3a3a3a; padding: 3px 10px; border-radius: 4px; font-size: 11px; cursor: pointer; font-family: inherit; }
  #clearBtn:hover, #filter:hover, #lang:hover { background: #3a3a3a; color: #fff; }
  #clearBtn:active { background: #444; }
  #filter, #lang { padding: 3px 6px; }
  .stat.tool-row { cursor: pointer; user-select: none; padding: 4px 6px; margin: 0 -6px; border-radius: 3px; border-bottom: 1px dotted #2a2a2a; }
  .stat.tool-row:hover { background: #1f1f1f; }
  .stat.tool-row.active { background: #1f2c3a; color: #fff; }
  .stat.tool-row.active span:first-child::before { content: '● '; color: #6cf; }
  #pinHint { color: #555; font-size: 10px; margin-top: 6px; }
</style></head><body>
<header>
  <div class="dot"></div>
  <h1>Claude Monitor</h1>
  <div class="meta" id="sess">no active session</div>
  <div style="flex:1"></div>
  <select id="filter" title="Filter">
    <option value="all" data-i18n="all_events">All events</option>
    <option value="skill" data-i18n="skill_only">Skills + memory only</option>
    <option value="conv_skill" data-i18n="conv_skill">Conversation + Skills</option>
    <option value="tools" data-i18n="tools_only">Tool calls only</option>
    <option value="conversation" data-i18n="conv_only">Conversation only</option>
  </select>
  <button id="clearBtn" data-i18n="clear">Clear</button>
  <select id="lang" title="Language / 언어">
    <option value="ko">한국어</option>
    <option value="en">English</option>
  </select>
  <div class="meta" id="conn">connecting…</div>
</header>
<div id="tabs" data-empty="—"></div>
<div id="mainContainer"><div id="empty" data-i18n="waiting">Waiting for activity… Launch Claude Code in any project.</div></div>
<div id="side">
  <h3 data-i18n="session_title">Session</h3>
  <div id="info"><div class="stat"><span>—</span><span></span></div></div>
  <h3 data-i18n="context_title">My context</h3>
  <div id="ctx-memory" class="ctx-block"></div>
  <div id="ctx-claude" class="ctx-block"></div>
  <div id="ctx-skills" class="ctx-block"></div>
  <h3 data-i18n="tools_title">Tool calls (click to filter)</h3>
  <div id="tools"></div>
  <div id="pinHint"></div>
  <h3 data-i18n="tokens_title">Tokens (this session)</h3>
  <div id="tokens"></div>
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
}

const mainContainer = document.getElementById('mainContainer');
const info = document.getElementById('info');
const tokensEl = document.getElementById('tokens');
const toolsEl = document.getElementById('tools');
const sessEl = document.getElementById('sess');
const connEl = document.getElementById('conn');
const tabsBar = document.getElementById('tabs');

const tabs = new Map(); // sessionId -> { mainEl, tabEl, tokens, toolCounts, sessionId, project, path, cardCount }
let activeTabId = null;
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
    for (const card of tab.mainEl.querySelectorAll('.card')) {
      card.style.display = cardMatchesFilter(card) ? '' : 'none';
    }
  }
}

function getActiveTab() { return activeTabId ? tabs.get(activeTabId) : null; }

function ensureTab(sessionId, project, path) {
  if (tabs.has(sessionId)) return tabs.get(sessionId);
  const pane = document.createElement('div');
  pane.className = 'tab-pane';
  pane.dataset.session = sessionId;
  mainContainer.appendChild(pane);

  const tabEl = document.createElement('button');
  tabEl.className = 'tab';
  tabEl.dataset.session = sessionId;
  const projName = project.replace(/^-/, '').split('-').filter(Boolean).slice(-2).join('/');
  tabEl.innerHTML =
    '<span class="tab-label" title="' + esc(project + ' / ' + sessionId) + '">' + esc(projName || 'project') + ' · ' + esc(sessionId.slice(0, 6)) + '</span>' +
    '<span class="tab-count">0</span>' +
    '<span class="tab-close" title="Close">×</span>';
  tabsBar.appendChild(tabEl);

  tabEl.addEventListener('click', (e) => {
    if (e.target.classList.contains('tab-close')) { e.stopPropagation(); closeTab(sessionId); return; }
    switchTab(sessionId);
  });

  const placeholder = document.getElementById('empty');
  if (placeholder) placeholder.remove();

  const tab = {
    sessionId, project, path,
    mainEl: pane, tabEl,
    tokens: { input: 0, output: 0, cache_read: 0, cache_create: 0 },
    toolCounts: {},
    cardCount: 0,
    skillToolUseIds: new Set(),
    skillNamesById: new Map(),
    skillsLoaded: new Set(),
    inventory: null,
  };
  tabs.set(sessionId, tab);
  if (!activeTabId) switchTab(sessionId);
  return tab;
}

function switchTab(sessionId) {
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
  }
}

function closeTab(sessionId) {
  const tab = tabs.get(sessionId);
  if (!tab) return;
  tab.tabEl.remove();
  tab.mainEl.remove();
  tabs.delete(sessionId);
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
    info.innerHTML = [
      [t('project'), tab.project.replace(/^-/, '').replace(/-/g, '/')],
      [t('session_id'), tab.sessionId.slice(0, 8) + '…'],
    ].map(([k, v]) => '<div class="stat"><span>' + esc(k) + '</span><span>' + esc(v) + '</span></div>').join('');
    tokensEl.innerHTML = Object.entries(tab.tokens).map(([k, v]) =>
      '<div class="stat"><span>' + k + '</span><span>' + v.toLocaleString() + '</span></div>'
    ).join('');
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
  if (cls === 'user' && tab.mainEl.querySelector('.card.user')) {
    const divider = document.createElement('div');
    divider.className = 'turn-divider';
    divider.innerHTML = '<span>' + esc(t('turn_label')) + '</span>';
    tab.mainEl.appendChild(divider);
  }
  const div = document.createElement('div');
  div.className = 'card ' + cls;
  let html = '';
  if (name) html += '<div class="name"><span>' + esc(name) + '</span><span class="time">' + esc(time(ts)) + '</span></div>';
  const limit = opts.markdown ? 12000 : 3000;
  const text = String(body ?? '');
  if (opts.markdown) html += '<div class="md">' + md(text.slice(0, limit)) + '</div>';
  else html += '<pre>' + esc(text.slice(0, limit)) + '</pre>';
  if (text.length > limit) html += '<div class="truncated">… ' + (text.length - limit).toLocaleString() + ' more chars</div>';
  div.innerHTML = html;
  appendCard(tab, div);
}

function addCollapsibleCard(tab, cls, tag, summary, detail, ts) {
  const div = document.createElement('div');
  div.className = 'card collapsible ' + cls;
  const limit = 8000;
  const text = String(detail ?? '');
  const moreNote = text.length > limit ? '<div class="truncated">… ' + (text.length - limit).toLocaleString() + ' more chars</div>' : '';
  div.innerHTML =
    '<div class="name">' +
      '<div class="header-row">' +
        '<span class="toggle">▶</span>' +
        '<span class="tag">' + esc(tag) + '</span>' +
        '<span class="summary">' + esc(summary || '(no summary)') + '</span>' +
      '</div>' +
      '<span class="time">' + esc(time(ts)) + '</span>' +
    '</div>' +
    '<div class="detail"><pre>' + esc(text.slice(0, limit)) + '</pre>' + moreNote + '</div>';
  appendCard(tab, div);
}

function addSkillResultCard(tab, skillName, body, ts) {
  const div = document.createElement('div');
  div.className = 'card collapsible tool-result tool-result-skill';
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
  const mainEl = tab.mainEl;
  const atBottom = mainEl.scrollTop + mainEl.clientHeight >= mainEl.scrollHeight - 40;
  mainEl.appendChild(div);
  tab.cardCount++;
  const countEl = tab.tabEl.querySelector('.tab-count');
  if (countEl) countEl.textContent = tab.cardCount;
  if (!cardMatchesFilter(div)) {
    div.style.display = 'none';
  } else if (atBottom && tab.sessionId === activeTabId) {
    mainEl.scrollTop = mainEl.scrollHeight;
  }
}

mainContainer.addEventListener('click', (e) => {
  if (e.target.tagName === 'A') return;
  const card = e.target.closest('.card.collapsible');
  if (!card) return;
  if (window.getSelection && window.getSelection().toString()) return;
  card.classList.toggle('open');
});

document.getElementById('clearBtn').addEventListener('click', () => {
  const tab = getActiveTab();
  if (!tab) return;
  tab.mainEl.innerHTML = '';
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
  if (!sessEl.dataset.hasSession) sessEl.textContent = t('no_session');
  if (connEl.dataset.state) connEl.textContent = t(connEl.dataset.state);
  renderSide(getActiveTab());
});

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

const es = new EventSource('/events');
es.onopen = () => { connEl.dataset.state = 'live'; connEl.textContent = t('live'); connEl.style.color = '#6c6'; };
es.onerror = () => { connEl.dataset.state = 'reconnecting'; connEl.textContent = t('reconnecting'); connEl.style.color = '#f66'; };
es.onmessage = (e) => {
  let j;
  try { j = JSON.parse(e.data); } catch { return; }
  if (j.__monitor === 'session') { ensureTab(j.session, j.project, j.path); return; }
  if (j.__monitor === 'inventory') {
    const tab = tabs.get(j.session);
    if (tab) {
      tab.inventory = { memoryItems: j.memoryItems || [], claudeMd: j.claudeMd || [], cwd: j.cwd || '' };
      if (j.session === activeTabId) renderSide(tab);
    }
    return;
  }

  const sid = j.sessionId;
  if (!sid) return;
  const tab = tabs.get(sid);
  if (!tab) return;

  const ts = j.timestamp;
  if (j.type === 'user') {
    const srcId = j.sourceToolUseID || j.sourceToolUseId;
    if (j.isMeta && srcId && tab.skillToolUseIds.has(srcId)) {
      const skillName = tab.skillNamesById.get(srcId) || '';
      const c = j.message?.content;
      let text = '';
      if (Array.isArray(c)) text = c.filter((i) => i.type === 'text').map((i) => i.text).join('\n');
      else if (typeof c === 'string') text = c;
      addSkillResultCard(tab, skillName, text, ts);
    } else {
      const c = j.message?.content;
      if (Array.isArray(c)) {
        for (const item of c) {
          if (item.type === 'tool_result') {
            let body = item.content;
            if (Array.isArray(body)) body = body.map((x) => x.text ?? JSON.stringify(x)).join('\n');
            else if (typeof body !== 'string') body = JSON.stringify(body);
            addCollapsibleCard(tab, 'tool-result', t('label_result'), shortenResult(body), body, ts);
          } else if (item.type === 'text') {
            addCard(tab, 'user', t('label_user'), item.text, ts);
          }
        }
      } else if (typeof c === 'string') {
        addCard(tab, 'user', t('label_user'), c, ts);
      }
    }
  } else if (j.type === 'assistant' && j.message?.content) {
    for (const c of j.message.content) {
      if (c.type === 'text') addCard(tab, 'text', t('label_claude'), c.text, ts, { markdown: true });
      else if (c.type === 'thinking') { /* skipped: redacted by Anthropic */ }
      else if (c.type === 'tool_use') {
        tab.toolCounts[c.name] = (tab.toolCounts[c.name] || 0) + 1;
        const summary = summarize(c.name, c.input);
        const detail = typeof c.input === 'string' ? c.input : JSON.stringify(c.input, null, 2);
        addCollapsibleCard(tab, 'tool tool-' + c.name, c.name, summary, detail, ts);
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
    }
  }
  if (sid === activeTabId) renderSide(tab);
};
</script></body></html>`;

http.createServer((req, res) => {
  if (req.url === '/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.write(': connected\n\n');
    clients.add(res);
    sendInitialState(res);
    req.on('close', () => clients.delete(res));
    return;
  }
  if (req.url === '/health') {
    res.writeHead(200); res.end('ok'); return;
  }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(HTML);
}).listen(PORT, () => {
  console.log(`Claude Monitor → http://localhost:${PORT}`);
});

process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));
