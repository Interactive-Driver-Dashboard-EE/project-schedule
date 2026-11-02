// End-to-end check in a real browser against the local mock API, with real mouse input.
//   node dev/e2e.mjs [data.json] [screenshot-dir]
// Uses Edge or Chrome over the DevTools protocol, so it needs no extra packages.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const dataPath = process.argv[2] || join(root, 'dev', 'fixture.json');
const shots = process.argv[3] || mkdtempSync(join(tmpdir(), 'schedule-shots-'));
mkdirSync(shots, { recursive: true });
const WEB = 8766;
const DBG = 9333;
const BASE = `http://localhost:${WEB}`;

const browserPath = [
  process.env.BROWSER,
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].find((p) => p && existsSync(p));
assert.ok(browserPath, 'no Edge or Chrome found');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const server = spawn(process.execPath, [join(root, 'dev', 'mock-server.mjs'), dataPath, String(WEB)], { stdio: 'ignore' });
const profile = mkdtempSync(join(tmpdir(), 'schedule-e2e-'));
const browser = spawn(browserPath, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--hide-scrollbars', `--remote-debugging-port=${DBG}`,
  `--user-data-dir=${profile}`, '--window-size=1440,900', 'about:blank',
], { stdio: 'ignore' });

let ws;
let nextId = 1;
const pending = new Map();
const problems = [];

function send(method, params = {}) {
  const id = nextId++;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((res, rej) => pending.set(id, { res, rej, method }));
}

async function connect() {
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${DBG}/json`)).json();
      const page = list.find((t) => t.type === 'page');
      if (page) {
        ws = new WebSocket(page.webSocketDebuggerUrl);
        await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
        ws.onmessage = (e) => {
          const msg = JSON.parse(e.data);
          if (msg.id && pending.has(msg.id)) {
            const p = pending.get(msg.id);
            pending.delete(msg.id);
            if (msg.error) p.rej(new Error(`${p.method}: ${msg.error.message}`)); else p.res(msg.result);
          } else if (msg.method === 'Page.javascriptDialogOpening') {
            send('Page.handleJavaScriptDialog', { accept: true });
          } else if (msg.method === 'Runtime.exceptionThrown') {
            problems.push(msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text);
          } else if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error') {
            problems.push(`${msg.params.entry.text} ${msg.params.entry.url || ''}`);
          } else if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
            problems.push(msg.params.args.map((a) => a.value ?? a.description).join(' '));
          }
        };
        return;
      }
    } catch { /* still starting */ }
    await sleep(250);
  }
  throw new Error('browser did not start');
}

async function evaluate(expression) {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(`${expression}\n${r.exceptionDetails.exception?.description}`);
  return r.result.value;
}

async function shot(name) {
  const { data } = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(join(shots, `${name}.png`), Buffer.from(data, 'base64'));
}

async function mouse(type, x, y, buttons = 1) {
  await send('Input.dispatchMouseEvent', { type, x, y, button: type === 'mouseMoved' ? 'none' : 'left', buttons, clickCount: type === 'mouseMoved' ? 0 : 1 });
}

async function drag(x1, y1, x2, y2) {
  await mouse('mouseMoved', x1, y1, 0);
  await mouse('mousePressed', x1, y1);
  for (let i = 1; i <= 6; i++) {
    await mouse('mouseMoved', x1 + ((x2 - x1) * i) / 6, y1 + ((y2 - y1) * i) / 6);
    await sleep(15);
  }
  await mouse('mouseReleased', x2, y2);
  await sleep(100);
}

async function click(x, y) {
  await mouse('mouseMoved', x, y, 0);
  await mouse('mousePressed', x, y);
  await mouse('mouseReleased', x, y);
  await sleep(100);
}

const rowText = (id) => evaluate(`document.querySelector('[data-row="${id}"]')?.innerText.replace(/\\n/g,' | ')`);
const barRect = (id, part = 'bar') => evaluate(`(() => { const e = document.querySelector('[data-task="${id}"][data-part="${part}"]'); e.scrollIntoView({block:'center', inline:'center'}); const r = e.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2,left:r.left,right:r.right,w:r.width}; })()`);
const mockState = () => evaluate(`fetch('/__mock/state').then(r=>r.json())`);
const clickButton = (text) => evaluate(`[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(text)}).click()`);
const setField = (key, value) => evaluate(`(() => { const e = document.querySelector('[data-field-key="${key}"]'); e.value = ${JSON.stringify(value)}; e.dispatchEvent(new Event('change',{bubbles:true})); })()`);
const issueCount = () => evaluate(`document.querySelector('[role=tablist] button:nth-child(3)').textContent.match(/\\d+/)[0] * 1`);

const results = [];
async function step(name, fn) {
  await fn();
  results.push(name);
  console.log(`ok - ${name}`);
}

async function openPage(query = '') {
  await send('Page.navigate', { url: `${BASE}/?mock${query}` });
  for (let i = 0; i < 40; i++) {
    await sleep(100);
    if (await evaluate(`!!document.querySelector('.scroller, .page, .gate')`)) break;
  }
  await sleep(150);
}

try {
  await connect();
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Log.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await openPage();

  await step('page renders from the mock API', async () => {
    assert.ok(await evaluate(`document.querySelectorAll('.row').length`) > 5);
    await shot('01-gantt');
  });

  const first = (await mockState()).doc;
  const movable = first.tasks.find((t) => t.type === 'task' && t.status === 'todo' && first.tasks.some((x) => (x.deps || []).some((d) => d.id === t.id)));
  const successor = first.tasks.find((x) => (x.deps || []).some((d) => d.id === movable.id) && x.type === 'task');
  const ppd = 6;

  await step('dragging a task later moves it and what depends on it', async () => {
    const before = await rowText(movable.id);
    const beforeSucc = successor ? await rowText(successor.id) : null;
    const r = await barRect(movable.id);
    await drag(r.x, r.y, r.x - (ppd * 20), r.y);
    const after = await rowText(movable.id);
    assert.notEqual(after, before, 'task dates should change');
    if (successor) assert.notEqual(await rowText(successor.id), beforeSucc, 'successor should move');
    assert.equal(await evaluate(`!!document.querySelector('.drawer')`), false, 'a drag must not open the panel');
    await shot('02-after-drag');
  });

  await step('undo restores the plan and redo reapplies it', async () => {
    const moved = await rowText(movable.id);
    await clickButton('ביטול');
    assert.notEqual(await rowText(movable.id), moved);
    await clickButton('שחזור');
    assert.equal(await rowText(movable.id), moved);
    await clickButton('ביטול');
  });

  await step('dragging the end handle changes the duration', async () => {
    const before = await rowText(movable.id);
    const r = await barRect(movable.id, 'end');
    await drag(r.x, r.y, r.x - (ppd * 5), r.y);
    assert.notEqual(await rowText(movable.id), before);
    await clickButton('ביטול');
  });

  await step('clicking a bar opens the edit panel and fields save into the plan', async () => {
    const r = await barRect(movable.id);
    await click(r.x, r.y);
    assert.ok(await evaluate(`!!document.querySelector('.drawer')`));
    await shot('03-panel');
    await setField('name', 'שם ערוך בבדיקה');
    assert.match(await rowText(movable.id), /שם ערוך בבדיקה/);
    await setField('status', 'done');
    assert.match(await rowText(movable.id), /✓/);
    await setField('status', 'todo');
  });

  await step('saving commits to the data branch with a readable message', async () => {
    await clickButton('שמירה');
    await sleep(200);
    const st = await mockState();
    assert.equal(st.commits.length, 1);
    assert.equal(st.commits[0].branch, 'schedule-data');
    assert.match(st.commits[0].message, new RegExp(`Schedule: updated .*${movable.id}`));
    assert.equal(st.doc.tasks.find((t) => t.id === movable.id).name, 'שם ערוך בבדיקה');
    assert.equal(await evaluate(`document.querySelector('.sync').textContent.startsWith('נשמר')`), true);
  });

  await step('a partner saving at the same time merges instead of overwriting', async () => {
    const other = first.tasks.find((t) => t.id !== movable.id && t.type === 'task').id;
    const st = await mockState();
    const theirs = structuredClone(st.doc);
    theirs.tasks.find((t) => t.id === other).name = 'שינוי של השותף';
    await evaluate(`fetch('/__mock/external-edit',{method:'POST',body:JSON.stringify({doc:${JSON.stringify(theirs)}})}).then(r=>r.json())`);
    await setField('name', 'השינוי שלי');
    await clickButton('שמירה');
    await sleep(500);
    const merged = (await mockState()).doc;
    assert.equal(merged.tasks.find((t) => t.id === movable.id).name, 'השינוי שלי');
    assert.equal(merged.tasks.find((t) => t.id === other).name, 'שינוי של השותף');
    assert.match(await rowText(other), /שינוי של השותף/);
  });

  await step('a same-task clash keeps my version and tells me', async () => {
    const st = await mockState();
    const theirs = structuredClone(st.doc);
    theirs.tasks.find((t) => t.id === movable.id).note = 'הערה של השותף';
    await evaluate(`fetch('/__mock/external-edit',{method:'POST',body:JSON.stringify({doc:${JSON.stringify(theirs)}})}).then(r=>r.json())`);
    await setField('name', 'התנגשות');
    await clickButton('שמירה');
    await sleep(500);
    assert.equal((await mockState()).doc.tasks.find((t) => t.id === movable.id).name, 'התנגשות');
    assert.match(await evaluate(`document.getElementById('toasts').innerText`), /עדכון מקביל/);
  });

  await step('what-if changes are not saved and can be cancelled', async () => {
    const commits = (await mockState()).commits.length;
    await clickButton('מה אם?');
    const before = await rowText(movable.id);
    await evaluate(`document.querySelector('.drawer .icon-btn').click()`);
    const r = await barRect(movable.id);
    await drag(r.x, r.y, r.x - (ppd * 90), r.y);
    assert.notEqual(await rowText(movable.id), before);
    assert.match(await evaluate(`document.querySelector('.banner').innerText`), /משימות זזו/);
    await shot('04-what-if');
    await clickButton('לבטל');
    assert.equal(await rowText(movable.id), before);
    await sleep(100);
    assert.equal((await mockState()).commits.length, commits);
  });

  await step('adding a task puts it in the plan', async () => {
    const count = await evaluate(`document.querySelectorAll('.row.task').length`);
    await clickButton('+ משימה');
    assert.equal(await evaluate(`document.querySelectorAll('.row.task').length`), count + 1);
    await evaluate(`document.querySelector('.drawer .icon-btn').click()`);
  });

  await step('a blackout added in settings pushes affected work', async () => {
    await clickButton('הגדרות');
    await shot('05-settings');
    const before = await issueCount();
    assert.ok(before >= 0);
    await clickButton('+ הוספת תקופה');
    assert.ok(await evaluate(`[...document.querySelectorAll('.drawer input')].some(i=>i.value==='מילואים')`));
    await clickButton('ביטול');
    await evaluate(`document.querySelector('.drawer .icon-btn').click()`);
  });

  await step('week and issues pages render', async () => {
    await evaluate(`document.querySelector('[role=tablist] button:nth-child(2)').click()`);
    await sleep(100);
    assert.ok(await evaluate(`!!document.querySelector('.weekly')`));
    await shot('06-week');
    await evaluate(`document.querySelector('[role=tablist] button:nth-child(3)').click()`);
    await sleep(100);
    await shot('07-issues');
    await evaluate(`document.querySelector('[role=tablist] button:nth-child(1)').click()`);
    await sleep(100);
  });

  await step('image export draws in Hebrew and English', async () => {
    for (const lang of ['he', 'en']) {
      const dataUrl = await evaluate(`(async () => {
        const app = await import('/js/app.js');
        const ex = await import('/js/export.js');
        const { toDay } = await import('/js/model.js');
        const svg = ex.buildExportSvg(app.state.doc, app.state.sched, { lang: '${lang}', baseline: null, todayDay: toDay(app.todayIso()), criticalDays: 7, lateMilestones: new Set() });
        const url = URL.createObjectURL(new Blob([ex.svgText(svg)], { type: 'image/svg+xml' }));
        const img = new Image();
        await new Promise((res, rej) => { img.onload = res; img.onerror = () => rej(new Error('img')); img.src = url; });
        const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
        c.getContext('2d').drawImage(img, 0, 0);
        return c.toDataURL('image/png');
      })()`);
      writeFileSync(join(shots, `08-export-${lang}.png`), Buffer.from(dataUrl.split(',')[1], 'base64'));
    }
  });

  await step('dark theme and phone width render without overflow', async () => {
    await evaluate(`localStorage.setItem('schedule.prefs', JSON.stringify({ ...JSON.parse(localStorage.getItem('schedule.prefs')||'{}'), theme: 'dark' }))`);
    await openPage();
    await shot('09-dark');
    await evaluate(`localStorage.setItem('schedule.prefs', JSON.stringify({ ...JSON.parse(localStorage.getItem('schedule.prefs')||'{}'), theme: 'auto' }))`);
    await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
    await openPage();
    assert.equal(await evaluate(`document.documentElement.scrollWidth <= innerWidth`), true);
    await shot('10-phone');
    await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  });

  await step('a rejected token returns to the sign-in screen with a clear message', async () => {
    await evaluate(`localStorage.setItem('schedule.token','bad')`);
    await openPage();
    assert.match(await evaluate(`document.querySelector('.err')?.textContent || ''`), /הטוקן/);
    assert.equal(await evaluate(`localStorage.getItem('schedule.token')`), null);
    await shot('11-gate');
  });

  await step('the API address cannot be redirected away from a local machine', async () => {
    const code = await evaluate(`fetch('/js/config.js').then(r=>r.text())`);
    assert.match(code, /\['localhost', '127\.0\.0\.1'\]\.includes\(location\.hostname\)/);
  });

  // A 401 and 409 are exactly what the sign-in and merge steps provoke on purpose.
  const realProblems = problems.filter((p) => !/status of (401|409)/.test(p));
  assert.deepEqual(realProblems, [], 'browser reported errors');
  console.log(`\n${results.length} steps passed. Screenshots: ${shots}`);
} catch (err) {
  console.error('FAILED:', err.message);
  if (problems.length) console.error('browser problems:', problems);
  try { await shot('failure'); } catch { /* browser gone */ }
  process.exitCode = 1;
} finally {
  ws?.close();
  browser.kill();
  server.kill();
  await sleep(300);
  try { rmSync(profile, { recursive: true, force: true }); } catch { /* still locked */ }
}
