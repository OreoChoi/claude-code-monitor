#!/usr/bin/env node
// scripts/screenshot.mjs
// Capture deterministic screenshots of the monitor UI for README/docs.
// Spawns monitor.mjs against a seed JSONL dir, then drives Chromium via Playwright.

import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, readdirSync, statSync, readFileSync, writeFileSync, appendFileSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SEED = path.join(ROOT, 'scripts', 'seed');
const OUT = path.join(ROOT, 'docs', 'screenshots');
const PORT = 7777;
const URL = `http://localhost:${PORT}`;

const args = new Set(process.argv.slice(2));
const onlyArg = process.argv.find((a) => a.startsWith('--only='));
const ONLY = onlyArg ? new Set(onlyArg.slice('--only='.length).split(',')) : null;

let playwright;
try {
  playwright = await import('playwright');
} catch {
  console.error(
    'Playwright not installed. Run:\n' +
    '  npm install --save-dev playwright\n' +
    '  npx playwright install chromium\n'
  );
  process.exit(1);
}

// Mirror the seed tree into a temp dir, but stage each .jsonl content into
// memory and create an empty file on disk. Monitor registers the file with
// lastSize=0, then we replay the contents so the events flow through SSE
// (the same code path the real Claude Code session uses).
function stageSeed() {
  const tmp = mkdtempSync(path.join(tmpdir(), 'cc-monitor-shot-'));
  const replays = []; // { filePath, lines: string[] }
  function walk(srcDir, dstDir) {
    mkdirSync(dstDir, { recursive: true });
    for (const name of readdirSync(srcDir)) {
      const src = path.join(srcDir, name);
      const dst = path.join(dstDir, name);
      const st = statSync(src);
      if (st.isDirectory()) walk(src, dst);
      else if (name.endsWith('.jsonl')) {
        const content = readFileSync(src, 'utf-8');
        const lines = content.split('\n').filter(Boolean);
        writeFileSync(dst, '');
        replays.push({ filePath: dst, lines });
      } else {
        writeFileSync(dst, readFileSync(src));
      }
    }
  }
  walk(SEED, tmp);
  return { dir: tmp, replays };
}

async function replaySeed(replays) {
  // Touch each empty file so monitor's mtime window picks it up, then
  // append all lines. Monitor polls every 500ms — wait one poll cycle so the
  // empty file is registered, then write content (size grows ⇒ streamed).
  const now = new Date();
  for (const { filePath } of replays) utimesSync(filePath, now, now);
  await new Promise((r) => setTimeout(r, 800));
  for (const { filePath, lines } of replays) {
    appendFileSync(filePath, lines.join('\n') + '\n');
  }
}

function startMonitor(projectsDir) {
  const proc = spawn('node', [path.join(ROOT, 'monitor.mjs')], {
    env: { ...process.env, CC_MONITOR_PROJECTS_DIR: projectsDir },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.stdout.on('data', () => {});
  proc.stderr.on('data', (d) => process.stderr.write(`[monitor] ${d}`));
  return proc;
}

async function waitForServer(timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(URL);
      if (r.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('monitor server did not respond in time');
}

function should(name) {
  return ONLY === null || ONLY.has(name);
}

mkdirSync(OUT, { recursive: true });
const { dir: projectsDir, replays } = stageSeed();
const monitor = startMonitor(projectsDir);

const cleanup = () => {
  try { monitor.kill('SIGTERM'); } catch {}
  try { rmSync(projectsDir, { recursive: true, force: true }); } catch {}
};
process.on('exit', cleanup);
process.on('SIGINT', () => { cleanup(); process.exit(130); });

try {
  await waitForServer();
  await replaySeed(replays);
  // Give SSE clients + browser a beat to receive everything.
  await new Promise((r) => setTimeout(r, 1500));

  const browser = await playwright.chromium.launch();
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2,
    locale: 'ko-KR',
  });

  async function shot(name, prep) {
    if (!should(name)) return;
    const page = await context.newPage();
    await page.goto(URL, { waitUntil: 'domcontentloaded' });
    // SSE keeps the connection open; wait for the first card instead of networkidle.
    await page.waitForSelector('.card', { timeout: 8000 }).catch(() => {});
    await page.waitForTimeout(1200);
    if (prep) await prep(page);
    const file = path.join(OUT, `${name}.png`);
    await page.screenshot({ path: file, fullPage: false });
    console.log(`✓ ${path.relative(ROOT, file)}`);
    await page.close();
  }

  // 1. Hero — default view
  await shot('hero');

  // 2. Dashboard — same as hero, kept separate for future divergence
  await shot('dashboard');

  // 3. Skill expanded — open the turn containing Skill, then expand the Skill card.
  await shot('skill-expanded', async (page) => {
    // Find a turn user card whose summary mentions a skill (purple chip)
    const turnWithSkill = page.locator('.card.user.turn-card', { has: page.locator('.sk-step') }).first();
    if (await turnWithSkill.count()) {
      await turnWithSkill.click();
      await page.waitForTimeout(400);
      const skillCard = page.locator('#threadBody .card.tool-Skill').first();
      if (await skillCard.count()) {
        await skillCard.click();
        await page.waitForTimeout(400);
        await skillCard.scrollIntoViewIfNeeded();
      }
    }
  });

  // 4. Sidebar context — close any open thread, sidebar is always visible on left
  await shot('sidebar-context');

  // 5. Filters — switch to "Conversation only"
  await shot('filters', async (page) => {
    const select = page.locator('select#filter').first();
    if (await select.count()) {
      await select.selectOption('conversation');
      await page.waitForTimeout(300);
    }
  });

  // 6. AskUserQuestion — open the last turn (which calls AskUserQuestion), expand the card
  await shot('askq', async (page) => {
    const turns = page.locator('.card.user.turn-card');
    const count = await turns.count();
    if (count > 0) {
      await turns.nth(count - 1).click();
      await page.waitForTimeout(400);
      const askqCard = page.locator('#threadBody .card.tool-AskUserQuestion').first();
      if (await askqCard.count()) {
        await askqCard.click();
        await page.waitForTimeout(400);
        await askqCard.scrollIntoViewIfNeeded();
      }
    }
  });

  // 7. i18n — open settings, switch language to English, close.
  await shot('i18n', async (page) => {
    await page.click('#settingsBtn');
    await page.waitForTimeout(300);
    await page.selectOption('#lang', 'en');
    await page.waitForTimeout(200);
    // Close the settings modal by clicking the backdrop (or pressing Escape)
    await page.keyboard.press('Escape');
    await page.waitForTimeout(400);
  });

  await browser.close();
} finally {
  cleanup();
}
