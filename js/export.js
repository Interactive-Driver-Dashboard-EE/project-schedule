import { s, download } from './dom.js';
import { buildLayout, drawBody, drawHeader, HEAD_H, PALETTES, ROW_H } from './gantt.js';
import { isMilestone, toIso } from './model.js';
import { phaseName, taskName } from './mspdi.js';

const dd = (day) => {
  const i = toIso(day);
  return `${i.slice(8)}.${i.slice(5, 7)}.${i.slice(2, 4)}`;
};

// One self-contained SVG with the task list and chart, always in light colors,
// used for both the image download and printing.
export function buildExportSvg(doc, sched, { lang, baseline, todayDay, criticalDays, lateMilestones }) {
  const P = PALETTES.light;
  const rows = [];
  for (const phase of doc.phases) {
    const kids = doc.tasks.filter((t) => t.phase === phase.id && sched.rows.has(t.id));
    if (!kids.length) continue;
    const rs = kids.map((t) => sched.rows.get(t.id));
    rows.push({ kind: 'phase', phase, roll: { start: Math.min(...rs.map((r) => r.start)), end: Math.max(...rs.map((r) => r.end)) } });
    for (const t of kids) rows.push({ kind: 'task', task: t });
  }
  const L = buildLayout(doc, sched, { ppd: 4, lang });
  const tableW = 420;
  const titleH = 44;
  const legendH = 28;
  const body = drawBody(L, doc, sched, rows, P, {
    showDeps: true, showCritical: true, criticalDays, baseline, todayDay, lateMilestones, interactive: false,
  });
  const totalW = tableW + L.width;
  const totalH = titleH + HEAD_H + body.height + legendH;
  const he = lang === 'he';
  const anchor = he ? 'end' : 'start';
  const svg = s('svg', {
    xmlns: 'http://www.w3.org/2000/svg', viewBox: `0 0 ${totalW} ${totalH}`, width: totalW, height: totalH,
    'font-family': 'system-ui, -apple-system, "Segoe UI", Arial, sans-serif',
  });
  svg.append(s('rect', { width: totalW, height: totalH, fill: P.surface }));
  svg.append(s('text', {
    x: he ? totalW - 10 : 10, y: 26, 'font-size': 18, 'font-weight': 700, fill: P.ink, 'text-anchor': anchor,
  }, lang === 'en' && doc.titleEn ? doc.titleEn : doc.title));
  svg.append(s('text', {
    x: he ? 10 : totalW - 10, y: 26, 'font-size': 12, fill: P.ink2, 'text-anchor': he ? 'start' : 'end',
  }, `${he ? 'נכון ל-' : 'As of '}${dd(todayDay)}`));

  const chart = s('g', { transform: `translate(${he ? 0 : tableW} ${titleH})` });
  chart.append(drawHeader(L, doc, P, todayDay));
  const bodyWrap = s('g', { transform: `translate(0 ${HEAD_H})` });
  bodyWrap.append(body.node);
  chart.append(bodyWrap);
  svg.append(chart);

  const table = s('g', { transform: `translate(${he ? L.width : 0} ${titleH})` });
  table.append(s('rect', { width: tableW, height: HEAD_H + body.height, fill: P.surface }));
  const nameX = he ? tableW - 10 : 10;
  const dateX = he ? 8 : tableW - 8;
  const dateAnchor = he ? 'start' : 'end';
  table.append(s('text', { x: nameX, y: 32, 'font-size': 12, 'font-weight': 600, fill: P.ink2, 'text-anchor': anchor }, he ? 'משימה' : 'Task'));
  table.append(s('text', { x: dateX, y: 32, 'font-size': 12, 'font-weight': 600, fill: P.ink2, 'text-anchor': dateAnchor }, he ? 'תאריכים' : 'Dates'));
  table.append(s('line', { x1: 0, x2: tableW, y1: HEAD_H, y2: HEAD_H, stroke: P.axis }));
  rows.forEach((row, i) => {
    const y = HEAD_H + (i * ROW_H) + 20;
    const isPhase = row.kind === 'phase';
    const name = isPhase ? phaseName(row.phase, lang) : taskName(row.task, lang);
    table.append(s('text', {
      x: isPhase ? nameX : nameX + (he ? -12 : 12), y, 'font-size': 12, 'font-weight': isPhase ? 700 : 400, fill: P.ink, 'text-anchor': anchor,
    }, name.length > 46 ? `${name.slice(0, 45)}…` : name));
    const r = isPhase ? row.roll : sched.rows.get(row.task.id);
    const text = !isPhase && isMilestone(row.task) ? dd(r.end) : `${dd(r.start).slice(0, 5)}–${dd(r.end)}`;
    table.append(s('text', { x: dateX, y, 'font-size': 11, fill: P.ink2, 'text-anchor': dateAnchor }, text));
    const ly = HEAD_H + ((i + 1) * ROW_H);
    table.append(s('line', { x1: 0, x2: tableW, y1: ly, y2: ly, stroke: P.grid }));
  });
  svg.append(table);

  const legendY = totalH - 10;
  const items = he
    ? [['hw', 'חומרה'], ['fw', 'קושחה'], ['veh', 'רכב'], ['docs', 'מסמכים']]
    : [['hw', 'Hardware'], ['fw', 'Firmware'], ['veh', 'Vehicle'], ['docs', 'Documents']];
  let lx = he ? totalW - 10 : 10;
  for (const [key, label] of items) {
    svg.append(s('rect', { x: he ? lx - 14 : lx, y: legendY - 10, width: 14, height: 10, rx: 3, fill: P.tracks[key] }));
    svg.append(s('text', { x: lx + (he ? -18 : 18), y: legendY, 'font-size': 11, fill: P.ink2, 'text-anchor': anchor }, label));
    lx += (he ? -1 : 1) * (34 + (label.length * 7));
  }
  return svg;
}

export function svgText(svg) {
  return new XMLSerializer().serializeToString(svg);
}

export async function downloadPng(svg, filename) {
  const url = URL.createObjectURL(new Blob([svgText(svg)], { type: 'image/svg+xml' }));
  try {
    const img = new Image();
    await new Promise((resolve, reject) => {
      img.onload = resolve;
      img.onerror = () => reject(new Error('svg image failed'));
      img.src = url;
    });
    const canvas = document.createElement('canvas');
    canvas.width = img.width * 2;
    canvas.height = img.height * 2;
    const ctx = canvas.getContext('2d');
    ctx.scale(2, 2);
    ctx.drawImage(img, 0, 0);
    const png = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
    download(filename, png);
  } finally {
    URL.revokeObjectURL(url);
  }
}
