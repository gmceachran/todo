import { addDays, applyOp, emptyDoc, localToday, normalizeDoc, weekday } from './core.js';

const KEY = 'todo.demo.remote';

function seed() {
  const today = localToday();
  const doc = emptyDoc();
  const run = (op) => applyOp(doc, op, { today });
  const category = (name) => run({ type: 'addCategory', category: { name } }).category.id;
  const admin = category('Admin');
  const work = category('Thundercloud');
  const growth = category('Professional development');
  const home = category('Personal');
  const [y, m] = today.split('-').map(Number);
  const firstOfNextMonth = new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 10);
  const add = (task) => run({ type: 'add', task });

  add({ title: 'Send invoice to Acme', category: admin, due: addDays(today, -2), tags: ['finance'], source: { key: 'gmail:demo1', label: 'Email', url: 'https://mail.google.com/' } });
  add({ title: 'Pay rent', category: admin, due: firstOfNextMonth, repeat: 'every month on the 1st' });
  add({ title: 'Submit expense report', category: admin, due: addDays(today, 3), tags: ['finance'] });
  add({ title: 'Renew passport', category: admin, tags: ['errand'] });
  add({ title: 'Fix login redirect loop', category: work, due: today, tags: ['deep-work'], source: { key: 'linear:RM-12', label: 'RM-12', url: 'https://linear.app/' } });
  add({ title: 'Review dock quote PR', category: work, due: addDays(today, 4), source: { key: 'linear:RM-14', label: 'RM-14', url: 'https://linear.app/' } });
  add({ title: 'Write migration plan for pricing tables', category: work, tags: ['deep-work'] });
  add({ title: 'Read for 30 minutes', category: growth, due: today, repeat: 'weekdays' });
  add({ title: 'Rails course, chapter 4', category: growth, due: addDays(today, 1) });
  add({ title: 'Outline lunch & learn talk', category: growth, due: addDays(today, 9), tags: ['writing'] });
  add({ title: 'Groceries', category: home, due: today, tags: ['errand'] });
  add({ title: 'Call mom', category: home, due: addDays(today, (7 - weekday(today)) % 7 || 7), repeat: 'every sunday' });
  add({ title: 'Book dentist appointment', category: home, due: addDays(today, 6) });
  const done = add({ title: 'Reply to landlord', category: admin }).task;
  run({ type: 'complete', id: done.id });
  return doc;
}

export function createDemoStore() {
  return {
    async check() {
      return {};
    },
    async load() {
      const saved = sessionStorage.getItem(KEY);
      return { doc: normalizeDoc(saved ? JSON.parse(saved) : seed()), sha: 'demo' };
    },
    async save(doc) {
      sessionStorage.setItem(KEY, JSON.stringify(doc));
      return 'demo';
    },
  };
}
