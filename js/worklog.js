// Work log: what was done, by whom and for how long. Entries live in the
// schedule file, each one tied to a task or general (a meeting, say).
import {
  commit, fmt, personName, selectAndReveal, setPref, state, taskById, toast, todayIso,
} from './app.js';
import { download, h } from './dom.js';
import { toDay } from './model.js';
import { taskName } from './mspdi.js';

const entries = () => state.doc.log || [];
const hoursOf = (list) => list.reduce((n, e) => n + (Number(e.hours) || 0), 0);
const hoursText = (n) => String(Math.round(n * 100) / 100);
const countText = (n) => (n === 1 ? 'רישום אחד' : `${n} רישומים`);
const newest = (a, b) => b.date.localeCompare(a.date) || (b.created?.at || '').localeCompare(a.created?.at || '');

function updateEntry(id, fn) {
  commit((doc) => fn(doc.log.find((e) => e.id === id), doc));
}

export function addEntry(taskId) {
  const id = `l${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
  commit((doc) => {
    doc.log = [...(doc.log || []), { id, date: todayIso(), by: state.me || 'both', ...(taskId ? { task: taskId } : {}), text: '' }];
  });
  requestAnimationFrame(() => document.querySelector(`[data-field-key="log-${id}-text"]`)?.focus());
}

function taskLabel(e) {
  const t = e.task && taskById(e.task);
  if (t) return taskName(t, 'he');
  return e.taskName ? `כללי (הייתה: ${e.taskName})` : 'כללי';
}

function taskSelect(e) {
  const options = [['', e.taskName ? `כללי (הייתה: ${e.taskName})` : 'כללי'], ...state.doc.phases.flatMap((p) => state.doc.tasks
    .filter((t) => t.phase === p.id)
    .map((t) => [t.id, `${p.name.trim()} · ${taskName(t, 'he')}`]))];
  return h('select', {
    'aria-label': 'משימה', dataset: { fieldKey: `log-${e.id}-task` },
    onchange: (ev) => updateEntry(e.id, (x) => { if (ev.target.value) x.task = ev.target.value; else delete x.task; }),
  }, options.map(([v, l]) => h('option', { value: v, selected: v === (e.task || '') }, l)));
}

function whoOptions(e) {
  const list = [...(state.doc.people || []).map((p) => [p.id, p.name]), ['both', 'שניהם']];
  if (e.by && !list.some(([v]) => v === e.by)) list.push([e.by, e.by]);
  return list;
}

function renderEntry(e, { onPage }) {
  const key = (f) => `log-${e.id}-${f}`;
  return h('div', { class: 'log-entry', dataset: { entry: e.id } },
    h('div', { class: 'log-meta' },
      h('input', {
        type: 'date', value: e.date, 'aria-label': 'תאריך', dataset: { fieldKey: key('date') },
        onchange: (ev) => { if (ev.target.value) updateEntry(e.id, (x) => { x.date = ev.target.value; }); },
      }),
      h('select', {
        'aria-label': 'מי', dataset: { fieldKey: key('by') },
        onchange: (ev) => updateEntry(e.id, (x) => { x.by = ev.target.value; }),
      }, whoOptions(e).map(([v, l]) => h('option', { value: v, selected: v === e.by }, l))),
      h('label', { class: 'field-inline' }, 'שעות', h('input', {
        type: 'number', min: 0, step: 0.5, value: e.hours ?? '', class: 'hours', dataset: { fieldKey: key('hours') },
        onchange: (ev) => updateEntry(e.id, (x) => {
          const n = Number(ev.target.value);
          if (n > 0) x.hours = n; else delete x.hours;
        }),
      })),
      onPage && taskSelect(e),
      onPage && e.task && taskById(e.task) && h('button', { class: 'icon-btn', onclick: () => selectAndReveal(e.task) }, 'למשימה'),
      h('div', { class: 'grow' }),
      h('button', {
        class: 'icon-btn',
        onclick: () => { if (confirm('למחוק את הרישום מהיומן?')) commit((doc) => { doc.log = doc.log.filter((x) => x.id !== e.id); }); },
      }, 'מחיקה')),
    h('textarea', {
      value: e.text || '', placeholder: 'מה עשינו, איך זה הלך, מה נתקע ואיך פתרנו…', 'aria-label': 'מה עשינו',
      dataset: { fieldKey: key('text') },
      onchange: (ev) => updateEntry(e.id, (x) => { x.text = ev.target.value; }),
    }));
}

// --- in the task panel ---

export function renderTaskLog(t) {
  const list = entries().filter((e) => e.task === t.id).sort(newest);
  const hours = hoursOf(list);
  return h('div', { class: 'f' },
    h('h3', {}, list.length
      ? `יומן עבודה (${countText(list.length)}${hours ? ` · ${hoursText(hours)} שעות` : ''})`
      : 'יומן עבודה'),
    list.map((e) => renderEntry(e, { onPage: false })),
    h('div', { class: 'actions' }, h('button', { class: 'btn', onclick: () => addEntry(t.id) }, '+ רישום ביומן')));
}

// --- the log page ---

function matches(e) {
  const { logWho, logTask, logQuery } = state.prefs;
  if (logWho && e.by !== logWho) return false;
  if (logTask === 'general' && e.task && taskById(e.task)) return false;
  if (logTask && logTask !== 'general' && e.task !== logTask) return false;
  if (logQuery) {
    const q = logQuery.toLowerCase();
    if (!`${e.text || ''} ${taskLabel(e)}`.toLowerCase().includes(q)) return false;
  }
  return true;
}

function weekStartDay() {
  const today = toDay(todayIso());
  return today - new Date(today * 86400000).getUTCDay();
}

const dayTitle = (iso) => `${new Date(`${iso}T12:00:00Z`).toLocaleDateString('he-IL', { weekday: 'long', timeZone: 'UTC' })} ${fmt(toDay(iso))}`;

// Plain text for the project report, oldest first.
function logText(list) {
  const lines = [];
  let day = null;
  for (const e of [...list].sort((a, b) => -newest(a, b))) {
    if (e.date !== day) {
      if (day) lines.push('');
      lines.push(dayTitle(e.date));
      day = e.date;
    }
    const hours = e.hours ? `, ${hoursText(e.hours)} שעות` : '';
    lines.push(`- ${personName(e.by)}${hours} · ${taskLabel(e)}: ${(e.text || '').trim()}`);
  }
  return lines.join('\n');
}

// Spreadsheets run cells that start with = + - @ as formulas, so those get a leading quote.
function csvCell(value) {
  let text = String(value ?? '');
  if (/^[=+\-@]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

function logCsv(list) {
  const head = ['תאריך', 'מי', 'שעות', 'משימה', 'מה עשינו'];
  const rows = [...list].sort((a, b) => -newest(a, b)).map((e) => [e.date, personName(e.by), e.hours ?? '', taskLabel(e), e.text || '']);
  // The byte order mark lets Excel read the Hebrew correctly.
  return `﻿${[head, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n')}\r\n`;
}

export function renderLogPage() {
  const p = state.prefs;
  const all = entries();
  const list = all.filter(matches).sort(newest);
  const weekStart = weekStartDay();
  const thisWeek = list.filter((e) => toDay(e.date) >= weekStart);
  const people = [...(state.doc.people || []).map((x) => x.id), 'both'];
  const perPerson = people.map((id) => [id, hoursOf(list.filter((e) => e.by === id))]).filter(([, n]) => n > 0);
  const groups = [];
  for (const e of list) {
    if (groups.at(-1)?.date !== e.date) groups.push({ date: e.date, items: [] });
    groups.at(-1).items.push(e);
  }
  const taskOptions = [['', 'כל המשימות'], ['general', 'כללי בלבד'], ...state.doc.tasks
    .filter((t) => all.some((e) => e.task === t.id)).map((t) => [t.id, taskName(t, 'he')])];
  const copy = async () => {
    try { await navigator.clipboard.writeText(logText(list)); toast('היומן הועתק כטקסט.'); } catch { toast('הדפדפן לא איפשר העתקה. נסו את ייצוא ה-CSV.'); }
  };
  return h('div', { class: 'page' }, h('div', { class: 'page-inner' },
    h('div', { class: 'log-tools' },
      h('button', { class: 'btn primary', onclick: () => addEntry(null) }, '+ רישום חדש'),
      h('label', { class: 'field-inline' }, 'מי',
        h('select', { onchange: (e) => setPref('logWho', e.target.value) },
          [['', 'כולם'], ...(state.doc.people || []).map((x) => [x.id, x.name]), ['both', 'שניהם']]
            .map(([v, l]) => h('option', { value: v, selected: p.logWho === v }, l)))),
      h('label', { class: 'field-inline' }, 'משימה',
        h('select', { onchange: (e) => setPref('logTask', e.target.value) },
          taskOptions.map(([v, l]) => h('option', { value: v, selected: p.logTask === v }, l)))),
      h('input', {
        type: 'search', placeholder: 'חיפוש ביומן…', value: p.logQuery, 'aria-label': 'חיפוש ביומן',
        onchange: (e) => setPref('logQuery', e.target.value),
      }),
      h('div', { class: 'grow' }),
      h('button', { class: 'btn', onclick: copy, disabled: !list.length }, 'העתקה כטקסט'),
      h('button', {
        class: 'btn', disabled: !list.length,
        onclick: () => download(`work-log-${todayIso()}.csv`, new Blob([logCsv(list)], { type: 'text/csv;charset=utf-8' })),
      }, 'ייצוא CSV')),
    list.length > 0 && h('div', { class: 'log-sum' },
      h('span', {}, h('b', { class: 'num' }, hoursText(hoursOf(list))), ` שעות · ${countText(list.length)}`),
      perPerson.map(([id, n]) => h('span', {}, `${personName(id)}: `, h('b', { class: 'num' }, hoursText(n)))),
      h('span', {}, 'השבוע: ', h('b', { class: 'num' }, hoursText(hoursOf(thisWeek))))),
    groups.map((g) => h('section', { class: 'log-day' },
      h('h2', {}, dayTitle(g.date)),
      g.items.map((e) => renderEntry(e, { onPage: true })))),
    !list.length && h('p', { class: 'hint' }, all.length
      ? 'אין רישומים שמתאימים לסינון.'
      : 'עוד אין רישומים. כל רישום הוא מה שעשיתם וכמה זמן זה לקח. אפשר לחבר אותו למשימה או להשאיר כללי, למשל פגישה.')));
}
