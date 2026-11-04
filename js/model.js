// Scheduling model: pure functions with no DOM or network access, so they run
// both in the browser and under `node --test`.

const DAY_MS = 86400000;

export function toDay(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return Math.round(Date.UTC(y, m - 1, d) / DAY_MS);
}

export function toIso(day) {
  return new Date(day * DAY_MS).toISOString().slice(0, 10);
}

export function addDays(iso, n) {
  return toIso(toDay(iso) + n);
}

export function isMilestone(task) {
  return task.type === 'milestone' || task.type === 'gate' || task.type === 'deadline';
}

// A task pauses during a blackout that applies to everyone or to its owner.
// External work (PCB fabrication, shipping) keeps running through blackouts.
function pauseDays(task, doc) {
  if (task.external || task.noPause) return [];
  const out = [];
  for (const b of doc.blackouts || []) {
    if (b.appliesTo && b.appliesTo !== 'all' && b.appliesTo !== task.owner) continue;
    out.push([toDay(b.start), toDay(b.end)]);
  }
  return out;
}

function nextWorking(day, spans) {
  let d = day;
  for (let moved = true; moved;) {
    moved = false;
    for (const [s, e] of spans) {
      if (d >= s && d <= e) { d = e + 1; moved = true; }
    }
  }
  return d;
}

function prevWorking(day, spans) {
  let d = day;
  for (let moved = true; moved;) {
    moved = false;
    for (const [s, e] of spans) {
      if (d >= s && d <= e) { d = s - 1; moved = true; }
    }
  }
  return d;
}

// Last day of a task that starts on `start` and needs `duration` working days.
function forwardEnd(start, duration, spans) {
  let d = start;
  for (let left = Math.max(duration, 1) - 1; left > 0; left--) d = nextWorking(d + 1, spans);
  return d;
}

function backwardStart(end, duration, spans) {
  let d = end;
  for (let left = Math.max(duration, 1) - 1; left > 0; left--) d = prevWorking(d - 1, spans);
  return d;
}

// Kahn's algorithm. Dependencies pointing at missing tasks are ignored; tasks
// caught in a cycle are appended last and reported through `cycle`.
function topoOrder(tasks) {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const indeg = new Map(tasks.map((t) => [t.id, 0]));
  const succ = new Map(tasks.map((t) => [t.id, []]));
  for (const t of tasks) {
    for (const dep of t.deps || []) {
      if (!byId.has(dep.id)) continue;
      indeg.set(t.id, indeg.get(t.id) + 1);
      succ.get(dep.id).push(t.id);
    }
  }
  const queue = tasks.filter((t) => indeg.get(t.id) === 0).map((t) => t.id);
  const order = [];
  while (queue.length) {
    const id = queue.shift();
    order.push(id);
    for (const s of succ.get(id)) {
      indeg.set(s, indeg.get(s) - 1);
      if (indeg.get(s) === 0) queue.push(s);
    }
  }
  const seen = new Set(order);
  const cycle = tasks.filter((t) => !seen.has(t.id)).map((t) => t.id);
  return { order: [...order, ...cycle], cycle, succ };
}

export function wouldCreateCycle(doc, taskId, depId) {
  if (taskId === depId) return true;
  const byId = new Map(doc.tasks.map((t) => [t.id, t]));
  const stack = [depId];
  const seen = new Set();
  while (stack.length) {
    const id = stack.pop();
    if (id === taskId) return true;
    if (seen.has(id)) continue;
    seen.add(id);
    for (const d of byId.get(id)?.deps || []) stack.push(d.id);
  }
  return false;
}

// Forward pass (earliest dates), then backward pass from fixed dates and the
// project end (latest dates). Slack is measured in calendar days.
export function schedule(doc) {
  const tasks = doc.tasks;
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const { order, cycle, succ } = topoOrder(tasks);
  const out = new Map();
  const defaultStart = toDay(doc.projectStart);

  for (const id of order) {
    const t = byId.get(id);
    const spans = pauseDays(t, doc);
    let earliest = t.start ? toDay(t.start) : defaultStart;
    let drivenBy = null;
    const gap = isMilestone(t) ? 0 : 1;
    let depFloor = -Infinity;
    for (const dep of t.deps || []) {
      const p = out.get(dep.id);
      if (!p) continue;
      const need = p.end + gap + (dep.lag || 0);
      if (need > depFloor) { depFloor = need; if (need > earliest) drivenBy = dep.id; }
    }
    earliest = Math.max(earliest, depFloor);

    let start;
    let end;
    if (isMilestone(t)) {
      // A fixed date holds even when its predecessors run late; that lateness
      // is a conflict to show, not something to hide by moving the date.
      start = end = t.fixed ? toDay(t.fixed) : earliest;
    } else if (t.status === 'done' && t.actualEnd) {
      end = toDay(t.actualEnd);
      start = Math.min(t.start ? toDay(t.start) : earliest, end);
    } else {
      start = nextWorking(earliest, spans);
      end = forwardEnd(start, t.duration || 1, spans);
    }
    out.set(id, { id, start, end, drivenBy, depFloor, spans });
  }

  const projectEnd = Math.max(defaultStart, ...[...out.values()].map((r) => r.end));

  for (const id of [...order].reverse()) {
    const t = byId.get(id);
    const r = out.get(id);
    let lf = isMilestone(t) && t.fixed ? toDay(t.fixed) : projectEnd;
    if (t.deadline) lf = Math.min(lf, toDay(t.deadline));
    for (const sid of succ.get(id)) {
      const s = byId.get(sid);
      const dep = s.deps.find((d) => d.id === id);
      const sr = out.get(sid);
      const need = sr.lateStart - (isMilestone(s) ? 0 : 1) - (dep.lag || 0);
      if (need < lf) lf = need;
    }
    r.lateEnd = lf;
    r.lateStart = isMilestone(t) ? lf : backwardStart(lf, t.duration || 1, r.spans);
    r.slack = r.lateEnd - r.end;
    delete r.spans;
  }

  return { rows: out, cycle, projectEnd, projectStart: Math.min(defaultStart, ...[...out.values()].map((r) => r.start)) };
}

export function rollup(doc, sched, phaseId) {
  const rows = doc.tasks.filter((t) => t.phase === phaseId).map((t) => sched.rows.get(t.id)).filter(Boolean);
  if (!rows.length) return null;
  const done = doc.tasks.filter((t) => t.phase === phaseId && t.status === 'done').length;
  const total = doc.tasks.filter((t) => t.phase === phaseId).length;
  return {
    start: Math.min(...rows.map((r) => r.start)),
    end: Math.max(...rows.map((r) => r.end)),
    done,
    total,
  };
}

// Problems the page should surface on its own, most severe first.
export function findIssues(doc, sched, todayIso) {
  const today = toDay(todayIso);
  const issues = [];
  const byId = new Map(doc.tasks.map((t) => [t.id, t]));
  for (const id of sched.cycle) {
    issues.push({ level: 'critical', code: 'cycle', taskId: id });
  }
  for (const t of doc.tasks) {
    const r = sched.rows.get(t.id);
    if (!r || t.status === 'done') continue;
    if (isMilestone(t) && t.fixed && r.depFloor > r.end) {
      const late = (t.deps || []).map((d) => byId.get(d.id)).filter(Boolean)
        .filter((p) => sched.rows.get(p.id).end > r.end);
      issues.push({ level: 'critical', code: 'missed-fixed', taskId: t.id, days: r.depFloor - r.end, late: late.map((p) => p.id) });
    }
    if (r.end < today) {
      issues.push({ level: 'serious', code: 'overdue', taskId: t.id, days: today - r.end });
    } else if (!isMilestone(t) && r.slack < 0) {
      issues.push({ level: 'serious', code: 'negative-slack', taskId: t.id, days: -r.slack });
    }
    if (t.unverified) issues.push({ level: 'warning', code: 'unverified', taskId: t.id });
    if (t.decision) issues.push({ level: 'warning', code: 'open-decision', taskId: t.id });
  }
  const rank = { critical: 0, serious: 1, warning: 2 };
  return issues.sort((a, b) => rank[a.level] - rank[b.level]);
}

export function takeBaseline(doc, sched, name, todayIso) {
  const tasks = {};
  for (const t of doc.tasks) {
    const r = sched.rows.get(t.id);
    if (r) tasks[t.id] = { start: toIso(r.start), end: toIso(r.end) };
  }
  return { id: `b${Date.now().toString(36)}`, name, date: todayIso, tasks };
}

// Everything the "this week" view needs, for the Sunday update on the project site.
export function weekSummary(doc, sched, todayIso) {
  const today = toDay(todayIso);
  const weekStart = today - new Date(today * DAY_MS).getUTCDay();
  const weekEnd = weekStart + 6;
  const lastWeekStart = weekStart - 7;
  const items = doc.tasks.map((t) => ({ t, r: sched.rows.get(t.id) })).filter((x) => x.r);
  const doneLast = items.filter(({ t }) => t.status === 'done' && t.doneAt
    && toDay(t.doneAt) >= lastWeekStart && toDay(t.doneAt) <= today);
  const active = items.filter(({ t, r }) => t.status !== 'done' && !isMilestone(t)
    && r.start <= weekEnd && r.end >= weekStart);
  const overdue = items.filter(({ t, r }) => t.status !== 'done' && r.end < weekStart);
  const upcoming = items.filter(({ t, r }) => isMilestone(t) && t.status !== 'done'
    && r.end >= today && r.end <= today + 45).sort((a, b) => a.r.end - b.r.end);
  return { weekStart, weekEnd, doneLast, active, overdue, upcoming };
}

// Three-way merge keyed by id, so two partners editing different tasks both
// keep their work. When both changed the same record, `mine` wins and it is reported.
const KEYED = ['tasks', 'phases', 'blackouts', 'baselines', 'people', 'log'];

export function mergeDocs(base, mine, theirs) {
  const merged = structuredClone(theirs);
  const conflicts = [];
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

  for (const key of Object.keys(mine)) {
    if (KEYED.includes(key)) continue;
    if (!same(base[key], mine[key])) merged[key] = mine[key];
  }
  for (const key of KEYED) {
    if (!base[key] && !mine[key] && !theirs[key]) continue;
    const b = new Map((base[key] || []).map((x) => [x.id, x]));
    const m = new Map((mine[key] || []).map((x) => [x.id, x]));
    const t = new Map((theirs[key] || []).map((x) => [x.id, x]));
    const result = new Map(t);
    for (const [id, mv] of m) {
      const bv = b.get(id);
      if (same(bv, mv)) continue;
      if (t.has(id) && bv && !same(t.get(id), bv)) conflicts.push({ collection: key, id });
      result.set(id, mv);
    }
    for (const id of b.keys()) {
      if (m.has(id)) continue;
      if (t.has(id) && !same(t.get(id), b.get(id))) { conflicts.push({ collection: key, id }); continue; }
      result.delete(id);
    }
    // Keep my ordering where it applies; records only they added go at the end.
    const ordered = [];
    for (const id of m.keys()) if (result.has(id)) ordered.push(result.get(id));
    for (const [id, v] of result) if (!m.has(id)) ordered.push(v);
    merged[key] = ordered;
  }
  return { merged, conflicts };
}

// Records who added each task and log entry, and who changed it last. Only the
// latest change is kept, so the file does not grow with every edit.
const STAMPED = ['tasks', 'log'];

function contentOf(record) {
  const { created, updated, ...rest } = record;
  return JSON.stringify(rest);
}

export function stampChanges(before, after, by, at) {
  if (!by) return after;
  for (const key of STAMPED) {
    const old = new Map((before[key] || []).map((x) => [x.id, contentOf(x)]));
    for (const x of after[key] || []) {
      if (!old.has(x.id)) {
        if (!x.created) x.created = { by, at };
      } else if (old.get(x.id) !== contentOf(x)) {
        x.updated = { by, at };
      }
    }
  }
  return after;
}

// Moves a task next to another one (taking that one's heading), or to the start
// or end of a heading. Order only matters among tasks of the same heading.
export function moveTaskTo(doc, id, { before, after, phase, at = 'end' } = {}) {
  const from = doc.tasks.findIndex((t) => t.id === id);
  if (from < 0 || id === before || id === after) return;
  const [task] = doc.tasks.splice(from, 1);
  const anchorId = before || after;
  const anchor = anchorId && doc.tasks.findIndex((t) => t.id === anchorId);
  if (anchorId && anchor >= 0) {
    task.phase = doc.tasks[anchor].phase;
    doc.tasks.splice(after ? anchor + 1 : anchor, 0, task);
    return;
  }
  if (phase) task.phase = phase;
  const inPhase = doc.tasks.map((t, i) => (t.phase === task.phase ? i : -1)).filter((i) => i >= 0);
  if (!inPhase.length) doc.tasks.push(task);
  else if (at === 'start') doc.tasks.splice(inPhase[0], 0, task);
  else doc.tasks.splice(inPhase[inPhase.length - 1] + 1, 0, task);
}

export function movePhase(doc, id, { before, after } = {}) {
  const from = doc.phases.findIndex((p) => p.id === id);
  if (from < 0 || id === before || id === after) return;
  const [phase] = doc.phases.splice(from, 1);
  const anchor = doc.phases.findIndex((p) => p.id === (before || after));
  if (anchor < 0) doc.phases.push(phase);
  else doc.phases.splice(after ? anchor + 1 : anchor, 0, phase);
}

// The last day of a task that starts on `startIso` and needs `duration` working
// days. Used to keep a finished task's end in step when its dates are edited.
export function endFor(task, doc, startIso, duration) {
  const spans = pauseDays(task, doc);
  return toIso(forwardEnd(nextWorking(toDay(startIso), spans), duration || 1, spans));
}

// Working days a task needs in order to finish on `endDay` when it starts on `startDay`.
export function durationForEnd(task, doc, startDay, endDay) {
  const spans = pauseDays(task, doc);
  let n = 0;
  for (let d = startDay; d <= endDay; d++) {
    if (!spans.some(([s, e]) => d >= s && d <= e)) n++;
  }
  return Math.max(n, 1);
}

export function newTaskId(doc) {
  let max = 0;
  for (const t of doc.tasks) {
    const m = /^T(\d+)$/.exec(t.id);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `T${String(max + 1).padStart(3, '0')}`;
}

export function validateDoc(doc) {
  const errors = [];
  if (!doc || typeof doc !== 'object') return ['המסמך ריק'];
  if (!Array.isArray(doc.tasks)) errors.push('חסר tasks');
  if (!Array.isArray(doc.phases)) errors.push('חסר phases');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(doc.projectStart || '')) errors.push('projectStart לא תקין');
  const ids = new Set();
  for (const t of doc.tasks || []) {
    if (!t.id) errors.push('משימה בלי מזהה');
    if (ids.has(t.id)) errors.push(`מזהה כפול: ${t.id}`);
    ids.add(t.id);
  }
  return errors;
}
