import { apiBase, TOKEN_URL, DATA } from './config.js';
import { clear, download, h, s } from './dom.js';
import { buildExportSvg, downloadPng } from './export.js';
import { buildLayout, drawBody, drawHeader, HEAD_H, layoutRows, PALETTES, ROW_H } from './gantt.js';
import { Store, StoreError } from './github.js';
import {
  durationForEnd, findIssues, isMilestone, mergeDocs, schedule, takeBaseline, toDay, toIso, validateDoc, weekSummary,
} from './model.js';
import { phaseName, taskName, toMspdi } from './mspdi.js';
import { renderSettings, renderTaskDrawer } from './panels.js';

const ZOOMS = { week: 14, month: 6, all: 2 };
const SAVE_DELAY_MS = 15000;
const POLL_MS = 180000;
const TOKEN_KEY = 'schedule.token';
const PREFS_KEY = 'schedule.prefs';

const storage = {
  get(key) { try { return localStorage.getItem(key); } catch { return null; } },
  set(key, value) { try { localStorage.setItem(key, value); } catch { /* private mode */ } },
  del(key) { try { localStorage.removeItem(key); } catch { /* private mode */ } },
};

function loadPrefs() {
  const defaults = {
    zoom: 'all', layout: 'heading', lang: 'he', showDeps: true, showCritical: true, showBaseline: false, theme: 'auto', collapsed: [], owner: '', track: '', query: '', tab: 'gantt',
  };
  try { return { ...defaults, ...JSON.parse(storage.get(PREFS_KEY) || '{}') }; } catch { return defaults; }
}

const state = {
  store: null,
  doc: null,
  baseJson: null, // last version known to match GitHub
  sha: null,
  sched: null,
  issues: [],
  remoteIssues: new Map(),
  prefs: loadPrefs(),
  selected: null,
  panel: null, // 'task' | 'settings'
  history: [],
  future: [],
  dirty: false,
  saving: false,
  saveError: null,
  whatIf: null, // JSON of the real plan while experimenting
  savedAt: null,
  drag: null,
};

let saveTimer = null;
const nodes = {};

export function todayIso() {
  const d = new Date();
  const local = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 10);
}

const fmt = (day) => { const i = toIso(day); return `${i.slice(8)}.${i.slice(5, 7)}.${i.slice(2, 4)}`; };
const fmtShort = (day) => { const i = toIso(day); return `${i.slice(8)}.${i.slice(5, 7)}`; };

export function toast(text) {
  const el = h('div', { class: 'toast' }, text);
  document.getElementById('toasts').append(el);
  setTimeout(() => el.remove(), 6000);
}

function savePrefs() {
  storage.set(PREFS_KEY, JSON.stringify(state.prefs));
}

function themeName() {
  const t = state.prefs.theme;
  if (t === 'light' || t === 'dark') return t;
  return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function applyTheme() {
  const t = state.prefs.theme;
  if (t === 'auto') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = t;
}

function recompute() {
  state.sched = schedule(state.doc);
  state.issues = findIssues(state.doc, state.sched, todayIso());
}

function lateMilestones() {
  return new Set(state.issues.filter((i) => i.code === 'missed-fixed').map((i) => i.taskId));
}

export function personName(id) {
  if (!id || id === 'both') return 'שניהם';
  return state.doc.people?.find((p) => p.id === id)?.name || id;
}

export function taskById(id) {
  return state.doc.tasks.find((t) => t.id === id);
}

// Every edit goes through here so undo, recalculation and saving stay in step.
export function commit(mutate, { render: doRender = true } = {}) {
  state.history.push(JSON.stringify(state.doc));
  if (state.history.length > 60) state.history.shift();
  state.future = [];
  mutate(state.doc);
  afterChange(doRender);
}

function afterChange(doRender = true) {
  recompute();
  if (!state.whatIf) markDirty();
  if (doRender) render();
}

function undo() {
  if (!state.history.length) return;
  state.future.push(JSON.stringify(state.doc));
  state.doc = JSON.parse(state.history.pop());
  afterChange();
}

function redo() {
  if (!state.future.length) return;
  state.history.push(JSON.stringify(state.doc));
  state.doc = JSON.parse(state.future.pop());
  afterChange();
}

function markDirty() {
  state.dirty = JSON.stringify(state.doc) !== state.baseJson;
  clearTimeout(saveTimer);
  if (state.dirty) saveTimer = setTimeout(() => saveNow(), SAVE_DELAY_MS);
  renderSync();
}

// Describes what changed, so the file's history on GitHub stays readable.
function describeChange(baseText, doc) {
  const base = JSON.parse(baseText);
  const before = new Map(base.tasks.map((t) => [t.id, JSON.stringify(t)]));
  const after = new Map(doc.tasks.map((t) => [t.id, JSON.stringify(t)]));
  const changed = doc.tasks.filter((t) => before.has(t.id) && before.get(t.id) !== after.get(t.id)).map((t) => t.id);
  const added = doc.tasks.filter((t) => !before.has(t.id)).map((t) => t.id);
  const removed = base.tasks.filter((t) => !after.has(t.id)).map((t) => t.id);
  const parts = [];
  if (changed.length) parts.push(`updated ${changed.slice(0, 6).join(', ')}${changed.length > 6 ? ` +${changed.length - 6}` : ''}`);
  if (added.length) parts.push(`added ${added.join(', ')}`);
  if (removed.length) parts.push(`removed ${removed.join(', ')}`);
  return `Schedule: ${parts.join('; ') || 'settings'}`;
}

function serialize(doc) {
  return `${JSON.stringify(doc, null, 1)}\n`;
}

async function saveNow() {
  clearTimeout(saveTimer);
  if (state.whatIf || state.saving || !state.dirty) return;
  state.saving = true;
  state.saveError = null;
  renderSync();
  try {
    await pushWithMerge();
    state.savedAt = new Date();
  } catch (err) {
    state.saveError = err.message;
    if (err.kind === 'auth') toast('צריך להתחבר מחדש: הטוקן כבר לא תקף. השינויים נשמרים בעמוד הפתוח עד שתתחברו.');
    else toast(`השמירה נכשלה: ${err.message}`);
  } finally {
    state.saving = false;
    renderSync();
    if (JSON.stringify(state.doc) !== state.baseJson) state.dirty = true;
  }
}

async function pushWithMerge() {
  for (let attempt = 0; attempt < 3; attempt++) {
    const snapshot = JSON.stringify(state.doc);
    const text = serialize(state.doc);
    try {
      state.sha = await state.store.save(text, state.sha, describeChange(state.baseJson, state.doc));
      state.baseJson = snapshot;
      state.dirty = JSON.stringify(state.doc) !== state.baseJson;
      if (state.dirty) saveTimer = setTimeout(() => saveNow(), SAVE_DELAY_MS);
      return;
    } catch (err) {
      if (!(err instanceof StoreError) || err.kind !== 'conflict') throw err;
      await pullAndMerge();
    }
  }
  throw new StoreError('conflict', 'הקובץ ממשיך להשתנות. נסו שוב עוד דקה.');
}

async function pullAndMerge() {
  const remote = await state.store.load();
  const theirs = JSON.parse(remote.text);
  const { merged, conflicts } = mergeDocs(JSON.parse(state.baseJson), state.doc, theirs);
  state.doc = merged;
  state.baseJson = JSON.stringify(theirs);
  state.sha = remote.sha;
  recompute();
  render();
  if (conflicts.length) {
    const names = conflicts.map((c) => (c.collection === 'tasks' ? taskById(c.id)?.name || c.id : c.id)).slice(0, 4).join(', ');
    toast(`עדכון מקביל: אותה רשומה נערכה משני הצדדים (${names}). נשמרה הגרסה שלך; הגרסה השנייה בהיסטוריה של GitHub.`);
  } else {
    toast('התקבל עדכון מקביל, והוא מוזג עם השינויים שלך.');
  }
}

async function pollRemote() {
  if (!state.store || state.saving || state.whatIf || state.drag || document.hidden) return;
  try {
    const remote = await state.store.load();
    if (remote.sha === state.sha) return;
    if (state.dirty) {
      await pullAndMerge();
    } else {
      state.doc = JSON.parse(remote.text);
      state.baseJson = JSON.stringify(state.doc);
      state.sha = remote.sha;
      state.history = [];
      state.future = [];
      recompute();
      render();
      toast('הלו"ז עודכן משינוי שנשמר במקום אחר.');
    }
  } catch { /* the next poll retries */ }
}

async function refreshIssues() {
  try {
    state.remoteIssues = await state.store.listIssues();
    render();
  } catch { /* linked Issue badges are optional */ }
}

export async function createIssueFor(task) {
  const r = state.sched.rows.get(task.id);
  const people = state.doc.people || [];
  const assignees = task.owner === 'both'
    ? people.map((p) => p.github).filter(Boolean)
    : [people.find((p) => p.id === task.owner)?.github].filter(Boolean);
  const criteria = (task.criteria || []).map((c) => `- [ ] ${c}`).join('\n') || '- [ ] Required result is documented or implemented.\n- [ ] Relevant checks and evidence are recorded.';
  const body = [
    '### Objective', task.note || task.name, '',
    '### Acceptance criteria', criteria, '',
    '### Materials and dependencies', `Schedule task \`${task.id}\`, planned ${toIso(r.start)} to ${toIso(r.end)}.`, '',
    '### Verification and handoff', '_To be filled in as work proceeds._',
  ].join('\n');
  try {
    const issue = await state.store.createIssue(task.name, body, assignees);
    state.remoteIssues.set(issue.number, issue);
    commit((doc) => { doc.tasks.find((t) => t.id === task.id).issue = issue.number; });
    toast(`נפתח Issue מספר ${issue.number}.`);
  } catch (err) {
    toast(`לא הצלחתי לפתוח Issue: ${err.message}`);
  }
}

// --- rows ---

function matches(t) {
  const { owner, track, query } = state.prefs;
  if (owner && t.owner !== owner && t.backup !== owner) return false;
  if (track && t.track !== track) return false;
  if (query) {
    const q = query.toLowerCase();
    if (!`${t.name} ${t.nameEn || ''} ${t.id}`.toLowerCase().includes(q)) return false;
  }
  return true;
}

// Without a chart layout yet, this gives the plain list, used to size the table.
function visibleRows(L) {
  return layoutRows(state.doc, state.sched, L, L ? state.prefs.layout : 'list', {
    match: matches,
    collapsed: state.prefs.collapsed,
    filtering: !!(state.prefs.owner || state.prefs.track || state.prefs.query),
  });
}

function currentBaseline() {
  if (!state.prefs.showBaseline) return null;
  const list = state.doc.baselines || [];
  return list[list.length - 1] || null;
}

// --- rendering ---

function renderSync() {
  if (!nodes.sync) return;
  const el = nodes.sync;
  el.className = 'sync';
  if (state.whatIf) el.textContent = 'בדיקת "מה אם": לא נשמר';
  else if (state.saving) el.textContent = 'שומר ב-GitHub…';
  else if (state.saveError) { el.textContent = `לא נשמר: ${state.saveError}`; el.classList.add('bad'); }
  else if (state.dirty) el.textContent = 'יש שינויים, נשמרים בעוד רגע';
  else if (state.savedAt) el.textContent = `נשמר ב-${state.savedAt.toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' })}`;
  else el.textContent = 'מעודכן מול GitHub';
  if (nodes.saveBtn) nodes.saveBtn.disabled = !state.dirty || state.saving || !!state.whatIf;
  if (nodes.undoBtn) nodes.undoBtn.disabled = !state.history.length;
  if (nodes.redoBtn) nodes.redoBtn.disabled = !state.future.length;
}

function setPref(key, value) {
  state.prefs[key] = value;
  savePrefs();
  render();
}

function selectTask(id) {
  state.selected = id;
  state.panel = id ? 'task' : null;
  render();
}

function nextDeadline() {
  const today = toDay(todayIso());
  return state.doc.tasks
    .filter((t) => t.type === 'deadline' && t.status !== 'done')
    .map((t) => ({ t, day: state.sched.rows.get(t.id)?.end }))
    .filter((x) => x.day !== undefined && x.day >= today)
    .sort((a, b) => a.day - b.day)[0];
}

function renderTop() {
  const today = toDay(todayIso());
  const total = state.doc.tasks.length;
  const done = state.doc.tasks.filter((t) => t.status === 'done').length;
  const severe = state.issues.filter((i) => i.level !== 'warning').length;
  const open = state.issues.filter((i) => i.level === 'warning').length;
  const nd = nextDeadline();
  nodes.sync = h('span', { class: 'sync' });
  return h('header', { class: 'topbar' },
    h('h1', {}, state.doc.title),
    nodes.sync,
    h('div', { class: 'grow' }),
    h('div', { class: 'kpis' },
      nd && h('button', { class: 'kpi', onclick: () => selectAndReveal(nd.t.id), title: 'פתיחת המשימה' },
        'ההגשה הבאה:', h('b', {}, nd.day - today === 0 ? 'היום' : `עוד ${nd.day - today} ימים`), taskName(nd.t, 'he')),
      h('span', { class: 'kpi' }, 'הושלמו', h('b', { class: 'num' }, `${done}/${total}`)),
      h('button', {
        class: `kpi ${severe ? 'attn' : ''}`,
        onclick: () => setPref('tab', 'issues'),
      }, severe ? 'בעיות:' : 'לבדיקה:', h('b', { class: 'num' }, severe || open))));
}

function selectAndReveal(id) {
  state.prefs.tab = 'gantt';
  const t = taskById(id);
  if (t) state.prefs.collapsed = state.prefs.collapsed.filter((p) => p !== t.phase);
  state.selected = id;
  state.panel = 'task';
  savePrefs();
  render();
  requestAnimationFrame(() => {
    const row = nodes.tbody?.querySelector(`[data-row="${CSS.escape(id)}"]`);
    row?.scrollIntoView({ block: 'center', inline: 'nearest' });
    const r = state.sched.rows.get(id);
    if (r) scrollToDay(r.start);
  });
}

function renderToolbar() {
  const p = state.prefs;
  const tab = (key, label) => h('button', {
    role: 'tab', 'aria-selected': String(p.tab === key), onclick: () => setPref('tab', key),
  }, label);
  const zoom = (key, label) => h('button', { 'aria-pressed': String(p.zoom === key), onclick: () => setPref('zoom', key) }, label);
  const heading = () => {
    const name = window.prompt('שם הכותרת החדשה:');
    if (!name || !name.trim()) return;
    const id = `p${Date.now().toString(36)}`;
    state.lastPhase = id;
    commit((doc) => { doc.phases.push({ id, name: name.trim() }); });
  };
  const toggle = (key, label) => h('label', { class: 'check' },
    h('input', { type: 'checkbox', checked: p[key], onchange: (e) => setPref(key, e.target.checked) }), label);
  nodes.undoBtn = h('button', { class: 'btn', onclick: undo, title: 'ביטול (Ctrl+Z)' }, 'ביטול');
  nodes.redoBtn = h('button', { class: 'btn', onclick: redo, title: 'שחזור (Ctrl+Y)' }, 'שחזור');
  nodes.saveBtn = h('button', { class: 'btn', onclick: saveNow }, 'שמירה');
  const owners = [['', 'כולם'], ['both', 'שניהם'], ...(state.doc.people || []).map((x) => [x.id, x.name])];
  return h('div', { class: 'toolbar' },
    h('div', { class: 'tabs', role: 'tablist' }, tab('gantt', 'גאנט'), tab('week', 'השבוע'), tab('issues', `בעיות ובדיקות (${state.issues.length})`)),
    h('button', { class: 'btn primary', onclick: () => addTask() }, '+ משימה'),
    h('button', { class: 'btn', onclick: heading }, '+ כותרת'),
    nodes.undoBtn, nodes.redoBtn, nodes.saveBtn,
    p.tab === 'gantt' && h('span', { class: 'field-inline' }, 'תצוגה',
      h('div', { class: 'tabs' }, zoom('week', 'שבועות'), zoom('month', 'חודשים'), zoom('all', 'כל השנה'))),
    p.tab === 'gantt' && h('span', { class: 'field-inline' }, 'פריסה',
      h('div', { class: 'tabs' },
        [['heading', 'לפי כותרות'], ['together', 'הכול יחד'], ['list', 'שורה לכל משימה']].map(([key, label]) => h('button', {
          'aria-pressed': String(p.layout === key), onclick: () => setPref('layout', key),
        }, label)))),
    p.tab === 'gantt' && h('button', { class: 'btn', onclick: () => scrollToDay(toDay(todayIso())) }, 'להיום'),
    h('label', { class: 'field-inline' }, 'אחראי',
      h('select', { onchange: (e) => setPref('owner', e.target.value) },
        owners.map(([v, l]) => h('option', { value: v, selected: p.owner === v }, l)))),
    h('label', { class: 'field-inline' }, 'מסלול',
      h('select', { onchange: (e) => setPref('track', e.target.value) },
        [['', 'הכול'], ['hw', 'חומרה'], ['fw', 'קושחה'], ['veh', 'רכב'], ['docs', 'מסמכים']].map(([v, l]) => h('option', { value: v, selected: p.track === v }, l)))),
    h('input', {
      type: 'search', placeholder: 'חיפוש…', value: p.query, 'aria-label': 'חיפוש משימה',
      onchange: (e) => setPref('query', e.target.value),
    }),
    p.tab === 'gantt' && toggle('showCritical', 'סימון מרווח קטן'),
    p.tab === 'gantt' && toggle('showDeps', 'קווי תלות'),
    p.tab === 'gantt' && (state.doc.baselines || []).length > 0 && toggle('showBaseline', 'קו בסיס'),
    h('div', { class: 'grow' }),
    h('button', { class: `btn ${state.whatIf ? 'on' : ''}`, onclick: toggleWhatIf }, 'בדיקת "מה אם"'),
    renderExportMenu(),
    h('button', { class: 'btn', onclick: () => { state.panel = 'settings'; state.selected = null; render(); } }, 'הגדרות'));
}

function renderExportMenu() {
  const wrap = h('div', { class: 'menu-wrap' });
  const close = () => wrap.querySelector('.menu')?.remove();
  const item = (label, fn) => h('button', { onclick: () => { close(); fn(); } }, label);
  const btn = h('button', {
    class: 'btn', 'aria-haspopup': 'true',
    onclick: (e) => {
      e.stopPropagation();
      if (wrap.querySelector('.menu')) { close(); return; }
      wrap.append(h('div', { class: 'menu' },
        item('תמונה (PNG) בעברית', () => exportPng('he')),
        item('תמונה (PNG) באנגלית לדו"ח', () => exportPng('en')),
        item('הדפסה / PDF בעברית', () => exportPrint('he')),
        item('הדפסה / PDF באנגלית', () => exportPrint('en')),
        item('XML ל-MS Project / ProjectLibre', exportXml),
        item('גיבוי נתונים (JSON)', exportJson)));
      document.addEventListener('click', close, { once: true });
    },
  }, 'ייצוא');
  wrap.append(btn);
  return wrap;
}

function exportOptions(lang) {
  return {
    lang,
    baseline: (state.doc.baselines || []).at(-1) || null,
    todayDay: toDay(todayIso()),
    criticalDays: state.doc.settings?.criticalDays ?? 7,
    lateMilestones: lateMilestones(),
    layout: state.prefs.layout,
  };
}

function exportPng(lang) {
  downloadPng(buildExportSvg(state.doc, state.sched, exportOptions(lang)), `schedule-${todayIso()}-${lang}.png`)
    .catch(() => toast('לא הצלחתי ליצור תמונה.'));
}

function exportPrint(lang) {
  const root = clear(document.getElementById('print-root'));
  root.append(buildExportSvg(state.doc, state.sched, exportOptions(lang)));
  window.print();
}

function exportXml() {
  download(`schedule-${todayIso()}.xml`, new Blob([toMspdi(state.doc, state.sched, state.prefs.lang)], { type: 'application/xml' }));
}

function exportJson() {
  download(`schedule-${todayIso()}.json`, new Blob([serialize(state.doc)], { type: 'application/json' }));
}

function toggleWhatIf() {
  if (state.whatIf) {
    state.doc = JSON.parse(state.whatIf);
    state.whatIf = null;
    state.history = [];
    state.future = [];
    recompute();
    render();
    markDirty();
    toast('חזרתם לתוכנית האמיתית. שינויי הבדיקה בוטלו.');
  } else {
    state.whatIf = JSON.stringify(state.doc);
    render();
  }
}

function adoptWhatIf() {
  state.whatIf = null;
  recompute();
  render();
  markDirty();
  toast('השינויים אומצו לתוכנית.');
}

function whatIfImpact() {
  const before = schedule(JSON.parse(state.whatIf));
  const moved = state.doc.tasks.filter((t) => {
    const a = before.rows.get(t.id);
    const b = state.sched.rows.get(t.id);
    return a && b && (a.start !== b.start || a.end !== b.end);
  }).length;
  const newly = state.issues.filter((i) => i.code === 'missed-fixed');
  return { moved, endDelta: state.sched.projectEnd - before.projectEnd, missed: newly };
}

function renderBanners() {
  const out = [];
  if (state.whatIf) {
    const imp = whatIfImpact();
    out.push(h('div', { class: 'banner' },
      h('b', {}, 'בדיקת "מה אם":'),
      `${imp.moved} משימות זזו`,
      imp.endDelta ? ` · הסיום זז ב-${imp.endDelta} ימים` : '',
      imp.missed.length
        ? ` · מועדים שנפגעים: ${imp.missed.map((i) => taskName(taskById(i.taskId), 'he')).join(', ')}`
        : ' · אף מועד קבוע לא נפגע',
      h('div', { class: 'grow' }),
      h('button', { class: 'btn', onclick: adoptWhatIf }, 'לאמץ לתוכנית'),
      h('button', { class: 'btn', onclick: toggleWhatIf }, 'לבטל')));
  }
  return out;
}

// Lists only what is on the chart right now, so the legend stays readable.
function renderLegend() {
  const tasks = state.doc.tasks;
  const bars = tasks.filter((t) => !isMilestone(t));
  const item = (cls, label) => h('span', {}, h('i', { class: `swatch ${cls}` }), label);
  const tracks = [['hw', 'חומרה'], ['fw', 'קושחה'], ['veh', 'רכב'], ['docs', 'מסמכים']]
    .filter(([key]) => bars.some((t) => t.track === key));
  return h('div', { class: 'legend' },
    tracks.map(([key, label]) => item(key, label)),
    bars.some((t) => t.external) && item('ext', 'תלוי בגורם חיצוני'),
    bars.length > 0 && item('tight', `מרווח של עד ${state.doc.settings?.criticalDays ?? 7} ימים`),
    tasks.some((t) => isMilestone(t) && !t.unverified) && item('dia', 'מועד'),
    tasks.some((t) => isMilestone(t) && t.unverified) && item('dia open', 'מועד לא מאומת'),
    (state.doc.blackouts || []).length > 0 && item('band', 'תקופה חסומה'),
    h('span', { class: 'hint' }, 'לחיצה על שורה פותחת עריכה. גרירה בתרשים מזיזה את התאריך.'));
}

function statusCell(t) {
  const map = { done: ['done', '✓ הושלם'], doing: ['doing', 'בעבודה'], blocked: ['blocked', 'חסום'], todo: ['todo', 'לא התחיל'] };
  const [cls, label] = map[t.status] || map.todo;
  return h('span', { class: `c-status st ${cls}` }, label);
}

// The name column is as wide as the longest name, so nothing is cut off, up to a
// limit that leaves room for the chart. Longer names wrap onto a second line.
function nameColumnWidth(rows) {
  const { layout } = state.prefs;
  if (layout === 'together') return 0;
  if (innerWidth <= 900) return layout === 'heading' ? 96 : 170;
  const ctx = document.createElement('canvas').getContext('2d');
  ctx.font = '700 14px system-ui, -apple-system, "Segoe UI", Arial, sans-serif';
  let widest = 120;
  for (const row of rows) {
    if (layout === 'heading' && row.kind !== 'phase') continue;
    const t = row.task;
    const text = row.kind === 'phase' ? phaseName(row.phase, state.prefs.lang) : taskName(t, state.prefs.lang);
    let w = ctx.measureText(text).width + 34;
    if (t?.decision) w += 50;
    if (t?.unverified) w += 66;
    if (t?.issue) w += 60;
    widest = Math.max(widest, w);
  }
  return Math.ceil(Math.min(widest, innerWidth * 0.36));
}

function renderTableRows(rows) {
  const out = [];
  for (const row of rows) {
    if (row.kind === 'phase' || row.kind === 'task') out.push(renderTableRow(row));
    else if (row.first) {
      const el = renderTableRow({ kind: 'phase', phase: row.phase, roll: row.roll });
      el.style.height = `${row.count * ROW_H}px`;
      out.push(el);
    }
  }
  return out;
}

function renderTableRow(row) {
  if (row.kind === 'phase') {
    const collapsed = state.prefs.collapsed.includes(row.phase.id);
    const roll = row.roll;
    return h('button', {
      class: 'row phase', 'aria-expanded': String(!collapsed),
      onclick: () => {
        const list = state.prefs.collapsed;
        setPref('collapsed', collapsed ? list.filter((x) => x !== row.phase.id) : [...list, row.phase.id]);
      },
    },
    h('span', { class: 'c-name' },
      h('span', { class: 'chev' }, collapsed ? '‹' : '⌄'),
      h('span', { class: 'label' }, phaseName(row.phase, state.prefs.lang))),
    h('span', { class: 'c-status' }, roll ? `${roll.done}/${roll.total} הושלמו` : ''),
    h('span', { class: 'c-owner' }),
    h('span', { class: 'c-dates num' }, roll ? `${fmtShort(roll.start)}–${fmtShort(roll.end)}` : ''),
    h('span', { class: 'c-slack' }));
  }
  const t = row.task;
  const r = state.sched.rows.get(t.id);
  const issue = t.issue && state.remoteIssues.get(t.issue);
  const showSlack = r && t.status !== 'done' && !(isMilestone(t) && t.fixed);
  return h('button', {
    class: `row task ${state.selected === t.id ? 'sel' : ''}`,
    dataset: { row: t.id },
    onclick: () => selectTask(t.id),
    onmouseenter: (e) => setHover(e.currentTarget, t.id),
    onmouseleave: (e) => setHover(e.currentTarget, null),
  },
  h('span', { class: 'c-name' },
    isMilestone(t) && h('span', { 'aria-hidden': 'true' }, '◆'),
    h('span', { class: 'label', title: taskName(t, state.prefs.lang) }, taskName(t, state.prefs.lang)),
    t.decision && h('span', { class: 'tag q' }, 'החלטה'),
    t.unverified && h('span', { class: 'tag q' }, 'לא מאומת'),
    t.issue && h('span', { class: 'tag issue' }, `Issue ${t.issue}${issue?.state === 'closed' ? ' סגור' : ''}`)),
  statusCell(t),
  h('span', { class: 'c-owner' }, personName(t.owner)),
  h('span', { class: 'c-dates num' }, r ? (isMilestone(t) ? fmt(r.end) : `${fmtShort(r.start)}–${fmtShort(r.end)}`) : ''),
  h('span', { class: `c-slack num ${showSlack && r.slack < 0 ? 'bad' : ''}`, title: 'מרווח בימים עד שהמשימה פוגעת במועד' },
    showSlack && r.slack < 90 ? `${r.slack}` : ''));
}

function setHover(rowEl, id) {
  if (!nodes.hover) return;
  if (!id) { nodes.hover.setAttribute('visibility', 'hidden'); return; }
  const index = nodes.rowIndex.get(id);
  if (index === undefined) return;
  nodes.hover.setAttribute('y', index * ROW_H);
  nodes.hover.setAttribute('visibility', 'visible');
}

// "All of it" fits the whole project into the space beside the table.
function pixelsPerDay(nameW) {
  if (state.prefs.zoom !== 'all') return ZOOMS[state.prefs.zoom];
  const phone = innerWidth <= 900;
  const table = nameW + (phone || state.prefs.layout !== 'list' ? 0 : 220);
  const panel = state.panel && !phone ? 380 : 0;
  const days = state.sched.projectEnd - state.sched.projectStart + 29;
  return Math.max(ZOOMS.all, (innerWidth - table - panel - 18) / days);
}

function renderGantt() {
  const prefs = state.prefs;
  const P = PALETTES[themeName()];
  const nameW = nameColumnWidth(visibleRows());
  const L = buildLayout(state.doc, state.sched, { ppd: pixelsPerDay(nameW), lang: prefs.lang });
  const rows = visibleRows(L);
  const todayDay = toDay(todayIso());
  const body = drawBody(L, state.doc, state.sched, rows, P, {
    showDeps: prefs.showDeps,
    showCritical: prefs.showCritical,
    criticalDays: state.doc.settings?.criticalDays ?? 7,
    baseline: currentBaseline(),
    todayDay,
    lateMilestones: lateMilestones(),
    interactive: true,
    selected: state.selected,
  });
  nodes.hover = body.hover;
  nodes.rowIndex = new Map(rows.filter((row) => row.kind === 'task').map((row) => [row.task.id, rows.indexOf(row)]));
  nodes.layout = L;

  const head = s('svg', { class: 'head-svg', width: L.width, height: HEAD_H, role: 'img', 'aria-label': 'ציר זמן' });
  head.append(drawHeader(L, state.doc, P, todayDay));
  const svg = s('svg', {
    class: 'body-svg', width: L.width, height: body.height, role: 'img',
    'aria-label': 'תרשים גאנט. אותם נתונים מופיעים בטבלה שלצדו.',
    'font-family': 'system-ui, -apple-system, "Segoe UI", Arial, sans-serif',
  });
  svg.append(body.node);
  nodes.svg = svg;
  svg.addEventListener('pointerdown', onChartPointerDown);
  svg.addEventListener('pointermove', onChartHover);
  svg.addEventListener('pointerleave', hideTooltip);

  const tbody = h('div', { class: 'tbody' }, renderTableRows(rows));
  nodes.tbody = tbody;
  const th = h('div', { class: 'th' },
    h('span', { class: 'c-name' }, prefs.layout === 'list' ? 'שם' : 'כותרת'),
    h('span', { class: 'c-status' }, 'סטטוס'),
    h('span', { class: 'c-owner' }, 'אחראי'),
    h('span', { class: 'c-dates' }, 'תאריכים'),
    h('span', { class: 'c-slack' }, 'מרווח בימים'));
  const grid = h('div', { class: `gantt ${prefs.lang === 'en' ? 'ltr' : ''} ${prefs.layout}` }, th, head, tbody, svg);
  grid.style.setProperty('--name-w', `${nameW}px`);
  return grid;
}

export function scrollToDay(day) {
  const scroller = nodes.scroller;
  if (!scroller || !nodes.svg || !nodes.layout) return;
  const rect = nodes.svg.getBoundingClientRect();
  const box = scroller.getBoundingClientRect();
  const table = nodes.tbody?.getBoundingClientRect().width || 0;
  const target = rect.left + nodes.layout.x(day);
  const he = state.prefs.lang === 'he';
  const visibleCenter = he ? box.left + (box.width - table) * 0.65 : box.left + table + (box.width - table) * 0.35;
  scroller.scrollLeft += target - visibleCenter;
}

// --- chart interaction ---

function barTaskFrom(event) {
  return event.target.closest?.('[data-task]');
}

function onChartPointerDown(event) {
  if (event.button !== 0) return;
  const hit = barTaskFrom(event);
  if (!hit) return;
  const id = hit.dataset.task;
  const task = taskById(id);
  if (!task) return;
  const r = state.sched.rows.get(id);
  event.preventDefault();
  hideTooltip();
  nodes.svg.setPointerCapture(event.pointerId);
  state.drag = {
    id, mode: event.target.dataset.part === 'end' && !isMilestone(task) ? 'resize' : 'move',
    startX: event.clientX, moved: false, before: JSON.stringify(state.doc),
    origStart: r.start, origEnd: r.end, floor: r.depFloor, lastDelta: 0, pointerType: event.pointerType,
  };
  nodes.svg.addEventListener('pointermove', onDragMove);
  nodes.svg.addEventListener('pointerup', onDragEnd);
  nodes.svg.addEventListener('pointercancel', onDragCancel);
}

function applyDrag(delta) {
  const d = state.drag;
  const task = taskById(d.id);
  if (d.mode === 'resize') {
    const newEnd = Math.max(d.origEnd + delta, d.origStart);
    task.duration = durationForEnd(task, state.doc, d.origStart, newEnd);
  } else {
    const newStart = d.origStart + delta;
    if (task.fixed) task.fixed = toIso(newStart);
    else task.start = toIso(newStart);
  }
  recompute();
}

function onDragMove(event) {
  const d = state.drag;
  if (!d) return;
  const px = event.clientX - d.startX;
  if (!d.moved && Math.abs(px) < 4) return;
  // Touch can scroll the chart, so dragging by finger is left to the edit panel.
  if (d.pointerType === 'touch') return;
  d.moved = true;
  const L = nodes.layout;
  const delta = Math.round((px * L.sign) / L.ppd);
  if (delta === d.lastDelta) return;
  d.lastDelta = delta;
  applyDrag(delta);
  redrawGantt();
  const r = state.sched.rows.get(d.id);
  showTooltipAt(event.clientX, event.clientY, h('div', {},
    h('b', {}, taskName(taskById(d.id), 'he')),
    h('span', { class: 'num' }, isMilestone(taskById(d.id)) ? fmt(r.end) : `${fmt(r.start)} – ${fmt(r.end)}`)));
}

function endDragListeners() {
  nodes.svg?.removeEventListener('pointermove', onDragMove);
  nodes.svg?.removeEventListener('pointerup', onDragEnd);
  nodes.svg?.removeEventListener('pointercancel', onDragCancel);
}

function onDragEnd() {
  const d = state.drag;
  endDragListeners();
  state.drag = null;
  hideTooltip();
  if (!d) return;
  if (!d.moved) { selectTask(d.id); return; }
  const task = taskById(d.id);
  const r = state.sched.rows.get(d.id);
  if (d.mode === 'move' && !task.fixed && d.origStart + d.lastDelta < r.depFloor) {
    const blocker = r.drivenBy ? taskName(taskById(r.drivenBy), 'he') : 'משימה קודמת';
    toast(`אי אפשר להקדים: המשימה מחכה ל"${blocker}". אפשר להסיר את התלות בחלונית העריכה.`);
  }
  state.history.push(d.before);
  if (state.history.length > 60) state.history.shift();
  state.future = [];
  afterChange();
}

function onDragCancel() {
  const d = state.drag;
  endDragListeners();
  state.drag = null;
  hideTooltip();
  if (d) {
    state.doc = JSON.parse(d.before);
    recompute();
    render();
  }
}

// Replaces the chart mid-drag while keeping the same svg element, because the
// element holds the pointer capture.
function redrawGantt() {
  const prefs = state.prefs;
  const P = PALETTES[themeName()];
  const L = nodes.layout;
  const rows = visibleRows(L);
  const body = drawBody(L, state.doc, state.sched, rows, P, {
    showDeps: prefs.showDeps,
    showCritical: prefs.showCritical,
    criticalDays: state.doc.settings?.criticalDays ?? 7,
    baseline: currentBaseline(),
    todayDay: toDay(todayIso()),
    lateMilestones: lateMilestones(),
    interactive: true,
    selected: state.selected,
  });
  nodes.hover = body.hover;
  nodes.svg.setAttribute('height', body.height);
  nodes.svg.replaceChildren(body.node);
  const tbody = nodes.tbody;
  tbody.replaceChildren(...renderTableRows(rows));
  nodes.svg.classList.add('dragging');
}

function hideTooltip() {
  document.querySelector('.tooltip')?.remove();
}

function showTooltipAt(x, y, content) {
  hideTooltip();
  const el = h('div', { class: 'tooltip' }, content);
  document.body.append(el);
  const w = el.offsetWidth;
  const hgt = el.offsetHeight;
  el.style.left = `${Math.max(8, Math.min(x + 14, innerWidth - w - 8))}px`;
  el.style.top = `${Math.max(8, Math.min(y + 14, innerHeight - hgt - 8))}px`;
}

function onChartHover(event) {
  if (state.drag) return;
  const rect = nodes.svg.getBoundingClientRect();
  const index = Math.floor((event.clientY - rect.top) / ROW_H);
  if (nodes.hover) {
    nodes.hover.setAttribute('y', index * ROW_H);
    nodes.hover.setAttribute('visibility', 'visible');
  }
  const hit = barTaskFrom(event);
  if (!hit) { hideTooltip(); return; }
  const t = taskById(hit.dataset.task);
  const r = t && state.sched.rows.get(t.id);
  if (!r) return;
  const driver = r.drivenBy && taskById(r.drivenBy);
  showTooltipAt(event.clientX, event.clientY, h('div', {},
    h('b', {}, taskName(t, 'he')),
    h('div', { class: 'num' }, isMilestone(t) ? fmt(r.end) : `${fmt(r.start)} – ${fmt(r.end)}`),
    !isMilestone(t) && h('div', {}, `${t.duration || 1} ימי עבודה · ${personName(t.owner)}`),
    driver && h('div', {}, `מחכה ל: ${taskName(driver, 'he')}`),
    t.status !== 'done' && h('div', { class: r.slack < 0 ? 'warn' : '' },
      r.slack < 0 ? `באיחור של ${-r.slack} ימים מול המועד` : `מרווח: ${r.slack} ימים`)));
}

// --- pages ---

function issueText(i) {
  const t = taskById(i.taskId);
  const name = t ? taskName(t, 'he') : i.taskId;
  switch (i.code) {
    case 'cycle': return `תלות מעגלית סביב "${name}": צריך להסיר אחת מהתלויות.`;
    case 'missed-fixed': return `"${name}": ${i.late.map((id) => `"${taskName(taskById(id), 'he')}"`).join(', ')} מסתיים ${i.days} ימים אחרי המועד.`;
    case 'overdue': return `"${name}" הייתה אמורה להסתיים לפני ${i.days} ימים ולא סומנה כהושלמה.`;
    case 'negative-slack': return `"${name}" באיחור של ${i.days} ימים מול מועד שתלוי בה.`;
    case 'unverified': return `"${name}": התאריך עוד לא אומת.`;
    case 'open-decision': return `החלטה פתוחה: "${name}".`;
    default: return name;
  }
}

function listItem(id, when, text, lvl) {
  return h('li', {}, h('button', { onclick: () => selectAndReveal(id) },
    lvl && h('span', { class: `lvl ${lvl}` }, { critical: 'קריטי', serious: 'חמור', warning: 'לבדיקה' }[lvl]),
    when && h('span', { class: 'when num' }, when),
    h('span', {}, text)));
}

function renderIssuesPage() {
  const list = state.issues;
  return h('div', { class: 'page' }, h('div', { class: 'page-inner' },
    h('section', {},
      h('h2', {}, `בעיות ובדיקות פתוחות (${list.length})`),
      h('ul', { class: 'list' },
        list.length
          ? list.map((i) => listItem(i.taskId, null, issueText(i), i.level))
          : h('li', { class: 'empty' }, 'אין בעיות פתוחות.')))));
}

function renderWeekPage() {
  const w = weekSummary(state.doc, state.sched, todayIso());
  const row = (x) => listItem(x.t.id, isMilestone(x.t) ? fmtShort(x.r.end) : `${fmtShort(x.r.start)}–${fmtShort(x.r.end)}`, taskName(x.t, 'he'));
  const section = (title, items, empty) => h('section', {},
    h('h2', {}, title),
    h('ul', { class: 'list' }, items.length ? items.map(row) : h('li', { class: 'empty' }, empty)));
  const text = [
    `עדכון שבועי ${fmt(w.weekStart)}`,
    '',
    'בוצע בשבוע שעבר:',
    ...(w.doneLast.length ? w.doneLast.map((x) => `- ${taskName(x.t, 'he')}`) : ['- (לא סומנו משימות כהושלמו)']),
    '',
    'בעבודה השבוע:',
    ...(w.active.length ? w.active.map((x) => `- ${taskName(x.t, 'he')} (${personName(x.t.owner)})`) : ['- (אין)']),
    ...(w.overdue.length ? ['', 'באיחור:', ...w.overdue.map((x) => `- ${taskName(x.t, 'he')}`)] : []),
  ].join('\n');
  const area = h('textarea', { class: 'weekly', readonly: true, 'aria-label': 'טקסט העדכון השבועי' }, text);
  return h('div', { class: 'page' }, h('div', { class: 'page-inner' },
    h('p', { class: 'hint' }, `שבוע ${fmt(w.weekStart)} – ${fmt(w.weekEnd)}. הנוהל מבקש לעדכן את הפעילות השבועית באתר הפרויקטים בכל יום ראשון.`),
    w.overdue.length > 0 && section('באיחור', w.overdue, ''),
    section('בעבודה השבוע', w.active, 'אין משימות שמתוכננות לשבוע הזה.'),
    section('מועדים ושערים ב-45 הימים הקרובים', w.upcoming, 'אין מועדים קרובים.'),
    section('הושלם מאז תחילת השבוע שעבר', w.doneLast, 'לא סומנו משימות כהושלמו.'),
    h('section', {},
      h('h2', {}, 'טקסט לעדכון השבועי'),
      area,
      h('div', { class: 'actions' },
        h('button', {
          class: 'btn',
          onclick: async () => {
            try { await navigator.clipboard.writeText(text); toast('הועתק.'); } catch { area.select(); toast('סמנתי את הטקסט: העתיקו עם Ctrl+C.'); }
          },
        }, 'העתקה')))));
}

export function addTask(phaseId) {
  const doc = state.doc;
  const selected = state.selected && taskById(state.selected);
  const exists = (p) => doc.phases.some((x) => x.id === p);
  const phase = [phaseId, selected?.phase, state.lastPhase].find(exists) || doc.phases[0]?.id || 'general';
  const id = nextId();
  commit((d) => {
    if (!d.phases.some((x) => x.id === phase)) d.phases.push({ id: phase, name: 'כללי' });
    const task = {
      id, name: 'משימה חדשה', phase, track: selected?.track || 'hw', owner: 'both', type: 'task',
      status: 'todo', duration: 5, start: todayIso(), deps: [],
    };
    const anchor = selected ? d.tasks.findIndex((t) => t.id === selected.id) : -1;
    if (anchor >= 0) d.tasks.splice(anchor + 1, 0, task);
    else d.tasks.push(task);
  }, { render: false });
  state.prefs.collapsed = state.prefs.collapsed.filter((p) => p !== phase);
  state.prefs.tab = 'gantt';
  state.selected = id;
  state.panel = 'task';
  render();
  requestAnimationFrame(() => document.querySelector('[data-focus-name]')?.select());
}

function nextId() {
  let max = 0;
  for (const t of state.doc.tasks) {
    const m = /^T(\d+)$/.exec(t.id);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `T${String(max + 1).padStart(3, '0')}`;
}

export function takeNewBaseline(name) {
  commit((d) => {
    d.baselines = d.baselines || [];
    d.baselines.push(takeBaseline(d, schedule(d), name, todayIso()));
  });
  state.prefs.showBaseline = true;
  savePrefs();
  render();
}

export function disconnect() {
  storage.del(TOKEN_KEY);
  location.reload();
}

export { state, render, selectTask, setPref, themeName, applyTheme, savePrefs, fmt, fmtShort };

let firstGantt = true;

function render() {
  if (!state.doc) return;
  const app = document.getElementById('app');
  const prevScroll = nodes.scroller ? { l: nodes.scroller.scrollLeft, t: nodes.scroller.scrollTop } : null;
  const drawerScroll = app.querySelector('.drawer')?.scrollTop;
  const focusKey = document.activeElement?.dataset?.fieldKey;
  hideTooltip();
  const tab = state.prefs.tab;
  const main = h('div', { class: 'main' });
  nodes.scroller = null;
  if (tab === 'week') main.append(renderWeekPage());
  else if (tab === 'issues') main.append(renderIssuesPage());
  else {
    nodes.scroller = h('div', { class: 'scroller' }, renderGantt());
    main.append(nodes.scroller);
  }
  if (state.panel === 'task' && state.selected && taskById(state.selected)) main.append(renderTaskDrawer());
  if (state.panel === 'settings') main.append(renderSettings());
  app.replaceChildren(
    renderTop(),
    renderToolbar(),
    ...renderBanners(),
    tab === 'gantt' ? renderLegend() : '',
    main,
  );
  renderSync();
  if (nodes.scroller) {
    if (prevScroll && !firstGantt) {
      nodes.scroller.scrollLeft = prevScroll.l;
      nodes.scroller.scrollTop = prevScroll.t;
    } else {
      firstGantt = false;
      scrollToDay(toDay(todayIso()));
    }
  }
  const drawer = app.querySelector('.drawer');
  if (drawer && drawerScroll) drawer.scrollTop = drawerScroll;
  if (focusKey) app.querySelector(`[data-field-key="${CSS.escape(focusKey)}"]`)?.focus();
}

// --- connecting ---

function renderGate(errorText) {
  const input = h('input', { type: 'password', autocomplete: 'off', spellcheck: 'false', placeholder: 'github_pat_…', 'aria-label': 'טוקן GitHub' });
  const connect = async () => {
    const token = input.value.trim();
    if (!token) return;
    await start(token, true);
  };
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') connect(); });
  document.getElementById('app').replaceChildren(h('div', { class: 'gate' }, h('div', { class: 'gate-card' },
    h('h1', {}, 'לו"ז הפרויקט'),
    h('p', {}, 'הקוד של העמוד פומבי, אבל הנתונים נמצאים בריפו הפרטי של הפרויקט. כדי לראות ולערוך אותם צריך להתחבר פעם אחת עם טוקן אישי של GitHub.'),
    h('ol', {},
      h('li', {}, h('a', { href: TOKEN_URL, target: '_blank', rel: 'noopener noreferrer' }, 'פתחו את טופס יצירת הטוקן'), ' (ההגדרות כבר ממולאות).'),
      h('li', {}, `תחת Repository access בחרו Only select repositories ואז ${DATA.repo}.`),
      h('li', {}, 'לחצו Generate token, העתיקו את הטוקן והדביקו אותו כאן.')),
    errorText && h('div', { class: 'err', role: 'alert' }, errorText),
    input,
    h('button', { class: 'btn primary', onclick: connect }, 'התחברות'),
    h('p', { class: 'hint' }, 'הטוקן נשמר רק בדפדפן הזה ונשלח רק אל GitHub. אפשר לבטל אותו בכל רגע בהגדרות של GitHub.'))));
  input.focus();
}

async function start(token, remember) {
  state.store = new Store(token, apiBase());
  document.getElementById('app').replaceChildren(h('p', { class: 'boot' }, 'טוען את הלו"ז מ-GitHub…'));
  try {
    const remote = await state.store.load();
    const doc = JSON.parse(remote.text);
    const errors = validateDoc(doc);
    if (errors.length) throw new StoreError('other', `קובץ הנתונים לא תקין: ${errors.join(', ')}`);
    state.doc = doc;
    state.baseJson = JSON.stringify(doc);
    state.sha = remote.sha;
    if (remember) storage.set(TOKEN_KEY, token);
    recompute();
    applyTheme();
    render();
    refreshIssues();
    setInterval(pollRemote, POLL_MS);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) pollRemote(); });
  } catch (err) {
    if (err.kind === 'auth' || err.kind === 'forbidden' || err.kind === 'notfound') storage.del(TOKEN_KEY);
    renderGate(err.message);
  }
}

document.addEventListener('keydown', (event) => {
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(event.target.tagName);
  if (event.key === 'Escape' && state.panel) {
    state.panel = null;
    state.selected = null;
    render();
    return;
  }
  if (typing || !(event.ctrlKey || event.metaKey)) return;
  if (event.key.toLowerCase() === 'z') { event.preventDefault(); if (event.shiftKey) redo(); else undo(); }
  if (event.key.toLowerCase() === 'y') { event.preventDefault(); redo(); }
  if (event.key.toLowerCase() === 's') { event.preventDefault(); saveNow(); }
});

window.addEventListener('beforeunload', (event) => {
  if (state.dirty) event.preventDefault();
});

matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { if (state.doc && state.prefs.theme === 'auto') render(); });

const saved = storage.get(TOKEN_KEY);
applyTheme();
if (saved) start(saved, false);
else if (apiBase() === '/__mock') start('mock', false);
else renderGate();
