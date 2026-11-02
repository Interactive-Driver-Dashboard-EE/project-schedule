import { s } from './dom.js';
import { isMilestone, toDay, toIso } from './model.js';

// Hues come from a validated categorical order: its first three slots hold up
// for marks that can sit next to any other, so documents get neutral gray.
export const PALETTES = {
  light: {
    surface: '#fcfcfb', ink: '#0b0b0b', ink2: '#52514e', muted: '#898781', grid: '#e1e0d9', axis: '#c3c2b7',
    band: '#f0efec', bandInk: '#52514e', baseline: '#52514e', critical: '#d03b3b', hover: 'rgba(11,11,11,0.05)',
    hatch: 'rgba(255,255,255,0.75)',
    tracks: { hw: '#2a78d6', fw: '#eb6834', veh: '#1baf7a', docs: '#898781' },
  },
  dark: {
    surface: '#1a1a19', ink: '#f0efec', ink2: '#c3c2b7', muted: '#898781', grid: '#2c2c2a', axis: '#383835',
    band: '#262624', bandInk: '#c3c2b7', baseline: '#c3c2b7', critical: '#e66767', hover: 'rgba(255,255,255,0.06)',
    hatch: 'rgba(255,255,255,0.55)',
    tracks: { hw: '#3987e5', fw: '#d95926', veh: '#199e70', docs: '#898781' },
  },
};

export const ROW_H = 32;
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
    if (width > 44) {
      g.append(s('text', {
        x: left + width / 2, y: 38, 'text-anchor': 'middle', 'font-size': 10, fill: P.bandInk,
      }, (L.lang === 'en' && b.shortEn) || b.short || b.name));
    }
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

function drawMilestone(g, L, t, r, y, P, late) {
  const cx = L.x(r.end + 0.5);
  const cy = y + ROW_H / 2;
  const size = t.type === 'gate' ? 8 : 7;
  const color = t.type === 'milestone' ? (P.tracks[t.track] || P.ink2) : P.ink;
  const hollow = t.unverified || t.decision;
  const part = s('g', { dataset: { task: t.id, part: 'bar' }, class: 'bar' });
  part.append(s('rect', { x: cx - 13, y, width: 26, height: ROW_H, fill: 'transparent' }));
  if (late) part.append(s('polygon', { points: diamond(cx, cy, size + 3), fill: 'none', stroke: P.critical, 'stroke-width': 2 }));
  part.append(s('polygon', {
    points: diamond(cx, cy, size),
    fill: hollow ? P.surface : t.status === 'done' ? P.muted : color,
    stroke: t.status === 'done' ? P.muted : color,
    'stroke-width': 2,
  }));
  if (t.type === 'gate') part.append(s('polygon', { points: diamond(cx, cy, 3), fill: hollow ? color : P.surface }));
  const iso = toIso(r.end);
  part.append(s('text', {
    x: cx + (L.sign * (size + 5)), y: cy + 4, 'font-size': 10.5, fill: P.ink2,
    'text-anchor': L.sign > 0 ? 'start' : 'end',
  }, `${Number(iso.slice(8))}.${Number(iso.slice(5, 7))}${t.unverified ? ' ?' : ''}`));
  g.append(part);
}

function drawBar(g, L, t, r, y, P, opts, critical) {
  const { left, width } = span(L, r.start, r.end);
  const color = P.tracks[t.track] || P.tracks.docs;
  const top = y + 8;
  const height = ROW_H - 16;
  const part = s('g', { dataset: { task: t.id, part: 'bar' }, class: 'bar' });
  part.append(s('rect', { x: left - 2, y: y + 2, width: width + 4, height: ROW_H - 4, fill: 'transparent' }));
  const done = t.status === 'done';
  part.append(s('rect', {
    x: left, y: top, width, height, rx: 4, fill: color, 'fill-opacity': done ? 0.45 : 0.3, stroke: color,
    'stroke-width': 1, 'stroke-dasharray': t.decision ? '3 2' : undefined,
  }));
  const pct = done ? 0 : Math.min(Math.max(t.progress || 0, 0), 100) / 100;
  if (pct > 0) {
    const w = width * pct;
    part.append(s('rect', { x: L.sign > 0 ? left : left + width - w, y: top, width: w, height, rx: 4, fill: color }));
  }
  if (t.external) part.append(s('rect', { x: left, y: top, width, height, rx: 4, fill: 'url(#hatch)' }));
  if (critical) {
    part.append(s('rect', {
      x: left - 1, y: top - 1, width: width + 2, height: height + 2, rx: 5, fill: 'none', stroke: P.critical, 'stroke-width': 2,
    }));
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
}

// `rows` is the visible list: {kind:'phase', phase, roll} or {kind:'task', task}.
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
  rows.forEach((_, i) => {
    const ly = (i + 1) * ROW_H;
    root.append(s('line', { x1: 0, x2: L.width, y1: ly, y2: ly, stroke: P.grid, 'stroke-opacity': 0.6 }));
  });

  const hover = s('rect', { x: 0, width: L.width, height: ROW_H, fill: P.hover, visibility: 'hidden', 'pointer-events': 'none' });
  root.append(hover);

  const yOf = new Map();
  rows.forEach((row, i) => { if (row.kind === 'task') yOf.set(row.task.id, i * ROW_H); });

  if (opts.baseline) {
    for (const row of rows) {
      if (row.kind !== 'task') continue;
      const b = opts.baseline.tasks[row.task.id];
      if (!b) continue;
      const { left, width } = span(L, toDay(b.start), toDay(b.end));
      root.append(s('rect', { x: left, y: yOf.get(row.task.id) + ROW_H - 7, width: Math.max(width, 3), height: 3, rx: 1.5, fill: P.baseline }));
    }
  }

  const criticalOf = (t, r) => {
    if (t.status === 'done') return false;
    if (r.slack < 0) return true;
    if (isMilestone(t)) return false;
    return opts.showCritical && r.slack <= opts.criticalDays;
  };

  if (opts.showDeps) {
    const layer = s('g', { 'pointer-events': 'none' });
    for (const row of rows) {
      if (row.kind !== 'task') continue;
      const t = row.task;
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
        const hot = criticalOf(t, r) && criticalOf(pred, p);
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
    if (row.kind === 'phase') {
      if (!row.roll) return;
      const { left, width } = span(L, row.roll.start, row.roll.end);
      root.append(s('rect', { x: left, y: y + 12, width, height: 6, rx: 3, fill: P.ink2 }));
      return;
    }
    const t = row.task;
    const r = sched.rows.get(t.id);
    if (!r) return;
    if (isMilestone(t)) drawMilestone(root, L, t, r, y, P, opts.lateMilestones?.has(t.id));
    else drawBar(root, L, t, r, y, P, opts, criticalOf(t, r));
  });

  if (opts.todayDay >= L.start && opts.todayDay <= L.end) {
    const tx = L.x(opts.todayDay + 0.5);
    root.append(s('line', { x1: tx, x2: tx, y1: 0, y2: height, stroke: P.ink, 'stroke-width': 2, 'pointer-events': 'none' }));
  }
  return { node: root, height, hover };
}
