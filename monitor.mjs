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

let currentPath = null;
let lastSize = 0;

function findActive() {
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
        acc.push({ path: fp, project: proj, session: f.replace('.jsonl', ''), mtime: m });
      } catch {}
    }
  }
  acc.sort((a, b) => b.mtime - a.mtime);
  return acc[0];
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
  const active = findActive();
  if (!active) return;

  if (active.path !== currentPath) {
    currentPath = active.path;
    lastSize = 0;
    send(JSON.stringify({
      __monitor: 'session',
      session: active.session,
      project: active.project,
      path: active.path,
      mtime: active.mtime,
    }));
    try {
      const content = fs.readFileSync(active.path, 'utf-8');
      const lines = content.trim().split('\n').slice(-30);
      for (const ln of lines) if (ln) send(ln);
      lastSize = fs.statSync(active.path).size;
    } catch {}
    return;
  }

  try {
    const size = fs.statSync(active.path).size;
    if (size < lastSize) lastSize = 0;
    if (size > lastSize) {
      const chunk = await readRange(active.path, lastSize, size);
      lastSize = size;
      chunk.split('\n').filter(Boolean).forEach(send);
    }
  } catch {}
}

setInterval(poll, 500);
poll();

const HTML = String.raw`<!doctype html>
<html><head><meta charset="utf-8"><title>Claude Monitor</title>
<style>
  * { box-sizing: border-box; }
  body { font: 13px -apple-system, BlinkMacSystemFont, sans-serif; margin: 0; background: #1a1a1a; color: #e0e0e0; display: grid; grid-template-columns: 1fr 320px; height: 100vh; }
  header { grid-column: 1 / -1; padding: 8px 14px; background: #0f0f0f; border-bottom: 1px solid #2a2a2a; display: flex; align-items: center; gap: 14px; }
  header h1 { font-size: 13px; margin: 0; color: #ddd; font-weight: 600; }
  header .meta { color: #888; font-size: 11px; font-family: ui-monospace, monospace; }
  header .dot { width: 8px; height: 8px; border-radius: 50%; background: #6c6; animation: pulse 1.5s infinite; }
  @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.3; } }
  #main { overflow-y: auto; padding: 12px 16px; }
  #side { overflow-y: auto; padding: 12px 14px; border-left: 1px solid #2a2a2a; background: #151515; }
  .card { padding: 8px 11px; margin: 7px 0; border-radius: 6px; border-left: 3px solid #555; background: #232323; }
  .card.user { border-color: #4af; background: #1a2533; }
  .card.text { border-color: #888; background: #222; }
  .card.thinking { border-color: #fc4; background: #2a2418; font-style: italic; }
  .card.tool { border-color: #6c6; }
  .card.tool-Skill { border-color: #b6f; background: #261b33; }
  .card.tool-Agent, .card.tool-Task { border-color: #f66; background: #2d1d1d; }
  .card.tool-Bash { border-color: #6c6; background: #1d2a1d; }
  .card.tool-Read, .card.tool-Write, .card.tool-Edit, .card.tool-NotebookEdit { border-color: #fa4; background: #2d241a; }
  .card.tool-WebSearch, .card.tool-WebFetch { border-color: #4cc; background: #1a2828; }
  .card.tool-result { border-color: #444; background: #1c1c1c; opacity: 0.65; font-size: 11px; }
  .card .name { color: #aaa; font-size: 10px; margin-bottom: 5px; letter-spacing: 0.5px; text-transform: uppercase; display: flex; justify-content: space-between; }
  .card .name .time { color: #555; text-transform: none; font-family: ui-monospace, monospace; }
  .card pre { margin: 0; white-space: pre-wrap; word-break: break-word; font-family: inherit; line-height: 1.5; }
  .card.tool pre { font-family: ui-monospace, monospace; font-size: 11.5px; color: #cda; }
  .truncated { color: #666; font-size: 10px; margin-top: 4px; }
  h3 { margin: 14px 0 6px; font-size: 10px; color: #777; text-transform: uppercase; letter-spacing: 1px; font-weight: 600; }
  h3:first-child { margin-top: 0; }
  .stat { display: flex; justify-content: space-between; padding: 3px 0; font-size: 12px; border-bottom: 1px dotted #2a2a2a; }
  .stat span:last-child { color: #6c6; font-family: ui-monospace, monospace; }
  .stat.tool-Skill span:last-child { color: #b6f; }
  .stat.tool-Agent span:last-child, .stat.tool-Task span:last-child { color: #f66; }
  #empty { text-align: center; color: #555; padding: 40px 20px; font-size: 12px; }
</style></head><body>
<header>
  <div class="dot"></div>
  <h1>Claude Monitor</h1>
  <div class="meta" id="sess">no active session</div>
  <div style="flex:1"></div>
  <div class="meta" id="conn">connecting…</div>
</header>
<div id="main"><div id="empty">Waiting for activity… Launch Claude Code in any project.</div></div>
<div id="side">
  <h3>Session</h3>
  <div id="info"><div class="stat"><span>—</span><span></span></div></div>
  <h3>Tokens (this session)</h3>
  <div id="tokens"></div>
  <h3>Tool calls</h3>
  <div id="tools"></div>
</div>
<script>
const main = document.getElementById('main');
const empty = document.getElementById('empty');
const info = document.getElementById('info');
const tokensEl = document.getElementById('tokens');
const toolsEl = document.getElementById('tools');
const sessEl = document.getElementById('sess');
const connEl = document.getElementById('conn');

let tokens = { input: 0, output: 0, cache_read: 0, cache_create: 0 };
let toolCounts = {};

const esc = (s) => String(s ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const time = (iso) => { try { return new Date(iso).toLocaleTimeString('en-GB'); } catch { return ''; } };

function resetSession(info) {
  tokens = { input: 0, output: 0, cache_read: 0, cache_create: 0 };
  toolCounts = {};
  main.innerHTML = '';
  empty.style.display = 'none';
  sessEl.textContent = info.project + ' / ' + info.session.slice(0, 8);
  renderSide(info);
}

function renderSide(sessInfo) {
  if (sessInfo) {
    document.getElementById('info').innerHTML = [
      ['project', sessInfo.project.replace(/^-/, '').replace(/-/g, '/')],
      ['session', sessInfo.session.slice(0, 8) + '…'],
    ].map(([k, v]) => '<div class="stat"><span>' + esc(k) + '</span><span>' + esc(v) + '</span></div>').join('');
  }
  tokensEl.innerHTML = Object.entries(tokens).map(([k, v]) =>
    '<div class="stat"><span>' + k + '</span><span>' + v.toLocaleString() + '</span></div>'
  ).join('');
  toolsEl.innerHTML = Object.entries(toolCounts).sort((a, b) => b[1] - a[1]).map(([k, v]) =>
    '<div class="stat tool-' + esc(k) + '"><span>' + esc(k) + '</span><span>' + v + '</span></div>'
  ).join('') || '<div class="stat"><span style="color:#444">—</span><span></span></div>';
}

function addCard(cls, name, body, ts, footer) {
  empty.style.display = 'none';
  const div = document.createElement('div');
  div.className = 'card ' + cls;
  let html = '';
  if (name) html += '<div class="name"><span>' + esc(name) + '</span><span class="time">' + esc(time(ts)) + '</span></div>';
  const limit = 3000;
  const text = String(body ?? '');
  html += '<pre>' + esc(text.slice(0, limit)) + '</pre>';
  if (text.length > limit) html += '<div class="truncated">… ' + (text.length - limit).toLocaleString() + ' more chars</div>';
  if (footer) html += '<div class="truncated">' + esc(footer) + '</div>';
  div.innerHTML = html;
  const atBottom = main.scrollTop + main.clientHeight >= main.scrollHeight - 40;
  main.appendChild(div);
  if (atBottom) main.scrollTop = main.scrollHeight;
}

let sessInfo = null;
const es = new EventSource('/events');
es.onopen = () => { connEl.textContent = 'live'; connEl.style.color = '#6c6'; };
es.onerror = () => { connEl.textContent = 'reconnecting…'; connEl.style.color = '#f66'; };
es.onmessage = (e) => {
  let j;
  try { j = JSON.parse(e.data); } catch { return; }
  if (j.__monitor === 'session') { sessInfo = j; resetSession(j); return; }

  const ts = j.timestamp;
  if (j.type === 'user') {
    const c = j.message?.content;
    if (Array.isArray(c)) {
      for (const item of c) {
        if (item.type === 'tool_result') {
          let body = item.content;
          if (Array.isArray(body)) body = body.map((x) => x.text ?? JSON.stringify(x)).join('\n');
          else if (typeof body !== 'string') body = JSON.stringify(body);
          addCard('tool-result', 'tool_result', body, ts);
        } else if (item.type === 'text') {
          addCard('user', 'user', item.text, ts);
        }
      }
    } else if (typeof c === 'string') {
      addCard('user', 'user', c, ts);
    }
  } else if (j.type === 'assistant' && j.message?.content) {
    for (const c of j.message.content) {
      if (c.type === 'text') addCard('text', 'claude', c.text, ts);
      else if (c.type === 'thinking') addCard('thinking', 'thinking', c.thinking, ts);
      else if (c.type === 'tool_use') {
        toolCounts[c.name] = (toolCounts[c.name] || 0) + 1;
        const input = typeof c.input === 'string' ? c.input : JSON.stringify(c.input, null, 2);
        addCard('tool tool-' + c.name, c.name, input, ts);
      }
    }
    const u = j.message.usage;
    if (u) {
      tokens.input += u.input_tokens || 0;
      tokens.output += u.output_tokens || 0;
      tokens.cache_read += u.cache_read_input_tokens || 0;
      tokens.cache_create += u.cache_creation_input_tokens || 0;
    }
  }
  renderSide(sessInfo);
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
