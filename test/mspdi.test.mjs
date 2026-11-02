import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { schedule, toIso } from '../js/model.js';
import { toMspdi } from '../js/mspdi.js';

const doc = JSON.parse(readFileSync(new URL('../dev/fixture.json', import.meta.url), 'utf8'));
const out = toMspdi(doc, schedule(doc));

test('exports every phase and task once, in the Microsoft Project namespace', () => {
  assert.match(out, /<Project xmlns="http:\/\/schemas\.microsoft\.com\/project">/);
  assert.equal(out.match(/<Task>/g).length, doc.tasks.length + doc.phases.length);
  assert.equal(out.match(/<Summary>1<\/Summary>/g).length, doc.phases.length);
});

test('task uids are unique and predecessors point at real tasks', () => {
  const uids = [...out.matchAll(/<Task><UID>(\d+)<\/UID>/g)].map((m) => m[1]);
  assert.equal(new Set(uids).size, uids.length);
  for (const [, uid] of out.matchAll(/<PredecessorUID>(\d+)<\/PredecessorUID>/g)) assert.ok(uids.includes(uid));
  const links = doc.tasks.reduce((n, t) => n + t.deps.length, 0);
  assert.equal(out.match(/<PredecessorLink>/g).length, links);
});

test('dates match the computed schedule and milestones have no duration', () => {
  const s = schedule(doc);
  const bringUp = s.rows.get('T005');
  assert.ok(out.includes(`<Name>Bring-up</Name><OutlineNumber>2.2</OutlineNumber><OutlineLevel>2</OutlineLevel><Start>${toIso(bringUp.start)}T08:00:00</Start><Finish>${toIso(bringUp.end)}T17:00:00</Finish>`));
  assert.match(out, /<Name>Report due<\/Name>.*<Duration>PT0H0M0S<\/Duration>.*<Milestone>1<\/Milestone>/);
});

test('names are escaped', () => {
  const tricky = structuredClone(doc);
  tricky.tasks[0].name = 'A & B <C>';
  assert.ok(toMspdi(tricky, schedule(tricky)).includes('A &amp; B &lt;C&gt;'));
});

test('English names are used when requested and fall back to the main name', () => {
  const en = structuredClone(doc);
  en.tasks[0].nameEn = 'English name';
  const text = toMspdi(en, schedule(en), 'en');
  assert.ok(text.includes('English name'));
  assert.ok(text.includes('Fabrication'));
});
