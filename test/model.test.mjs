import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  schedule, toDay, toIso, findIssues, mergeDocs, wouldCreateCycle, weekSummary, validateDoc, addDays,
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
