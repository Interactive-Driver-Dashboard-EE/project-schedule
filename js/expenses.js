// Expenses: what the project cost, who paid and whether it came back. Entries
// live in the schedule file next to the work log, each one general or tied to a task.
import {
  commit, personName, selectAndReveal, setPref, state, taskById, toast, todayIso,
} from './app.js';
import { download, h } from './dom.js';
import { expenseSummary } from './model.js';
import { taskName } from './mspdi.js';
import { csvCell } from './worklog.js';

export const CATEGORIES = [
  ['parts', 'רכיבים'], ['pcb', 'PCB וייצור'], ['tools', 'כלים וציוד'], ['shipping', 'משלוח ומכס'],
  ['software', 'תוכנה ומנויים'], ['print', 'הדפסה ומכני'], ['other', 'אחר'],
];
export const STATUSES = [['planned', 'מתוכנן'], ['paid', 'שולם'], ['reimbursed', 'הוחזר']];
const CURRENCIES = [['ILS', '₪'], ['USD', '$'], ['EUR', '€']];

const entries = () => state.doc.expenses || [];
const labelOf = (list, key, fallback = '') => list.find(([k]) => k === key)?.[1] || fallback || key;
const categoryName = (key) => labelOf(CATEGORIES, key || 'other');
const statusName = (key) => labelOf(STATUSES, key || 'paid');
const payerName = (id) => (id === 'dept' ? 'תקציב הפרויקט' : personName(id));
const countText = (n) => (n === 1 ? 'הוצאה אחת' : `${n} הוצאות`);
const newest = (a, b) => b.date.localeCompare(a.date) || (b.created?.at || '').localeCompare(a.created?.at || '');
const safeLink = (url) => (/^https?:\/\/\S+$/i.test(url || '') ? url : null);

export function money(n, currency = 'ILS') {
  try {
    return new Intl.NumberFormat('he-IL', { style: 'currency', currency, maximumFractionDigits: 2 }).format(n);
  } catch {
    return `${n} ${currency}`;
  }
}

function moneyLine(summary, key) {
  const parts = Object.entries(summary).filter(([, row]) => row[key] > 0).map(([c, row]) => money(row[key], c));
  return parts.length ? parts.join(' + ') : money(0);
}

function updateExpense(id, fn) {
  commit((doc) => fn(doc.expenses.find((e) => e.id === id), doc));
}

export function addExpense(taskId) {
  const id = `e${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
  commit((doc) => {
    doc.expenses = [...(doc.expenses || []), {
      id, date: todayIso(), title: '', currency: 'ILS', category: 'parts', status: 'paid', paidBy: state.me || 'both',
      ...(taskId ? { task: taskId } : {}),
    }];
  });
  requestAnimationFrame(() => document.querySelector(`[data-field-key="exp-${id}-title"]`)?.focus());
}

function taskLabel(e) {
  const t = e.task && taskById(e.task);
  if (t) return taskName(t, 'he');
  return e.taskName ? `כללי (הייתה: ${e.taskName})` : 'כללי';
}

function select(label, key, value, options, onPick) {
  return h('select', {
    'aria-label': label, dataset: { fieldKey: key },
    onchange: (ev) => onPick(ev.target.value),
  }, options.map(([v, l]) => h('option', { value: v, selected: v === value }, l)));
}

function payerOptions(e) {
  const list = [...(state.doc.people || []).map((p) => [p.id, p.name]), ['both', 'שניהם'], ['dept', 'תקציב הפרויקט']];
  if (e?.paidBy && !list.some(([v]) => v === e.paidBy)) list.push([e.paidBy, e.paidBy]);
  return list;
}

function taskOptions(e) {
  return [['', e.taskName ? `כללי (הייתה: ${e.taskName})` : 'כללי'], ...state.doc.phases.flatMap((p) => state.doc.tasks
    .filter((t) => t.phase === p.id)
    .map((t) => [t.id, `${p.name.trim()} · ${taskName(t, 'he')}`]))];
}

function textField(e, field, label, extra = {}) {
  return h('input', {
    type: 'text', value: e[field] || '', placeholder: label, 'aria-label': label, dataset: { fieldKey: `exp-${e.id}-${field}` },
    onchange: (ev) => updateExpense(e.id, (x) => { const v = ev.target.value.trim(); if (v) x[field] = v; else delete x[field]; }),
    ...extra,
  });
}

function renderExpense(e, { onPage }) {
  const key = (f) => `exp-${e.id}-${f}`;
  const link = safeLink(e.link);
  return h('div', { class: `log-entry expense ${e.status === 'planned' ? 'planned' : ''}`, dataset: { expense: e.id } },
    h('div', { class: 'log-meta' },
      h('input', {
        type: 'date', value: e.date, 'aria-label': 'תאריך', dataset: { fieldKey: key('date') },
        onchange: (ev) => { if (ev.target.value) updateExpense(e.id, (x) => { x.date = ev.target.value; }); },
      }),
      textField(e, 'title', 'מה קנינו', { class: 'exp-title' }),
      h('span', { class: 'exp-amount' },
        h('input', {
          type: 'number', min: 0, step: 0.01, inputmode: 'decimal', value: e.amount ?? '', class: 'amount',
          'aria-label': 'עלות', placeholder: 'עלות', dataset: { fieldKey: key('amount') },
          onchange: (ev) => updateExpense(e.id, (x) => {
            const n = Number(ev.target.value);
            if (ev.target.value !== '' && Number.isFinite(n) && n >= 0) x.amount = Math.round(n * 100) / 100; else delete x.amount;
          }),
        }),
        select('מטבע', key('currency'), e.currency || 'ILS', CURRENCIES, (v) => updateExpense(e.id, (x) => { x.currency = v; }))),
      h('div', { class: 'grow' }),
      h('button', {
        class: 'icon-btn',
        onclick: () => { if (confirm('למחוק את ההוצאה?')) commit((doc) => { doc.expenses = doc.expenses.filter((x) => x.id !== e.id); }); },
      }, 'מחיקה')),
    h('div', { class: 'log-meta' },
      h('label', { class: 'field-inline' }, 'סוג',
        select('סוג', key('category'), e.category || 'other', CATEGORIES, (v) => updateExpense(e.id, (x) => { x.category = v; }))),
      h('label', { class: 'field-inline' }, 'מצב',
        select('מצב', key('status'), e.status || 'paid', STATUSES, (v) => updateExpense(e.id, (x) => { x.status = v; }))),
      h('label', { class: 'field-inline' }, 'שילם',
        select('מי שילם', key('paidBy'), e.paidBy || 'both', payerOptions(e), (v) => updateExpense(e.id, (x) => { x.paidBy = v; }))),
      textField(e, 'vendor', 'ספק / חנות', { class: 'exp-vendor' }),
      onPage && select('משימה', key('task'), e.task || '', taskOptions(e),
        (v) => updateExpense(e.id, (x) => { if (v) x.task = v; else delete x.task; })),
      onPage && e.task && taskById(e.task) && h('button', { class: 'icon-btn', onclick: () => selectAndReveal(e.task) }, 'למשימה')),
    h('div', { class: 'log-meta' },
      h('input', {
        type: 'url', value: e.link || '', placeholder: 'קישור להזמנה או לקבלה', 'aria-label': 'קישור', dir: 'ltr', class: 'exp-link',
        dataset: { fieldKey: key('link') },
        onchange: (ev) => updateExpense(e.id, (x) => {
          const v = ev.target.value.trim();
          if (!v) delete x.link;
          else if (safeLink(v)) x.link = v;
          else toast('הקישור צריך להתחיל ב-https://');
        }),
      }),
      link && h('a', { class: 'icon-btn', href: link, target: '_blank', rel: 'noopener noreferrer' }, 'פתיחה')),
    h('textarea', {
      value: e.note || '', placeholder: 'הערות: כמות, מספר הזמנה, למה קנינו, מתי צפוי להגיע…', 'aria-label': 'הערות',
      dataset: { fieldKey: key('note') },
      onchange: (ev) => updateExpense(e.id, (x) => { if (ev.target.value.trim()) x.note = ev.target.value; else delete x.note; }),
    }));
}

// --- in the task panel ---

export function renderTaskExpenses(t) {
  const list = entries().filter((e) => e.task === t.id).sort(newest);
  const sum = expenseSummary(list);
  return h('div', { class: 'f' },
    h('h3', {}, list.length ? `הוצאות (${countText(list.length)} · ${moneyLine(sum, 'spent')})` : 'הוצאות'),
    list.map((e) => renderExpense(e, { onPage: false })),
    h('div', { class: 'actions' }, h('button', { class: 'btn', onclick: () => addExpense(t.id) }, '+ הוצאה')));
}

// --- the expenses page ---

function matches(e) {
  const { expCategory, expWho, expStatus, expQuery } = state.prefs;
  if (expCategory && (e.category || 'other') !== expCategory) return false;
  if (expWho && e.paidBy !== expWho) return false;
  if (expStatus === 'owed') {
    if (e.status === 'planned' || e.status === 'reimbursed' || !e.paidBy || e.paidBy === 'dept') return false;
  } else if (expStatus && (e.status || 'paid') !== expStatus) return false;
  if (expQuery) {
    const q = expQuery.toLowerCase();
    if (!`${e.title || ''} ${e.vendor || ''} ${e.note || ''} ${taskLabel(e)}`.toLowerCase().includes(q)) return false;
  }
  return true;
}

function expensesCsv(list) {
  const head = ['תאריך', 'מה קנינו', 'עלות', 'מטבע', 'סוג', 'מצב', 'מי שילם', 'ספק', 'משימה', 'קישור', 'הערות'];
  const rows = [...list].sort((a, b) => -newest(a, b)).map((e) => [
    e.date, e.title || '', e.amount ?? '', e.currency || 'ILS', categoryName(e.category), statusName(e.status),
    payerName(e.paidBy), e.vendor || '', taskLabel(e), e.link || '', e.note || '',
  ]);
  // The byte order mark lets Excel read the Hebrew correctly.
  return `﻿${[head, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n')}\r\n`;
}

function renderSummary(list) {
  const sum = expenseSummary(list);
  const budget = Number(state.doc.expenseBudget) || 0;
  const ils = sum.ILS || { spent: 0, planned: 0 };
  const left = budget - ils.spent - ils.planned;
  const cats = CATEGORIES.map(([k, l]) => [l, Object.entries(sum).map(([c, row]) => row.byCategory[k] && money(row.byCategory[k], c)).filter(Boolean)])
    .filter(([, v]) => v.length);
  const payers = payerOptions().map(([id]) => [payerName(id), Object.entries(sum).map(([c, row]) => row.byPayer[id] && money(row.byPayer[id], c)).filter(Boolean)])
    .filter(([, v]) => v.length);
  return h('div', { class: 'exp-sum' },
    h('div', { class: 'log-sum' },
      h('span', {}, 'שולם: ', h('b', { class: 'num' }, moneyLine(sum, 'spent'))),
      h('span', {}, 'מתוכנן: ', h('b', { class: 'num' }, moneyLine(sum, 'planned'))),
      h('span', {}, 'ממתין להחזר: ', h('b', { class: 'num' }, moneyLine(sum, 'owed'))),
      h('label', { class: 'field-inline' }, 'תקציב (₪)', h('input', {
        type: 'number', min: 0, step: 1, inputmode: 'decimal', class: 'amount', value: budget || '', 'aria-label': 'תקציב בשקלים',
        dataset: { fieldKey: 'exp-budget' },
        onchange: (ev) => commit((doc) => { const n = Number(ev.target.value); if (n > 0) doc.expenseBudget = n; else delete doc.expenseBudget; }),
      })),
      budget > 0 && h('span', { class: left < 0 ? 'over' : '' }, left < 0 ? 'חריגה: ' : 'נשאר: ', h('b', { class: 'num' }, money(Math.abs(left))),
        Object.keys(sum).some((c) => c !== 'ILS') ? ' (בשקלים בלבד)' : '')),
    (cats.length > 0 || payers.length > 0) && h('div', { class: 'log-sum exp-breakdown' },
      cats.map(([l, v]) => h('span', {}, `${l}: `, h('b', { class: 'num' }, v.join(' + ')))),
      payers.length > 0 && h('span', { class: 'sep' }, '·'),
      payers.map(([l, v]) => h('span', {}, `${l}: `, h('b', { class: 'num' }, v.join(' + '))))));
}

export function renderExpensesPage() {
  const p = state.prefs;
  const all = entries();
  const list = all.filter(matches).sort(newest);
  const groups = [];
  for (const e of list) {
    const month = e.date.slice(0, 7);
    if (groups.at(-1)?.month !== month) groups.push({ month, items: [] });
    groups.at(-1).items.push(e);
  }
  const monthTitle = (m) => new Date(`${m}-15T12:00:00Z`).toLocaleDateString('he-IL', { month: 'long', year: 'numeric', timeZone: 'UTC' });
  const filter = (label, key, options) => h('label', { class: 'field-inline' }, label,
    h('select', { onchange: (e) => setPref(key, e.target.value) },
      options.map(([v, l]) => h('option', { value: v, selected: p[key] === v }, l))));
  return h('div', { class: 'page' }, h('div', { class: 'page-inner' },
    h('div', { class: 'log-tools' },
      h('button', { class: 'btn primary', onclick: () => addExpense(null) }, '+ הוצאה חדשה'),
      filter('סוג', 'expCategory', [['', 'הכול'], ...CATEGORIES]),
      filter('מצב', 'expStatus', [['', 'הכול'], ...STATUSES, ['owed', 'ממתין להחזר']]),
      filter('שילם', 'expWho', [['', 'כולם'], ...payerOptions()]),
      h('input', {
        type: 'search', placeholder: 'חיפוש בהוצאות…', value: p.expQuery, 'aria-label': 'חיפוש בהוצאות',
        onchange: (e) => setPref('expQuery', e.target.value),
      }),
      h('div', { class: 'grow' }),
      h('button', {
        class: 'btn', disabled: !list.length,
        onclick: () => download(`expenses-${todayIso()}.csv`, new Blob([expensesCsv(list)], { type: 'text/csv;charset=utf-8' })),
      }, 'ייצוא CSV')),
    renderSummary(list),
    list.length > 0 && h('p', { class: 'hint' }, `${countText(list.length)}${list.length !== all.length ? ` מתוך ${all.length}` : ''}`),
    groups.map((g) => h('section', { class: 'log-day' },
      h('h2', {}, monthTitle(g.month)),
      g.items.map((e) => renderExpense(e, { onPage: true })))),
    !list.length && h('p', { class: 'hint' }, all.length
      ? 'אין הוצאות שמתאימות לסינון.'
      : 'עוד אין הוצאות. כל הוצאה היא משהו שקניתם או מתכננים לקנות: מה, כמה, מי שילם ואם הכסף כבר הוחזר. אפשר לחבר אותה למשימה.')));
}
