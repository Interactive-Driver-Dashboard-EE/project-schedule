import { s } from './dom.js';
import { isMilestone, rollup, toDay, toIso } from './model.js';
import { phaseName, taskName } from './mspdi.js';

// Hues come from a validated categorical order: its first three slots hold up
// for marks that can sit next to any other, so documents get neutral gray.
export const PALETTES = {
  light: {
    surface: '#fcfcfb', ink: '#0b0b0b', ink2: '#52514e', muted: '#898781', grid: '#e1e0d9', axis: '#c3c2b7',
    band: '#f0efec', bandInk: '#52514e', baseline: '#52514e', critical: '#d03b3b', hover: 'rgba(11,11,11,0.05)',
    hatch: 'rgba(255,255,255,0.75)', marker: '#fde68a', barFill: 0.3, doneFill: 0.45,
    named: {
      blue: '#2a78d6', orange: '#eb6834', aqua: '#1baf7a', yellow: '#eda100', magenta: '#e87ba4', green: '#008300', violet: '#6250d6', red: '#e34948',
    },
    tracks: { hw: '#2a78d6', fw: '#eb6834', veh: '#1baf7a', docs: '#898781' },
  },
  dark: {
    surface: '#1a1a19', ink: '#f0efec', ink2: '#c3c2b7', muted: '#a3a29b', grid: '#333331', axis: '#55554f',
    band: '#3a3a35', bandInk: '#f0efec', baseline: '#c3c2b7', critical: '#e66767', hover: 'rgba(255,255,255,0.06)',
    hatch: 'rgba(255,255,255,0.55)', marker: '#6b5310', barFill: 0.5, doneFill: 0.65,
    named: {
      blue: '#3987e5', orange: '#d95926', aqua: '#199e70', yellow: '#c98500', magenta: '#d55181', green: '#008300', violet: '#9085e9', red: '#e66767',
    },
    tracks: { hw: '#3987e5', fw: '#d95926', veh: '#199e70', docs: '#898781' },
  },
};

// What each task can choose in the edit panel. Names are written beside every
// mark, so color never has to carry a task's identity alone.
export const STYLE = {
  barShapes: [['rounded', 'מעוגל'], ['square', 'מרובע'], ['pill', 'קפסולה'], ['arrow', 'חץ']],
  markShapes: [['diamond', 'מעוין'], ['circle', 'עיגול'], ['square', 'ריבוע'], ['triangle', 'משולש'], ['star', 'כוכב']],
  colors: [['blue', 'כחול'], ['orange', 'כתום'], ['aqua', 'טורקיז'], ['yellow', 'צהוב'], ['magenta', 'ורוד'], ['green', 'ירוק'], ['violet', 'סגול'], ['red', 'אדום']],
  emphasis: [['bold', 'שם מודגש'], ['marker', 'מרקר על השם'], ['frame', 'מסגרת עבה'], ['large', 'גדול יותר'], ['solid', 'מילוי מלא']],
};

export const ROW_H = 28;
export const HEAD_H = 46;

export function buildLayout(doc, sched, { ppd, lang }) {
  const start = sched.projectStart - 7;
  const end = sched.projectEnd + 21;
  const width = (end - start + 1) * ppd;
  const x = (day) => (lang === 'he' ? width - (day - start) * ppd : (day - start) * ppd);
  return { start, end, width, ppd, lang, x, sign: lang === 'he' ? -1 : 1 };
}

// Left edge and width for an inclusive span of days, in either direction.
function span(L, first, last) {
  const a = L.x(first);
  const b = L.x(last + 1);
  return { left: Math.min(a, b), width: Math.abs(b - a) };
}

function monthsBetween(startDay, endDay) {
  const out = [];
  const d = new Date(startDay * 86400000);
  let y = d.getUTCFullYear();
  let m = d.getUTCMonth();
  for (;;) {
    const first = Math.round(Date.UTC(y, m, 1) / 86400000);
    const next = Math.round(Date.UTC(y, m + 1, 1) / 86400000);
    if (first > endDay) break;
    out.push({ first: Math.max(first, startDay), last: Math.min(next - 1, endDay), y, m, boundary: first });
    m += 1;
    if (m > 11) { m = 0; y += 1; }
  }
  return out;
}

function firstSunday(day) {
  return day + ((7 - new Date(day * 86400000).getUTCDay()) % 7);
}

export function drawHeader(L, doc, P, todayDay) {
  // A fixed direction keeps text-anchor meaning the same inside the RTL page.
  const g = s('g', { direction: 'ltr' });
  const locale = L.lang === 'he' ? 'he-IL' : 'en-GB';
  for (const mo of monthsBetween(L.start, L.end)) {
    const { left, width } = span(L, mo.first, mo.last);
    const label = new Date(Date.UTC(mo.y, mo.m, 1)).toLocaleDateString(locale, {
      month: width > 70 ? 'long' : 'short', timeZone: 'UTC',
    });
    const year = width > 110 ? ` ${mo.y}` : '';
    if (width > 22) {
      g.append(s('text', {
        x: left + width / 2, y: 16, 'text-anchor': 'middle', 'font-size': 12, 'font-weight': 600, fill: P.ink,
      }, label + year));
    }
    if (mo.boundary >= L.start) {
      const edge = L.x(mo.boundary);
      g.append(s('line', { x1: edge, x2: edge, y1: 0, y2: HEAD_H, stroke: P.axis }));
    }
  }
  const every = L.ppd >= 10 ? 7 : L.ppd >= 5 ? 14 : 0;
  if (every) {
    const taken = (doc.blackouts || []).map((b) => [toDay(b.start), toDay(b.end)]);
    for (let d = firstSunday(L.start); d <= L.end; d += every) {
      if (taken.some(([a, b]) => d >= a - 3 && d <= b + 3)) continue;
      const iso = toIso(d);
      g.append(s('text', {
        x: L.x(d) + (L.sign * 2), y: 38, 'text-anchor': L.sign > 0 ? 'start' : 'end', 'font-size': 10, fill: P.muted,
      }, `${Number(iso.slice(8))}.${Number(iso.slice(5, 7))}`));
    }
  }
  for (const b of doc.blackouts || []) {
    const { left, width } = span(L, toDay(b.start), toDay(b.end));
    g.append(s('rect', { x: left, y: 25, width, height: 18, rx: 3, fill: P.band, stroke: P.axis }));
    g.append(s('text', {
      x: left + width / 2, y: 38, 'text-anchor': 'middle', 'font-size': 10, fill: P.bandInk,
    }, (L.lang === 'en' && b.shortEn) || b.short || b.name));
  }
  if (todayDay >= L.start && todayDay <= L.end) {
    const tx = L.x(todayDay + 0.5);
    g.append(s('line', { x1: tx, x2: tx, y1: 20, y2: HEAD_H, stroke: P.ink, 'stroke-width': 2 }));
  }
  return g;
}

function hatchDefs(P) {
  const defs = s('defs');
  defs.append(s('pattern', {
    id: 'hatch', width: 6, height: 6, patternUnits: 'userSpaceOnUse', patternTransform: 'rotate(45)',
  }, s('line', { x1: 0, y1: 0, x2: 0, y2: 6, stroke: P.hatch, 'stroke-width': 2 })));
  return defs;
}

function depPath(L, fromEnd, fromY, toStart, toY) {
  const out = 7 * L.sign;
  const elbow = fromEnd + out;
  const ahead = (toStart - elbow) * L.sign >= 0;
  if (ahead) return `M${fromEnd} ${fromY}H${elbow}V${toY}H${toStart}`;
  const midY = fromY + (toY > fromY ? ROW_H / 2 : -ROW_H / 2);
  return `M${fromEnd} ${fromY}H${elbow}V${midY}H${toStart - out}V${toY}H${toStart}`;
}

function diamond(cx, cy, r) {
  return `${cx},${cy - r} ${cx + r},${cy} ${cx},${cy + r} ${cx - r},${cy}`;
}

function star(cx, cy, r) {
  const points = [];
  for (let i = 0; i < 10; i++) {
    const radius = i % 2 ? r * 0.45 : r * 1.15;
    const angle = (-Math.PI / 2) + ((i * Math.PI) / 5);
    points.push(`${(cx + radius * Math.cos(angle)).toFixed(2)},${(cy + radius * Math.sin(angle)).toFixed(2)}`);
  }
  return points.join(' ');
}

export function markShape(shape, cx, cy, r, attrs) {
  if (shape === 'circle') return s('circle', { cx, cy, r, ...attrs });
  if (shape === 'square') {
    const side = r * 0.85;
    return s('rect', { x: cx - side, y: cy - side, width: side * 2, height: side * 2, rx: 1, ...attrs });
  }
  if (shape === 'triangle') {
    return s('polygon', { points: `${cx},${cy - r} ${cx + r},${cy + r * 0.8} ${cx - r},${cy + r * 0.8}`, ...attrs });
  }
  if (shape === 'star') return s('polygon', { points: star(cx, cy, r), ...attrs });
  return s('polygon', { points: diamond(cx, cy, r), ...attrs });
}

// An arrow points toward later dates, whichever way the chart runs.
export function barShape(L, shape, x, y, w, h, attrs) {
  if (shape === 'arrow') {
    const tip = Math.min(h / 2, w / 2);
    const mid = y + h / 2;
    const right = x + w;
    const points = L.sign > 0
      ? `${x},${y} ${right - tip},${y} ${right},${mid} ${right - tip},${y + h} ${x},${y + h}`
      : `${right},${y} ${x + tip},${y} ${x},${mid} ${x + tip},${y + h} ${right},${y + h}`;
    return s('polygon', { points, ...attrs });
  }
  const rx = shape === 'square' ? 0 : shape === 'pill' ? h / 2 : 4;
  return s('rect', { x, y, width: w, height: h, rx: Math.min(rx, w / 2), ...attrs });
}

const hasEmphasis = (t, key) => (t.emphasis || []).includes(key);
const labelWeight = (t, normal = 500) => (hasEmphasis(t, 'bold') ? 800 : normal);
const markSize = (t) => (t.type === 'gate' ? 8 : 7) + (hasEmphasis(t, 'large') ? 3 : 0);

// Writes a name beside its mark, on the later-in-time side unless it would run
// off the chart. `early` and `late` are the mark's two edges in chart x.
let measurer;

function textWidth(text) {
  if (typeof document === 'undefined') return text.length * 6;
  if (!measurer) {
    measurer = document.createElement('canvas').getContext('2d');
    measurer.font = '500 11.5px system-ui, -apple-system, "Segoe UI", Arial, sans-serif';
  }
  return measurer.measureText(text).width + 2;
}

function labelBox(L, text, early, late, weight = 500) {
  const estimate = textWidth(text) * (weight >= 700 ? 1.08 : 1);
  let extendsLeft = L.sign < 0;
  const edge = () => (extendsLeft ? Math.min(early, late) - 6 : Math.max(early, late) + 6);
  const overflows = () => (extendsLeft ? edge() - estimate < 0 : edge() + estimate > L.width);
  if (overflows()) extendsLeft = !extendsLeft;
  // A mark spanning the whole chart leaves no room on either side, so the name
  // goes over its middle instead.
  const centered = overflows();
  const x = centered ? (early + late) / 2 : edge();
  const from = centered ? x - estimate / 2 : extendsLeft ? x - estimate : x;
  return { x, centered, extendsLeft, from, to: from + estimate };
}

function drawLabel(g, L, text, early, late, y, P, weight, marker) {
  const box = labelBox(L, text, early, late, weight);
  const rtl = L.lang === 'he';
  if (marker) {
    g.append(s('rect', {
      x: box.from - 3, y: y - 12, width: box.to - box.from + 6, height: 16, rx: 3, fill: P.marker, 'pointer-events': 'none',
    }));
  }
  g.append(s('text', {
    x: box.x, y, 'font-size': 11.5, 'font-weight': weight, fill: P.ink,
    direction: rtl ? 'rtl' : 'ltr',
    'text-anchor': box.centered ? 'middle' : box.extendsLeft === rtl ? 'start' : 'end',
    ...(marker ? {} : { stroke: P.surface, 'stroke-width': box.centered ? 7 : 3, 'paint-order': 'stroke' }),
    'pointer-events': 'none',
  }, text));
}

function milestoneText(t, r, L) {
  const iso = toIso(r.end);
  const date = `${iso.slice(8)}.${iso.slice(5, 7)}.${iso.slice(2, 4)}`;
  const flag = t.unverified ? (L.lang === 'en' ? ' · unverified' : ' · לא מאומת') : '';
  return `${taskName(t, L.lang)} · ${date}${flag}`;
}

// The stretch of chart a task takes up, including its written name.
function footprint(t, r, L) {
  if (isMilestone(t)) {
    const cx = L.x(r.end + 0.5);
    const size = markSize(t);
    const box = labelBox(L, milestoneText(t, r, L), cx - size - 1, cx + size + 1, labelWeight(t));
    return [Math.min(cx - size - 6, box.from - 3), Math.max(cx + size + 6, box.to + 3)];
  }
  const { left, width } = span(L, r.start, r.end);
  const box = labelBox(L, taskName(t, L.lang), left, left + width, labelWeight(t, 400));
  return [Math.min(left, box.from), Math.max(left + width, box.to)];
}

// Places tasks on as few rows as possible: each goes on the first row where
// neither its mark nor its name touches anything already there.
function pack(entries) {
  const lanes = [];
  for (const { item, from, to } of entries) {
    let lane = lanes.find((l) => l.spans.every(([a, b]) => to + 8 <= a || from - 8 >= b));
    if (!lane) {
      lane = { items: [], spans: [] };
      lanes.push(lane);
    }
    lane.items.push(item);
    lane.spans.push([from, to]);
  }
  return lanes.map((l) => l.items);
}

export function packLanes(L, sched, tasks) {
  const ordered = tasks
    .filter((t) => sched.rows.has(t.id))
    .sort((a, b) => sched.rows.get(a.id).start - sched.rows.get(b.id).start);
  return pack(ordered.map((t) => {
    const [from, to] = footprint(t, sched.rows.get(t.id), L);
    return { item: t, from, to };
  }));
}

function packHeadings(L, heads) {
  const ordered = [...heads].sort((a, b) => a.roll.start - b.roll.start);
  return pack(ordered.map((head) => {
    const { left, width } = span(L, head.roll.start, head.roll.end);
    const box = labelBox(L, phaseName(head.phase, L.lang), left, left + width);
    return { item: head, from: Math.min(left, box.from), to: Math.max(left + width, box.to) };
  }));
}

// The visible rows for a layout:
//   'list'     one row per task, under its heading
//   'heading'  each heading's tasks share as few rows as possible
//   'together' headings on top, then all tasks sharing rows regardless of heading
export function layoutRows(doc, sched, L, layout, { match = () => true, collapsed = [], filtering = false } = {}) {
  const rows = [];
  const heads = [];
  for (const phase of doc.phases) {
    const kids = doc.tasks.filter((t) => t.phase === phase.id && match(t));
    if (filtering && !kids.length) continue;
    const roll = rollup(doc, sched, phase.id);
    if (layout === 'together') {
      if (kids.length && roll) heads.push({ phase, roll });
      continue;
    }
    const closed = collapsed.includes(phase.id);
    if (layout === 'heading' && kids.length && !closed) {
      const lanes = packLanes(L, sched, kids);
      lanes.forEach((items, i) => rows.push({ kind: 'lane', phase, roll, items, first: i === 0, last: i === lanes.length - 1, count: lanes.length }));
      continue;
    }
    rows.push({ kind: 'phase', phase, roll });
    if (!closed) for (const t of kids) rows.push({ kind: 'task', task: t });
  }
  if (layout === 'together') {
    const headLanes = packHeadings(L, heads);
    headLanes.forEach((items, i) => rows.push({ kind: 'heads', heads: items, last: i === headLanes.length - 1 }));
    const lanes = packLanes(L, sched, doc.tasks.filter(match));
    lanes.forEach((items) => rows.push({ kind: 'lane', items, last: true }));
  }
  return rows;
}

// A small circle at the upper corner where a mark ends, above where its name
// is written. Dragging it onto another task makes that task start after this one.
function linkHandle(t, cx, cy, P) {
  const g = s('g', { class: 'link-handle', dataset: { task: t.id, part: 'link' } });
  g.append(s('circle', { cx, cy, r: 7, fill: 'transparent' }));
  g.append(s('circle', { cx, cy, r: 4, fill: P.surface, stroke: P.ink, 'stroke-width': 1.5 }));
  g.append(s('title', {}, 'גרירה אל משימה אחרת: היא תתחיל אחרי זו'));
  return g;
}

function drawMilestone(g, L, t, r, y, P, late, selected, interactive) {
  const cx = L.x(r.end + 0.5);
  const cy = y + ROW_H / 2;
  const size = markSize(t);
  const color = (t.color && P.named[t.color]) || (t.type === 'milestone' ? (P.tracks[t.track] || P.ink2) : P.ink);
  const hollow = t.unverified || t.decision;
  const faded = t.status === 'done' && !t.color;
  const part = s('g', { dataset: { task: t.id, part: 'bar' }, class: selected ? 'bar sel' : 'bar' });
  part.append(s('rect', { x: cx - size - 6, y, width: (size + 6) * 2, height: ROW_H, fill: 'transparent' }));
  if (late) part.append(markShape(t.shape, cx, cy, size + 3, { fill: 'none', stroke: P.critical, 'stroke-width': 2 }));
  part.append(markShape(t.shape, cx, cy, size, {
    fill: hollow ? P.surface : faded ? P.muted : color,
    stroke: faded ? P.muted : color,
    'stroke-width': 2,
  }));
  if (t.type === 'gate') part.append(markShape(t.shape, cx, cy, 3, { fill: hollow ? color : P.surface }));
  if (hasEmphasis(t, 'frame')) part.append(markShape(t.shape, cx, cy, size + 2, { fill: 'none', stroke: P.ink, 'stroke-width': 2.5 }));
  if (selected) part.append(markShape(t.shape, cx, cy, size + 5, { fill: 'none', stroke: P.ink, 'stroke-width': 1.5 }));
  g.append(part);
  drawLabel(part, L, milestoneText(t, r, L), cx - size - 1, cx + size + 1, cy + 4, P, labelWeight(t), hasEmphasis(t, 'marker'));
  if (interactive) part.append(linkHandle(t, cx + L.sign * (size + 3), y + 5, P));
}

function drawBar(g, L, t, r, y, P, opts, late) {
  const { left, width } = span(L, r.start, r.end);
  const color = (t.color && P.named[t.color]) || P.tracks[t.track] || P.tracks.docs;
  const large = hasEmphasis(t, 'large');
  const top = y + (large ? 4 : 7);
  const height = ROW_H - (large ? 8 : 14);
  const shape = (x, yy, w, hh, attrs) => barShape(L, t.shape, x, yy, w, hh, attrs);
  const part = s('g', { dataset: { task: t.id, part: 'bar' }, class: opts.selected === t.id ? 'bar sel' : 'bar' });
  part.append(s('rect', { x: left - 2, y: y + 2, width: width + 4, height: ROW_H - 4, fill: 'transparent' }));
  const done = t.status === 'done';
  part.append(shape(left, top, width, height, {
    fill: color, 'fill-opacity': hasEmphasis(t, 'solid') ? 1 : done ? P.doneFill : P.barFill, stroke: color,
    'stroke-width': 1, 'stroke-dasharray': t.decision ? '3 2' : undefined,
  }));
  const pct = done ? 0 : Math.min(Math.max(t.progress || 0, 0), 100) / 100;
  if (pct > 0) {
    const w = width * pct;
    part.append(shape(L.sign > 0 ? left : left + width - w, top, w, height, { fill: color }));
  }
  if (t.external) part.append(shape(left, top, width, height, { fill: 'url(#hatch)' }));
  if (hasEmphasis(t, 'frame')) part.append(shape(left, top, width, height, { fill: 'none', stroke: P.ink, 'stroke-width': 2.5 }));
  if (late) {
    part.append(shape(left - 1, top - 1, width + 2, height + 2, { fill: 'none', stroke: P.critical, 'stroke-width': 2 }));
  }
  if (opts.selected === t.id) {
    part.append(shape(left - 3, top - 3, width + 6, height + 6, { fill: 'none', stroke: P.ink, 'stroke-width': 1.5 }));
  }
  if (done && width > 16) {
    part.append(s('text', {
      x: left + width / 2, y: top + height - 3.5, 'text-anchor': 'middle', 'font-size': 11, 'font-weight': 700, fill: P.ink,
    }, '✓'));
  }
  if (opts.interactive) {
    part.append(s('rect', {
      x: L.sign > 0 ? left + width - 6 : left - 2, y: top - 2, width: 8, height: height + 4, fill: 'transparent',
      class: 'handle', dataset: { task: t.id, part: 'end' },
    }));
  }
  g.append(part);
  drawLabel(part, L, taskName(t, L.lang), left, left + width, y + (ROW_H / 2) + 4, P, labelWeight(t, 400), hasEmphasis(t, 'marker'));
  if (opts.interactive) part.append(linkHandle(t, L.sign > 0 ? left + width + 4 : left - 4, Math.max(top - 2, y + 4), P));
}

const rowTasks = (row) => (row.kind === 'task' ? [row.task] : row.items || []);

// `rows` is the visible list: {kind:'phase', phase, roll}, {kind:'task', task},
// or {kind:'lane', phase, items, first, last} for several tasks on one row.
export function drawBody(L, doc, sched, rows, P, opts) {
  const height = Math.max(rows.length * ROW_H, 1);
  const root = s('g', { direction: 'ltr' });
  root.append(hatchDefs(P));
  for (const b of doc.blackouts || []) {
    const { left, width } = span(L, toDay(b.start), toDay(b.end));
    root.append(s('rect', { x: left, y: 0, width, height, fill: P.band }));
  }
  for (const mo of monthsBetween(L.start, L.end)) {
    if (mo.boundary < L.start) continue;
    const edge = L.x(mo.boundary);
    root.append(s('line', { x1: edge, x2: edge, y1: 0, y2: height, stroke: P.axis }));
  }
  if (L.ppd >= 5) {
    for (let d = firstSunday(L.start); d <= L.end; d += 7) {
      root.append(s('line', { x1: L.x(d), x2: L.x(d), y1: 0, y2: height, stroke: P.grid }));
    }
  }
  rows.forEach((row, i) => {
    if ((row.kind === 'lane' || row.kind === 'heads') && !row.last) return;
    const ly = (i + 1) * ROW_H;
    root.append(s('line', { x1: 0, x2: L.width, y1: ly, y2: ly, stroke: P.grid, 'stroke-opacity': 0.6 }));
  });

  const hover = s('rect', { x: 0, width: L.width, height: ROW_H, fill: P.hover, visibility: 'hidden', 'pointer-events': 'none' });
  root.append(hover);

  const yOf = new Map();
  rows.forEach((row, i) => { for (const t of rowTasks(row)) yOf.set(t.id, i * ROW_H); });

  if (opts.baseline) {
    for (const t of rows.flatMap(rowTasks)) {
      const b = opts.baseline.tasks[t.id];
      if (!b) continue;
      const { left, width } = span(L, toDay(b.start), toDay(b.end));
      root.append(s('rect', { x: left, y: yOf.get(t.id) + ROW_H - 7, width: Math.max(width, 3), height: 3, rx: 1.5, fill: P.baseline }));
    }
  }

  const lateOf = (t, r) => t.status !== 'done' && r.slack < 0;

  if (opts.showDeps) {
    const layer = s('g', { 'pointer-events': 'none' });
    for (const t of rows.flatMap(rowTasks)) {
      const r = sched.rows.get(t.id);
      if (!r) continue;
      for (const dep of t.deps || []) {
        const p = sched.rows.get(dep.id);
        if (!p || !yOf.has(dep.id)) continue;
        const pred = doc.tasks.find((x) => x.id === dep.id);
        const fromEnd = isMilestone(pred) ? L.x(p.end + 0.5) + (L.sign * 8) : L.x(p.end + 1);
        const toStart = isMilestone(t) ? L.x(r.end + 0.5) - (L.sign * 9) : L.x(r.start);
        const fromY = yOf.get(dep.id) + ROW_H / 2;
        const toY = yOf.get(t.id) + ROW_H / 2;
        const hot = lateOf(t, r) && lateOf(pred, p);
        layer.append(s('path', {
          d: depPath(L, fromEnd, fromY, toStart, toY), fill: 'none',
          stroke: hot ? P.critical : P.muted, 'stroke-width': 1, 'stroke-opacity': hot ? 0.9 : 0.55,
        }));
        layer.append(s('polygon', {
          points: `${toStart},${toY} ${toStart - (L.sign * 4)},${toY - 3} ${toStart - (L.sign * 4)},${toY + 3}`,
          fill: hot ? P.critical : P.muted, 'fill-opacity': hot ? 0.9 : 0.7,
        }));
      }
    }
    root.append(layer);
  }

  rows.forEach((row, i) => {
    const y = i * ROW_H;
    const heading = (phase, roll) => {
      const { left, width } = span(L, roll.start, roll.end);
      root.append(s('rect', { x: left, y: y + 11, width, height: 6, rx: 3, fill: P.ink2 }));
      drawLabel(root, L, phaseName(phase, L.lang), left, left + width, y + (ROW_H / 2) + 4, P, 700);
    };
    if (row.kind === 'phase') {
      if (row.roll) heading(row.phase, row.roll);
      return;
    }
    if (row.kind === 'heads') {
      for (const head of row.heads) heading(head.phase, head.roll);
      return;
    }
    for (const t of rowTasks(row)) {
      const r = sched.rows.get(t.id);
      if (!r) continue;
      if (isMilestone(t)) drawMilestone(root, L, t, r, y, P, opts.lateMilestones?.has(t.id), opts.selected === t.id, opts.interactive);
      else drawBar(root, L, t, r, y, P, opts, lateOf(t, r));
    }
  });

  if (opts.todayDay >= L.start && opts.todayDay <= L.end) {
    const tx = L.x(opts.todayDay + 0.5);
    root.append(s('line', { x1: tx, x2: tx, y1: 0, y2: height, stroke: P.ink, 'stroke-width': 2, 'pointer-events': 'none' }));
  }
  return { node: root, height, hover };
}
