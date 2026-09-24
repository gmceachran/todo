import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  agenda,
  applyOp,
  describeRepeat,
  emptyDoc,
  findCategory,
  nextOccurrence,
  normalizeDoc,
  normalizeTags,
  parseRepeat,
  pruneLog,
} from '../core.js';

const ctx = { now: '2026-09-24T12:00:00.000Z', today: '2026-09-24' };

test('parseRepeat understands presets and phrases', () => {
  assert.deepEqual(parseRepeat('daily'), { every: 1, unit: 'day' });
  assert.deepEqual(parseRepeat('weekdays'), { every: 1, unit: 'week', weekdays: [1, 2, 3, 4, 5] });
  assert.deepEqual(parseRepeat('every 3 days'), { every: 3, unit: 'day' });
  assert.deepEqual(parseRepeat('every other week'), { every: 2, unit: 'week' });
  assert.deepEqual(parseRepeat('every week on mon, wed'), { every: 1, unit: 'week', weekdays: [1, 3] });
  assert.deepEqual(parseRepeat('every tuesday and thursday'), { every: 1, unit: 'week', weekdays: [2, 4] });
  assert.deepEqual(parseRepeat('every month on the 15th'), { every: 1, unit: 'month', day: 15 });
  assert.equal(parseRepeat('none'), null);
  assert.throws(() => parseRepeat('sometimes'));
});

test('describeRepeat produces readable labels', () => {
  assert.equal(describeRepeat(parseRepeat('weekdays')), 'Weekdays');
  assert.equal(describeRepeat(parseRepeat('every mon, fri')), 'Every Mon, Fri');
  assert.equal(describeRepeat(parseRepeat('every month on the 1st')), 'Monthly on the 1st');
  assert.equal(describeRepeat(parseRepeat('every 2 weeks')), 'Every 2 weeks');
});

test('nextOccurrence handles weekdays, month ends and leap days', () => {
  const weekdays = parseRepeat('weekdays');
  assert.equal(nextOccurrence('2026-09-25', weekdays), '2026-09-28');
  assert.equal(nextOccurrence('2026-09-24', weekdays), '2026-09-25');
  assert.equal(nextOccurrence('2026-01-31', { every: 1, unit: 'month', day: 31 }), '2026-02-28');
  assert.equal(nextOccurrence('2026-02-28', { every: 1, unit: 'month', day: 31 }), '2026-03-31');
  assert.equal(nextOccurrence('2028-02-29', { every: 1, unit: 'year', day: 29 }), '2029-02-28');
  const biweeklyMonWed = { every: 2, unit: 'week', weekdays: [1, 3] };
  assert.equal(nextOccurrence('2026-09-21', biweeklyMonWed), '2026-09-23');
  assert.equal(nextOccurrence('2026-09-23', biweeklyMonWed), '2026-10-05');
});

test('completing a recurring task skips past today and can be undone', () => {
  const doc = emptyDoc();
  const { task } = applyOp(doc, { type: 'add', task: { title: 'Stretch', due: '2026-09-20', repeat: 'daily' } }, ctx);
  applyOp(doc, { type: 'complete', id: task.id, due: '2026-09-20' }, ctx);
  assert.equal(task.due, '2026-09-25');
  assert.equal(task.status, 'open');
  assert.equal(applyOp(doc, { type: 'complete', id: task.id, due: '2026-09-20' }, ctx).skipped, 'stale');
  applyOp(doc, { type: 'reopen', id: task.id }, ctx);
  assert.equal(task.due, '2026-09-20');
});

test('recurring tasks without a due date start today', () => {
  const doc = emptyDoc();
  const { task } = applyOp(doc, { type: 'add', task: { title: 'Water plants', repeat: 'weekly' } }, ctx);
  assert.equal(task.due, '2026-09-24');
});

test('source keys dedupe additions and deleted tasks stay deleted', () => {
  const doc = emptyDoc();
  const first = applyOp(doc, { type: 'add', task: { title: 'Fix login', source: 'linear:RM-12' } }, ctx);
  assert.equal(applyOp(doc, { type: 'add', task: { title: 'Fix login', source: 'linear:RM-12' } }, ctx).skipped, 'duplicate');
  applyOp(doc, { type: 'delete', id: first.task.id }, ctx);
  assert.equal(doc.removed['linear:RM-12'], '2026-09-24');
  assert.equal(applyOp(doc, { type: 'add', task: { title: 'Fix login', source: 'linear:RM-12' } }, ctx).skipped, 'removed');
  assert.equal(doc.tasks.length, 0);
});

test('suggestion log records keys without creating tasks', () => {
  const doc = emptyDoc();
  applyOp(doc, { type: 'markSuggested', keys: ['slack:C1/1', 'gmail:abc'] }, ctx);
  assert.deepEqual(doc.suggested, { 'slack:C1/1': '2026-09-24', 'gmail:abc': '2026-09-24' });
  assert.equal(doc.tasks.length, 0);
  const pruned = pruneLog({ old: '2026-01-01', fresh: '2026-09-01' }, '2026-09-24');
  assert.deepEqual(pruned, { fresh: '2026-09-01' });
});

test('tags are normalized', () => {
  assert.deepEqual(normalizeTags(['#Finance', 'deep work', 'finance', '']), ['finance', 'deep-work']);
  assert.deepEqual(normalizeTags('errand, #home'), ['errand', 'home']);
});

test('categories can be added, renamed, reordered, and matched by name', () => {
  const doc = emptyDoc();
  const admin = applyOp(doc, { type: 'addCategory', category: { name: 'Admin' } }, ctx).category;
  const tc = applyOp(doc, { type: 'addCategory', category: { name: 'Thundercloud' } }, ctx).category;
  assert.equal(applyOp(doc, { type: 'addCategory', category: { name: 'admin' } }, ctx).skipped, 'duplicate');
  applyOp(doc, { type: 'moveCategory', id: tc.id, index: 0 }, ctx);
  assert.deepEqual(doc.categories.map((c) => c.name), ['Thundercloud', 'Admin']);
  applyOp(doc, { type: 'renameCategory', id: admin.id, name: 'Life admin' }, ctx);
  assert.equal(findCategory(doc, 'thunder cloud').id, tc.id);
  assert.equal(findCategory(doc, 'Thundercloud DPQ').id, tc.id);
  assert.equal(findCategory(doc, 'Nope'), null);
  const t = applyOp(doc, { type: 'add', task: { title: 'Ship it', categoryName: 'Thundercloud', tags: ['#Work'] } }, ctx).task;
  assert.equal(t.category, tc.id);
  assert.deepEqual(t.tags, ['work']);
});

test('deleting a category moves or deletes its tasks and can be undone', () => {
  const doc = emptyDoc();
  const a = applyOp(doc, { type: 'addCategory', category: { name: 'A' } }, ctx).category;
  const b = applyOp(doc, { type: 'addCategory', category: { name: 'B' } }, ctx).category;
  applyOp(doc, { type: 'add', task: { title: 'one', category: a.id } }, ctx);
  applyOp(doc, { type: 'add', task: { title: 'two', category: a.id, source: 'linear:X-1' } }, ctx);
  const snapshot = { category: structuredClone(a), index: 0, tasks: structuredClone(doc.tasks) };

  applyOp(doc, { type: 'deleteCategory', id: a.id, moveTo: b.id }, ctx);
  assert.deepEqual(doc.tasks.map((t) => t.category), [b.id, b.id]);

  applyOp(doc, { type: 'restoreCategory', ...snapshot }, ctx);
  assert.deepEqual(doc.categories.map((c) => c.name), ['A', 'B']);
  assert.deepEqual(doc.tasks.map((t) => t.category), [a.id, a.id]);

  applyOp(doc, { type: 'deleteCategory', id: a.id, deleteTasks: true }, ctx);
  assert.equal(doc.tasks.length, 0);
  assert.ok(doc.removed['linear:X-1']);
  applyOp(doc, { type: 'restoreCategory', ...snapshot }, ctx);
  assert.equal(doc.tasks.length, 2);
  assert.equal(doc.removed['linear:X-1'], undefined);
});

test('normalizeDoc upgrades version 1 files', () => {
  const doc = normalizeDoc({ version: 1, tasks: [{ id: 't1', title: 'x', status: 'open' }, { id: 't2', title: 'y', status: 'suggested' }] });
  assert.equal(doc.version, 2);
  assert.deepEqual(doc.categories, []);
  assert.deepEqual(doc.tasks.map((t) => [t.id, t.category, t.tags]), [['t1', null, []]]);
});

test('tasks can be targeted by source key', () => {
  const doc = emptyDoc();
  applyOp(doc, { type: 'add', task: { title: 'Fix login', source: { key: 'linear:ABC-1', url: 'https://linear.app/x' } } }, ctx);
  applyOp(doc, { type: 'complete', source: 'linear:ABC-1' }, ctx);
  assert.equal(doc.tasks[0].status, 'done');
});

test('agenda groups tasks by when they are due', () => {
  const doc = emptyDoc();
  const add = (task) => applyOp(doc, { type: 'add', task }, ctx).task;
  add({ title: 'late', due: '2026-09-20' });
  add({ title: 'now', due: '2026-09-24' });
  add({ title: 'soon', due: '2026-09-28' });
  add({ title: 'far', due: '2026-12-01' });
  add({ title: 'whenever' });
  const done = add({ title: 'finished' });
  applyOp(doc, { type: 'complete', id: done.id }, ctx);
  const groups = agenda(doc, '2026-09-24', { timeZone: 'UTC' });
  const titles = (key) => groups[key].map((t) => t.title);
  assert.deepEqual(titles('overdue'), ['late']);
  assert.deepEqual(titles('today'), ['now']);
  assert.deepEqual(titles('upcoming'), ['soon']);
  assert.deepEqual(titles('later'), ['far']);
  assert.deepEqual(titles('someday'), ['whenever']);
  assert.deepEqual(titles('doneToday'), ['finished']);
});
