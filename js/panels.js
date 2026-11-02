import {
  addTask, applyTheme, commit, createIssueFor, disconnect, fmt, personName, render, savePrefs, setPref, state, takeNewBaseline, taskById, toast, todayIso,
} from './app.js';
import { h } from './dom.js';
import { addDays, isMilestone, toDay, toIso, wouldCreateCycle } from './model.js';
import { taskName } from './mspdi.js';

const STATUS = [['todo', 'לא התחיל'], ['doing', 'בעבודה'], ['blocked', 'חסום'], ['done', 'הושלם']];
const TRACKS = [['hw', 'חומרה'], ['fw', 'קושחה'], ['veh', 'רכב'], ['docs', 'מסמכים']];
const TYPES = [['task', 'משימה'], ['milestone', 'אבן דרך'], ['gate', 'שער החלטה'], ['deadline', 'מועד הגשה']];

function update(id, fn) {
  commit((doc) => fn(doc.tasks.find((t) => t.id === id), doc));
}

function field(label, control) {
  return h('label', { class: 'f' }, label, control);
}

function select(key, options, value, onchange) {
  return h('select', { dataset: { fieldKey: key }, onchange: (e) => onchange(e.target.value) },
    options.map(([v, l]) => h('option', { value: v, selected: v === (value ?? '') }, l)));
}

function peopleOptions(withEmpty) {
  const people = (state.doc.people || []).map((p) => [p.id, p.name]);
  return [...(withEmpty ? [['', 'אין']] : []), ['both', 'שניהם'], ...people];
}

function textInput(key, value, onchange, extra = {}) {
  return h('input', {
    type: 'text', value: value || '', dataset: { fieldKey: key, ...(extra.dataset || {}) },
    onchange: (e) => onchange(e.target.value.trim()),
    ...(extra.dir ? { dir: extra.dir } : {}),
  });
}

function dateInput(key, value, onchange) {
  return h('input', {
    type: 'date', value: value || '', dataset: { fieldKey: key }, onchange: (e) => onchange(e.target.value),
  });
}

function closeDrawer() {
  state.panel = null;
  state.selected = null;
  render();
}

function drawerHead(title) {
  return h('div', { class: 'drawer-head' },
    h('h2', { class: 'grow' }, title),
    h('button', { class: 'icon-btn', 'aria-label': 'סגירה', onclick: closeDrawer }, '✕'));
}

function explainTiming(t, r) {
  const parts = [];
  if (isMilestone(t)) {
    parts.push(h('div', {}, h('b', {}, fmt(r.end))));
    if (t.fixed && r.depFloor > r.end) parts.push(h('div', { class: 'warn' }, `המשימות שלפניו מסתיימות ${r.depFloor - r.end} ימים מאוחר מדי.`));
  } else {
    parts.push(h('div', {}, h('b', { class: 'num' }, `${fmt(r.start)} – ${fmt(r.end)}`)));
    const span = r.end - r.start + 1;
    if (span > (t.duration || 1)) parts.push(h('div', {}, `${t.duration || 1} ימי עבודה על פני ${span} ימים (לא עובדים בזמן בחינות או מילואים).`));
  }
  if (r.drivenBy) parts.push(h('div', {}, `מתחילה אחרי: ${taskName(taskById(r.drivenBy), 'he')}`));
  if (t.status !== 'done' && !(isMilestone(t) && t.fixed)) {
    parts.push(h('div', { class: r.slack < 0 ? 'warn' : '' },
      r.slack < 0 ? `באיחור של ${-r.slack} ימים מול מועד שתלוי בה.` : `מרווח: ${r.slack} ימים עד שזה פוגע במועד.`));
  }
  const base = (state.doc.baselines || []).at(-1)?.tasks[t.id];
  if (base) {
    const delta = r.end - toDay(base.end);
    if (delta) parts.push(h('div', {}, `מול קו הבסיס: ${delta > 0 ? `${delta} ימים מאוחר יותר` : `${-delta} ימים מוקדם יותר`}.`));
  }
  return h('div', { class: 'why' }, parts);
}

function renderDeps(t) {
  const options = state.doc.tasks
    .filter((x) => x.id !== t.id && !(t.deps || []).some((d) => d.id === x.id))
    .map((x) => [x.id, taskName(x, 'he')]);
  return h('div', { class: 'f' },
    h('h3', {}, 'תלויה במשימות (מתחילה אחריהן)'),
    (t.deps || []).map((d) => {
      const dep = taskById(d.id);
      return h('div', { class: 'dep-row' },
        h('span', { class: 'label', title: dep ? taskName(dep, 'he') : d.id }, dep ? taskName(dep, 'he') : `${d.id} (נמחקה)`),
        h('label', { class: 'field-inline', title: 'ימי המתנה אחרי שהמשימה הקודמת מסתיימת' }, '+ימים',
          h('input', {
            type: 'number', value: d.lag || 0,
            onchange: (e) => update(t.id, (x) => { x.deps.find((y) => y.id === d.id).lag = Number(e.target.value) || 0; }),
          })),
        h('button', {
          class: 'icon-btn', 'aria-label': 'הסרת התלות',
          onclick: () => update(t.id, (x) => { x.deps = x.deps.filter((y) => y.id !== d.id); }),
        }, '✕'));
    }),
    h('select', {
      'aria-label': 'הוספת תלות',
      onchange: (e) => {
        const id = e.target.value;
        if (!id) return;
        if (wouldCreateCycle(state.doc, t.id, id)) {
          e.target.value = '';
          toast('אי אפשר: זו תהיה תלות מעגלית.');
          return;
        }
        update(t.id, (x) => { x.deps = [...(x.deps || []), { id }]; });
      },
    },
    h('option', { value: '' }, '+ הוספת תלות…'),
    options.map(([v, l]) => h('option', { value: v }, l))));
}

function renderCriteria(t) {
  const list = t.criteria || [];
  return h('div', { class: 'f' },
    h('h3', {}, t.type === 'gate' ? 'תנאי מעבר בשער' : 'תנאי סיום'),
    list.map((c, i) => h('div', { class: 'dep-row' },
      h('label', { class: 'check grow' },
        h('input', {
          type: 'checkbox', checked: (t.criteriaDone || []).includes(i),
          onchange: (e) => update(t.id, (x) => {
            const set = new Set(x.criteriaDone || []);
            if (e.target.checked) set.add(i); else set.delete(i);
            x.criteriaDone = [...set];
          }),
        }),
        h('span', {}, c)),
      h('button', {
        class: 'icon-btn', 'aria-label': 'הסרת התנאי',
        onclick: () => update(t.id, (x) => {
          x.criteria.splice(i, 1);
          x.criteriaDone = (x.criteriaDone || []).filter((n) => n !== i).map((n) => (n > i ? n - 1 : n));
        }),
      }, '✕'))),
    h('input', {
      type: 'text', placeholder: '+ תנאי חדש, ואז Enter',
      onkeydown: (e) => {
        if (e.key !== 'Enter' || !e.target.value.trim()) return;
        const text = e.target.value.trim();
        update(t.id, (x) => { x.criteria = [...(x.criteria || []), text]; });
      },
    }));
}

function setStatus(id, value) {
  update(id, (x) => {
    x.status = value;
    if (value === 'done') {
      x.doneAt = todayIso();
      if (!isMilestone(x)) {
        const r = state.sched.rows.get(id);
        x.start = toIso(r.start);
        x.actualEnd = todayIso();
      }
    } else {
      delete x.doneAt;
      delete x.actualEnd;
    }
  });
}

function moveTask(id, delta) {
  commit((doc) => {
    const i = doc.tasks.findIndex((t) => t.id === id);
    const phase = doc.tasks[i].phase;
    let j = i + delta;
    while (j >= 0 && j < doc.tasks.length && doc.tasks[j].phase !== phase) j += delta;
    if (j < 0 || j >= doc.tasks.length) return;
    const [task] = doc.tasks.splice(i, 1);
    doc.tasks.splice(j, 0, task);
  });
}

export function renderTaskDrawer() {
  const t = taskById(state.selected);
  const r = state.sched.rows.get(t.id);
  const milestone = isMilestone(t);
  const issue = t.issue && state.remoteIssues.get(t.issue);
  return h('aside', { class: 'drawer', 'aria-label': 'עריכת משימה' },
    drawerHead(milestone ? 'מועד / אבן דרך' : 'משימה'),
    field('שם', textInput('name', t.name, (v) => update(t.id, (x) => { x.name = v || x.name; }), { dataset: { focusName: '1' } })),
    r && explainTiming(t, r),
    h('div', { class: 'grid2' },
      field('סטטוס', select('status', STATUS, t.status || 'todo', (v) => setStatus(t.id, v))),
      !milestone && field('התקדמות %', h('input', {
        type: 'number', min: 0, max: 100, step: 10, value: t.progress || 0, dataset: { fieldKey: 'progress' },
        onchange: (e) => update(t.id, (x) => { x.progress = Math.min(100, Math.max(0, Number(e.target.value) || 0)); }),
      })),
      field('אחראי', select('owner', peopleOptions(false), t.owner || 'both', (v) => update(t.id, (x) => { x.owner = v; }))),
      field('גיבוי', select('backup', peopleOptions(true), t.backup || '', (v) => update(t.id, (x) => { x.backup = v || undefined; }))),
      field('סוג', select('type', TYPES, t.type || 'task', (v) => update(t.id, (x) => {
        x.type = v;
        if (isMilestone(x) && v !== 'milestone' && !x.fixed) x.fixed = toIso(state.sched.rows.get(x.id).end);
        if (v === 'task') delete x.fixed;
      }))),
      field('מסלול', select('track', TRACKS, t.track || 'hw', (v) => update(t.id, (x) => { x.track = v; }))),
      field('שלב', select('phase', state.doc.phases.map((p) => [p.id, p.name]), t.phase, (v) => update(t.id, (x) => { x.phase = v; }))),
      milestone
        ? field('תאריך קבוע', dateInput('fixed', t.fixed, (v) => update(t.id, (x) => { if (v) x.fixed = v; else delete x.fixed; })))
        : field('משך (ימי עבודה)', h('input', {
          type: 'number', min: 1, value: t.duration || 1, dataset: { fieldKey: 'duration' },
          onchange: (e) => update(t.id, (x) => { x.duration = Math.max(1, Number(e.target.value) || 1); }),
        })),
      !milestone && field('לא להתחיל לפני', dateInput('start', t.start, (v) => update(t.id, (x) => { if (v) x.start = v; else delete x.start; })))),
    h('div', { class: 'f' },
      h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: !!t.external, onchange: (e) => update(t.id, (x) => { x.external = e.target.checked || undefined; }) }), 'תלוי בגורם חיצוני (ממשיך גם בזמן בחינות)'),
      !t.external && h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: !!t.noPause, onchange: (e) => update(t.id, (x) => { x.noPause = e.target.checked || undefined; }) }), 'ממשיך גם בזמן בחינות'),
      h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: !!t.unverified, onchange: (e) => update(t.id, (x) => { x.unverified = e.target.checked || undefined; }) }), 'התאריך לא מאומת'),
      h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: !!t.decision, onchange: (e) => update(t.id, (x) => { x.decision = e.target.checked || undefined; }) }), 'החלטה פתוחה')),
    renderDeps(t),
    renderCriteria(t),
    field('הערות', h('textarea', {
      value: t.note || '', dataset: { fieldKey: 'note' },
      onchange: (e) => update(t.id, (x) => { x.note = e.target.value || undefined; }),
    })),
    field('שם באנגלית (לדו"חות)', textInput('nameEn', t.nameEn, (v) => update(t.id, (x) => { x.nameEn = v || undefined; }), { dir: 'ltr' })),
    h('div', { class: 'f' },
      h('h3', {}, 'GitHub Issue'),
      t.issue
        ? h('div', { class: 'dep-row' },
          h('a', {
            class: 'label', target: '_blank', rel: 'noopener noreferrer',
            href: `https://github.com/Interactive-Driver-Dashboard-EE/Interactive-Driver-Dashboard-Display/issues/${Number(t.issue)}`,
          }, `Issue מספר ${Number(t.issue)}${issue ? (issue.state === 'closed' ? ' (סגור)' : ' (פתוח)') : ''}`),
          h('button', { class: 'icon-btn', 'aria-label': 'ניתוק הקישור', onclick: () => update(t.id, (x) => { delete x.issue; }) }, '✕'))
        : h('div', { class: 'actions' },
          h('button', { class: 'btn', onclick: () => createIssueFor(t) }, 'פתיחת Issue למשימה'),
          h('input', {
            type: 'number', min: 1, placeholder: 'או מספר קיים', 'aria-label': 'מספר Issue קיים',
            onchange: (e) => { const n = Number(e.target.value); if (n > 0) update(t.id, (x) => { x.issue = n; }); },
          }))),
    h('div', { class: 'actions' },
      h('button', { class: 'btn', onclick: () => moveTask(t.id, -1) }, 'למעלה'),
      h('button', { class: 'btn', onclick: () => moveTask(t.id, 1) }, 'למטה'),
      h('button', { class: 'btn', onclick: () => addTask(t.phase) }, 'משימה חדשה אחריה'),
      h('button', {
        class: 'btn danger',
        onclick: () => {
          const dependents = state.doc.tasks.filter((x) => (x.deps || []).some((d) => d.id === t.id));
          const warn = dependents.length ? `\n${dependents.length} משימות תלויות בה, והתלות תוסר.` : '';
          if (!confirm(`למחוק את "${t.name}"?${warn}`)) return;
          state.selected = null;
          state.panel = null;
          commit((doc) => {
            doc.tasks = doc.tasks.filter((x) => x.id !== t.id);
            for (const x of doc.tasks) if (x.deps) x.deps = x.deps.filter((d) => d.id !== t.id);
          });
        },
      }, 'מחיקה')),
    h('p', { class: 'hint' }, `מזהה: ${t.id}`));
}

export function renderSettings() {
  const doc = state.doc;
  const updateDoc = (fn) => commit(fn);
  return h('aside', { class: 'drawer', 'aria-label': 'הגדרות' },
    drawerHead('הגדרות'),
    h('h3', {}, 'בחינות, מילואים וחופשות'),
    h('p', { class: 'hint' }, 'משימות של הצוות נעצרות בתקופות האלה. מילואים של אחד מכם עוצרים רק את המשימות שהוא האחראי עליהן.'),
    (doc.blackouts || []).map((b) => h('div', { class: 'why' },
      field('שם', textInput(`b-${b.id}-name`, b.name, (v) => updateDoc((d) => { d.blackouts.find((x) => x.id === b.id).name = v; d.blackouts.find((x) => x.id === b.id).short = v; }))),
      h('div', { class: 'grid2' },
        field('מתאריך', dateInput(`b-${b.id}-start`, b.start, (v) => { if (v) updateDoc((d) => { d.blackouts.find((x) => x.id === b.id).start = v; }); })),
        field('עד תאריך', dateInput(`b-${b.id}-end`, b.end, (v) => { if (v) updateDoc((d) => { d.blackouts.find((x) => x.id === b.id).end = v; }); }))),
      field('חל על', select(`b-${b.id}-who`, [['all', 'כולם'], ...(doc.people || []).map((p) => [p.id, p.name])], b.appliesTo || 'all', (v) => updateDoc((d) => { d.blackouts.find((x) => x.id === b.id).appliesTo = v; }))),
      h('button', { class: 'btn danger', onclick: () => updateDoc((d) => { d.blackouts = d.blackouts.filter((x) => x.id !== b.id); }) }, 'הסרה'))),
    h('button', {
      class: 'btn',
      onclick: () => updateDoc((d) => {
        const today = todayIso();
        d.blackouts = [...(d.blackouts || []), { id: `b${Date.now().toString(36)}`, name: 'מילואים', short: 'מילואים', start: today, end: addDays(today, 7), appliesTo: d.people?.[0]?.id || 'all' }];
      }),
    }, '+ הוספת תקופה'),

    h('h3', {}, 'קו בסיס'),
    h('p', { class: 'hint' }, 'צילום של התוכנית הנוכחית, כדי לראות בהמשך כמה כל משימה זזה ממנה. כדאי לצלם אחרי שאתם מסכימים על הלו"ז.'),
    (doc.baselines || []).map((b) => h('div', { class: 'dep-row' },
      h('span', { class: 'label' }, `${b.name} (${b.date})`),
      h('button', { class: 'icon-btn', 'aria-label': 'מחיקת קו הבסיס', onclick: () => updateDoc((d) => { d.baselines = d.baselines.filter((x) => x.id !== b.id); }) }, '✕'))),
    h('button', { class: 'btn', onclick: () => takeNewBaseline(`תוכנית ${fmt(toDay(todayIso()))}`) }, 'צילום קו בסיס עכשיו'),

    h('h3', {}, 'שלבים'),
    doc.phases.map((p, i) => h('div', { class: 'dep-row' },
      h('input', {
        class: 'grow', type: 'text', value: p.name, 'aria-label': 'שם השלב',
        onchange: (e) => updateDoc((d) => { d.phases[i].name = e.target.value; }),
      }),
      h('button', {
        class: 'icon-btn', 'aria-label': 'מחיקת השלב', disabled: doc.tasks.some((t) => t.phase === p.id), title: 'אפשר למחוק רק שלב ריק',
        onclick: () => updateDoc((d) => { d.phases = d.phases.filter((x) => x.id !== p.id); }),
      }, '✕'))),
    h('button', { class: 'btn', onclick: () => updateDoc((d) => { d.phases.push({ id: `p${Date.now().toString(36)}`, name: 'שלב חדש' }); }) }, '+ שלב'),

    h('h3', {}, 'תצוגה'),
    h('div', { class: 'grid2' },
      field('ערכת צבעים', select('theme', [['auto', 'לפי המערכת'], ['light', 'בהיר'], ['dark', 'כהה']], state.prefs.theme, (v) => { state.prefs.theme = v; savePrefs(); applyTheme(); render(); })),
      field('שפת התרשים', select('lang', [['he', 'עברית'], ['en', 'English']], state.prefs.lang, (v) => setPref('lang', v))),
      field('סימון מרווח קטן (ימים)', h('input', {
        type: 'number', min: 0, value: doc.settings?.criticalDays ?? 7, dataset: { fieldKey: 'crit' },
        onchange: (e) => updateDoc((d) => { d.settings = { ...(d.settings || {}), criticalDays: Math.max(0, Number(e.target.value) || 0) }; }),
      }))),

    h('h3', {}, 'חיבור'),
    h('p', { class: 'hint' }, `מחוברים לריפו הפרטי. כל שמירה היא commit, וההיסטוריה המלאה נמצאת שם. שמות האחראים: ${(doc.people || []).map((p) => personName(p.id)).join(', ')}.`),
    h('button', { class: 'btn', onclick: () => { if (confirm('להתנתק ולמחוק את הטוקן מהדפדפן הזה?')) disconnect(); } }, 'התנתקות'));
}
