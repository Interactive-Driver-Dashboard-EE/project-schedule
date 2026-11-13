import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  schedule, toDay, toIso, findIssues, mergeDocs, wouldCreateCycle, weekSummary, validateDoc, addDays,
  stampChanges, moveTaskTo, movePhase, endFor, expenseSummary,
} from '../js/model.js';

const base = (tasks, extra = {}) => ({ projectStart: '2027-01-01', phases: [], tasks, ...extra });
const iso = (s, id, field) => toIso(s.rows.get(id)[field]);

test('finish-to-start pushes the successor to the next day', () => {
  const s = schedule(base([
    { id: 'a', duration: 5 },
    { id: 'b', duration: 2, deps: [{ id: 'a' }] },
  ]));
  assert.equal(iso(s, 'a', 'end'), '2027-01-05');
  assert.equal(iso(s, 'b', 'start'), '2027-01-06');
  assert.equal(iso(s, 'b', 'end'), '2027-01-07');
  assert.equal(s.rows.get('b').drivenBy, 'a');
});

test('lag adds days between tasks', () => {
  const s = schedule(base([
    { id: 'a', duration: 1 },
    { id: 'b', duration: 1, deps: [{ id: 'a', lag: 3 }] },
  ]));
  assert.equal(iso(s, 'b', 'start'), '2027-01-05');
});

test('a manual start only moves a task later than its dependencies allow', () => {
  const s = schedule(base([
    { id: 'a', duration: 5 },
    { id: 'late', duration: 1, start: '2027-02-01', deps: [{ id: 'a' }] },
    { id: 'early', duration: 1, start: '2026-12-01', deps: [{ id: 'a' }] },
  ]));
  assert.equal(iso(s, 'late', 'start'), '2027-02-01');
  assert.equal(iso(s, 'early', 'start'), '2027-01-06');
});

test('team work pauses during a blackout and external work does not', () => {
  const blackouts = [{ id: 'x', start: '2027-01-03', end: '2027-01-10', appliesTo: 'all' }];
  const s = schedule(base([
    { id: 'team', duration: 4 },
    { id: 'fab', duration: 4, external: true },
  ], { blackouts }));
  assert.equal(iso(s, 'team', 'end'), '2027-01-12');
  assert.equal(iso(s, 'fab', 'end'), '2027-01-04');
});

test('a task starting inside a blackout moves to the first day after it', () => {
  const blackouts = [{ id: 'x', start: '2027-01-01', end: '2027-01-02', appliesTo: 'all' }];
  const s = schedule(base([{ id: 'a', duration: 1 }], { blackouts }));
  assert.equal(iso(s, 'a', 'start'), '2027-01-03');
});

test('a blackout for one person pauses only that owner', () => {
  const blackouts = [{ id: 'm', start: '2027-01-02', end: '2027-01-04', appliesTo: 'p1' }];
  const s = schedule(base([
    { id: 'mine', duration: 3, owner: 'p1' },
    { id: 'other', duration: 3, owner: 'p2' },
  ], { blackouts }));
  assert.equal(iso(s, 'mine', 'end'), '2027-01-06');
  assert.equal(iso(s, 'other', 'end'), '2027-01-03');
});

test('a fixed milestone keeps its date and reports late predecessors', () => {
  const doc = base([
    { id: 'work', duration: 40 },
    { id: 'due', type: 'deadline', fixed: '2027-01-10', deps: [{ id: 'work' }] },
  ]);
  const s = schedule(doc);
  assert.equal(iso(s, 'due', 'end'), '2027-01-10');
  const issue = findIssues(doc, s, '2027-01-01').find((i) => i.code === 'missed-fixed');
  assert.equal(issue.taskId, 'due');
  assert.equal(issue.days, 30);
  assert.deepEqual(issue.late, ['work']);
  assert.equal(s.rows.get('work').slack, -30);
});

test('a milestone may share a day with its last predecessor', () => {
  const doc = base([
    { id: 'work', duration: 10 },
    { id: 'due', type: 'deadline', fixed: '2027-01-10', deps: [{ id: 'work' }] },
  ]);
  const s = schedule(doc);
  assert.equal(s.rows.get('work').slack, 0);
  assert.equal(findIssues(doc, s, '2027-01-01').filter((i) => i.code === 'missed-fixed').length, 0);
});

test('slack comes from the tightest downstream deadline', () => {
  const s = schedule(base([
    { id: 'a', duration: 2 },
    { id: 'b', duration: 2, deps: [{ id: 'a' }] },
    { id: 'c', duration: 2, deps: [{ id: 'a' }] },
    { id: 'tight', type: 'deadline', fixed: '2027-01-06', deps: [{ id: 'b' }] },
    { id: 'loose', type: 'deadline', fixed: '2027-02-01', deps: [{ id: 'c' }] },
  ]));
  assert.equal(s.rows.get('b').slack, 2);
  assert.equal(s.rows.get('a').slack, 2);
  assert.equal(s.rows.get('c').slack, 28);
});

test('slack accounts for blackouts on the way back', () => {
  const blackouts = [{ id: 'x', start: '2027-01-05', end: '2027-01-08', appliesTo: 'all' }];
  const s = schedule(base([
    { id: 'a', duration: 2 },
    { id: 'b', duration: 3, deps: [{ id: 'a' }] },
    { id: 'due', type: 'deadline', fixed: '2027-01-11', deps: [{ id: 'b' }] },
  ], { blackouts }));
  // b runs Jan 3,4,9 and may slide two days to Jan 4,9,10... latest finish is Jan 11.
  assert.equal(iso(s, 'b', 'end'), '2027-01-09');
  assert.equal(s.rows.get('b').slack, 2);
});

test('a finished task uses its actual end', () => {
  const s = schedule(base([
    { id: 'a', duration: 10, start: '2027-01-01', status: 'done', actualEnd: '2027-01-03' },
    { id: 'b', duration: 1, deps: [{ id: 'a' }] },
  ]));
  assert.equal(iso(s, 'b', 'start'), '2027-01-04');
});

test('finishing before the planned start keeps the bar valid', () => {
  const s = schedule(base([{ id: 'a', duration: 5, start: '2027-03-01', status: 'done', actualEnd: '2027-01-10' }]));
  assert.equal(iso(s, 'a', 'start'), '2027-01-10');
  assert.equal(iso(s, 'a', 'end'), '2027-01-10');
});

test('cycles are detected, reported, and do not hang', () => {
  const doc = base([
    { id: 'a', duration: 1, deps: [{ id: 'b' }] },
    { id: 'b', duration: 1, deps: [{ id: 'a' }] },
    { id: 'c', duration: 1 },
  ]);
  const s = schedule(doc);
  assert.deepEqual(s.cycle.sort(), ['a', 'b']);
  assert.equal(findIssues(doc, s, '2027-01-01').filter((i) => i.code === 'cycle').length, 2);
  assert.equal(wouldCreateCycle(doc, 'c', 'c'), true);
  const chain = base([{ id: 'a' }, { id: 'b', deps: [{ id: 'a' }] }, { id: 'c', deps: [{ id: 'b' }] }]);
  assert.equal(wouldCreateCycle(chain, 'a', 'c'), true);
  assert.equal(wouldCreateCycle(chain, 'c', 'a'), false);
});

test('dependencies on deleted tasks are ignored', () => {
  const s = schedule(base([{ id: 'a', duration: 1, deps: [{ id: 'gone' }] }]));
  assert.equal(iso(s, 'a', 'start'), '2027-01-01');
});

test('overdue work and open decisions are reported; finished work is not', () => {
  const doc = base([
    { id: 'late', duration: 2 },
    { id: 'old', duration: 2, status: 'done' },
    { id: 'q', duration: 30, decision: true, unverified: true },
  ]);
  const codes = findIssues(doc, schedule(doc), '2027-01-20').map((i) => `${i.code}:${i.taskId}`);
  assert.ok(codes.includes('overdue:late'));
  assert.ok(codes.includes('open-decision:q'));
  assert.ok(codes.includes('unverified:q'));
  assert.ok(!codes.some((c) => c.endsWith(':old')));
});

test('week summary groups work around the current week', () => {
  const doc = base([
    { id: 'now', duration: 30 },
    { id: 'done', duration: 1, status: 'done', doneAt: '2027-01-05' },
    { id: 'soon', type: 'deadline', fixed: '2027-01-20' },
    { id: 'far', type: 'deadline', fixed: '2027-06-01' },
  ]);
  const w = weekSummary(doc, schedule(doc), '2027-01-06');
  assert.equal(toIso(w.weekStart), '2027-01-03');
  assert.deepEqual(w.active.map((x) => x.t.id), ['now']);
  assert.deepEqual(w.doneLast.map((x) => x.t.id), ['done']);
  assert.deepEqual(w.upcoming.map((x) => x.t.id), ['soon']);
});

test('merge keeps edits to different tasks from both sides', () => {
  const b = base([{ id: 'a', name: 'a0' }, { id: 'b', name: 'b0' }]);
  const mine = structuredClone(b); mine.tasks[0].name = 'a-mine';
  const theirs = structuredClone(b); theirs.tasks[1].name = 'b-theirs';
  const { merged, conflicts } = mergeDocs(b, mine, theirs);
  assert.deepEqual(merged.tasks.map((t) => t.name), ['a-mine', 'b-theirs']);
  assert.equal(conflicts.length, 0);
});

test('merge reports a same-record conflict and keeps my version', () => {
  const b = base([{ id: 'a', name: 'a0' }]);
  const mine = structuredClone(b); mine.tasks[0].name = 'mine';
  const theirs = structuredClone(b); theirs.tasks[0].name = 'theirs';
  const { merged, conflicts } = mergeDocs(b, mine, theirs);
  assert.equal(merged.tasks[0].name, 'mine');
  assert.deepEqual(conflicts, [{ collection: 'tasks', id: 'a' }]);
});

test('merge carries additions and deletions from both sides', () => {
  const b = base([{ id: 'a' }, { id: 'b' }, { id: 'c' }]);
  const mine = structuredClone(b); mine.tasks = mine.tasks.filter((t) => t.id !== 'a'); mine.tasks.push({ id: 'mine' });
  const theirs = structuredClone(b); theirs.tasks = theirs.tasks.filter((t) => t.id !== 'b'); theirs.tasks.push({ id: 'theirs' });
  const { merged, conflicts } = mergeDocs(b, mine, theirs);
  assert.deepEqual(merged.tasks.map((t) => t.id).sort(), ['c', 'mine', 'theirs']);
  assert.equal(conflicts.length, 0);
});

test('merge does not resurrect or lose a task deleted against an edit', () => {
  const b = base([{ id: 'a', name: 'a0' }]);
  const mine = structuredClone(b); mine.tasks = [];
  const theirs = structuredClone(b); theirs.tasks[0].name = 'edited';
  const { merged, conflicts } = mergeDocs(b, mine, theirs);
  assert.equal(merged.tasks[0].name, 'edited');
  assert.equal(conflicts.length, 1);
});

test('validation catches duplicate ids and bad shapes', () => {
  assert.deepEqual(validateDoc(base([{ id: 'a' }])), []);
  assert.ok(validateDoc(base([{ id: 'a' }, { id: 'a' }])).some((e) => e.includes('a')));
  assert.ok(validateDoc({}).length > 0);
});

test('date helpers round-trip across a leap day', () => {
  assert.equal(addDays('2028-02-28', 1), '2028-02-29');
  assert.equal(toIso(toDay('2027-07-25')), '2027-07-25');
});

test('stamps mark who added a task and who changed it last', () => {
  const before = base([{ id: 'a', name: 'old' }, { id: 'b', name: 'same', updated: { by: 'p2', at: 'x' } }]);
  const after = structuredClone(before);
  after.tasks[0].name = 'new';
  after.tasks.push({ id: 'c', name: 'added' });
  after.log = [{ id: 'l1', text: 'note' }];
  stampChanges(before, after, 'p1', '2027-01-01T10:00Z');
  assert.deepEqual(after.tasks[0].updated, { by: 'p1', at: '2027-01-01T10:00Z' });
  assert.equal(after.tasks[0].created, undefined);
  assert.deepEqual(after.tasks[1].updated, { by: 'p2', at: 'x' });
  assert.deepEqual(after.tasks[2].created, { by: 'p1', at: '2027-01-01T10:00Z' });
  assert.equal(after.tasks[2].updated, undefined);
  assert.equal(after.log[0].created.by, 'p1');
});

test('stamps ignore a change to the stamps alone and an unknown person', () => {
  const before = base([{ id: 'a', name: 'n' }]);
  const after = structuredClone(before);
  after.tasks[0].created = { by: 'p2', at: 'y' };
  stampChanges(before, after, 'p1', 'now');
  assert.equal(after.tasks[0].updated, undefined);
  const other = structuredClone(before);
  other.tasks[0].name = 'changed';
  stampChanges(before, other, null, 'now');
  assert.equal(other.tasks[0].updated, undefined);
});

test('a task moves next to another and takes its heading', () => {
  const doc = base([{ id: 'a', phase: 'x' }, { id: 'b', phase: 'x' }, { id: 'c', phase: 'y' }, { id: 'd', phase: 'y' }]);
  moveTaskTo(doc, 'a', { after: 'c' });
  assert.deepEqual(doc.tasks.map((t) => t.id), ['b', 'c', 'a', 'd']);
  assert.equal(doc.tasks[2].phase, 'y');
  moveTaskTo(doc, 'd', { before: 'b' });
  assert.deepEqual(doc.tasks.map((t) => `${t.id}${t.phase}`), ['dx', 'bx', 'cy', 'ay']);
});

test('a task moves to the start or end of a heading', () => {
  const doc = base([{ id: 'a', phase: 'x' }, { id: 'b', phase: 'y' }, { id: 'c', phase: 'y' }]);
  moveTaskTo(doc, 'a', { phase: 'y', at: 'start' });
  assert.deepEqual(doc.tasks.map((t) => t.id), ['a', 'b', 'c']);
  assert.equal(doc.tasks[0].phase, 'y');
  moveTaskTo(doc, 'b', { phase: 'z' });
  assert.deepEqual(doc.tasks.map((t) => `${t.id}${t.phase}`), ['ay', 'cy', 'bz']);
});

test('headings reorder before or after another heading', () => {
  const doc = base([], { phases: [{ id: 'x' }, { id: 'y' }, { id: 'z' }] });
  movePhase(doc, 'z', { before: 'x' });
  assert.deepEqual(doc.phases.map((p) => p.id), ['z', 'x', 'y']);
  movePhase(doc, 'z', { after: 'y' });
  assert.deepEqual(doc.phases.map((p) => p.id), ['x', 'y', 'z']);
});

test('log entries added on both sides are both kept', () => {
  const b = base([], { log: [{ id: 'l0', text: 'first' }] });
  const mine = structuredClone(b); mine.log.push({ id: 'l1', text: 'mine' });
  const theirs = structuredClone(b); theirs.log.push({ id: 'l2', text: 'theirs' });
  const { merged, conflicts } = mergeDocs(b, mine, theirs);
  assert.deepEqual(merged.log.map((x) => x.id), ['l0', 'l1', 'l2']);
  assert.equal(conflicts.length, 0);
  assert.equal('log' in mergeDocs(base([]), base([]), base([])).merged, false);
});

test('the end of a finished task follows its start and duration', () => {
  const blackouts = [{ id: 'x', start: '2027-01-03', end: '2027-01-05', appliesTo: 'p1' }];
  const doc = base([], { blackouts });
  assert.equal(endFor({ owner: 'p2' }, doc, '2027-01-01', 7), '2027-01-07');
  assert.equal(endFor({ owner: 'p1' }, doc, '2027-01-01', 7), '2027-01-10');
  assert.equal(endFor({ owner: 'p1' }, doc, '2027-01-04', 1), '2027-01-06');
});

test('expenses added on both sides are both kept, and an edit against a delete is not lost', () => {
  const b = base([], { expenses: [{ id: 'e0', title: 'resistors', amount: 12 }] });
  const mine = structuredClone(b); mine.expenses.push({ id: 'e1', title: 'PCB', amount: 80 });
  const theirs = structuredClone(b); theirs.expenses.push({ id: 'e2', title: 'cable', amount: 5 });
  const { merged, conflicts } = mergeDocs(b, mine, theirs);
  assert.deepEqual(merged.expenses.map((x) => x.id), ['e0', 'e1', 'e2']);
  assert.equal(conflicts.length, 0);
  const gone = structuredClone(b); gone.expenses = [];
  const edited = structuredClone(b); edited.expenses[0].amount = 15;
  const second = mergeDocs(b, gone, edited);
  assert.equal(second.merged.expenses[0].amount, 15);
  assert.equal(second.conflicts.length, 1);
  assert.equal('expenses' in mergeDocs(base([]), base([]), base([])).merged, false);
});

test('stamps mark who added an expense', () => {
  const before = base([]);
  const after = structuredClone(before);
  after.expenses = [{ id: 'e1', title: 'PCB' }];
  stampChanges(before, after, 'p2', '2027-01-01T10:00Z');
  assert.deepEqual(after.expenses[0].created, { by: 'p2', at: '2027-01-01T10:00Z' });
});

test('expense totals stay per currency and separate spent, planned and owed', () => {
  const sum = expenseSummary([
    { amount: 100, currency: 'ILS', status: 'paid', paidBy: 'p1', category: 'parts' },
    { amount: 50.5, status: 'reimbursed', paidBy: 'p2', category: 'pcb' },
    { amount: 30, status: 'paid', paidBy: 'dept', category: 'parts' },
    { amount: 200, status: 'planned', paidBy: 'p1', category: 'tools' },
    { amount: 20, currency: 'USD', status: 'paid', paidBy: 'p2' },
    { title: 'no price yet', status: 'paid', paidBy: 'p1' },
    { amount: -5, status: 'paid' },
  ]);
  assert.deepEqual(Object.keys(sum).sort(), ['ILS', 'USD']);
  assert.equal(sum.ILS.spent, 180.5);
  assert.equal(sum.ILS.planned, 200);
  assert.equal(sum.ILS.owed, 100, 'only what a person paid and did not get back');
  assert.deepEqual(sum.ILS.byCategory, { parts: 130, pcb: 50.5 });
  assert.deepEqual(sum.ILS.byPayer, { p1: 100, p2: 50.5, dept: 30 });
  assert.equal(sum.USD.spent, 20);
  assert.equal(sum.USD.byCategory.other, 20);
});
