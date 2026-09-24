export const SCHEMA_VERSION = 2;
export const STATUSES = ['open', 'done'];
export const UNITS = ['day', 'week', 'month', 'year'];
export const WEEKDAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const DAY_MS = 86400000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function emptyDoc() {
  return { version: SCHEMA_VERSION, categories: [], tasks: [], suggested: {}, removed: {} };
}

// region dates

export function localToday(timeZone) {
  return localDateOf(new Date(), timeZone);
}

export function localDateOf(date, timeZone) {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(
    new Date(date)
  );
}

export function isDate(value) {
  if (typeof value !== 'string' || !DATE_RE.test(value)) return false;
  return formatDate(parseDate(value)) === value;
}

function parseDate(value) {
  const [y, m, d] = value.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

function formatDate(date) {
  return date.toISOString().slice(0, 10);
}

export function addDays(value, days) {
  return formatDate(new Date(parseDate(value).getTime() + days * DAY_MS));
}

export function daysBetween(from, to) {
  return Math.round((parseDate(to) - parseDate(from)) / DAY_MS);
}

export function weekday(value) {
  return parseDate(value).getUTCDay();
}

function daysInMonth(year, month) {
  return new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
}

function addMonths(value, months, anchorDay) {
  const date = parseDate(value);
  const total = date.getUTCMonth() + months;
  const year = date.getUTCFullYear() + Math.floor(total / 12);
  const month = ((total % 12) + 12) % 12;
  const day = Math.min(anchorDay || date.getUTCDate(), daysInMonth(year, month));
  return formatDate(new Date(Date.UTC(year, month, day)));
}

// region repeat

export function normalizeRepeat(repeat, due) {
  if (typeof repeat === 'string') repeat = parseRepeat(repeat);
  if (!repeat) return null;
  const unit = repeat.unit;
  if (!UNITS.includes(unit)) throw new Error(`Unknown repeat unit "${unit}"`);
  const every = Math.max(1, Math.floor(Number(repeat.every) || 1));
  const result = { every, unit };
  if (unit === 'week' && Array.isArray(repeat.weekdays) && repeat.weekdays.length) {
    const days = [...new Set(repeat.weekdays.map(Number))].filter((d) => d >= 0 && d <= 6).sort();
    if (days.length) result.weekdays = days;
  }
  if (unit === 'month' || unit === 'year') {
    const day = Number(repeat.day) || (due && isDate(due) ? parseDate(due).getUTCDate() : 0);
    if (day >= 1 && day <= 31) result.day = day;
  }
  return result;
}

export function nextOccurrence(value, repeat) {
  const every = repeat.every || 1;
  switch (repeat.unit) {
    case 'day':
      return addDays(value, every);
    case 'week': {
      if (!repeat.weekdays?.length) return addDays(value, 7 * every);
      const days = new Set(repeat.weekdays);
      const weekStart = (d) => addDays(d, -weekday(d));
      const base = weekStart(value);
      for (let i = 1; i <= 7 * (every + 1); i++) {
        const candidate = addDays(value, i);
        const weeksApart = daysBetween(base, weekStart(candidate)) / 7;
        if (days.has(weekday(candidate)) && weeksApart % every === 0) return candidate;
      }
      return addDays(value, 7 * every);
    }
    case 'month':
      return addMonths(value, every, repeat.day);
    case 'year':
      return addMonths(value, 12 * every, repeat.day);
    default:
      throw new Error(`Unknown repeat unit "${repeat.unit}"`);
  }
}

const WEEKDAY_LOOKUP = {
  su: 0, sun: 0, sunday: 0,
  m: 1, mo: 1, mon: 1, monday: 1,
  tu: 2, tue: 2, tues: 2, tuesday: 2,
  w: 3, we: 3, wed: 3, wednesday: 3,
  th: 4, thu: 4, thur: 4, thurs: 4, thursday: 4,
  f: 5, fr: 5, fri: 5, friday: 5,
  sa: 6, sat: 6, saturday: 6,
};

function parseWeekdays(text) {
  const days = text
    .split(/[\s,/&]+|\band\b/)
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean)
    .map((part) => WEEKDAY_LOOKUP[part]);
  if (!days.length || days.some((d) => d === undefined)) return null;
  return days;
}

export function parseRepeat(input) {
  if (input == null) return null;
  if (typeof input === 'object') return normalizeRepeat(input);
  const text = String(input).trim().toLowerCase();
  if (!text || ['none', 'never', 'no', 'off'].includes(text)) return null;
  if (text.startsWith('{')) return normalizeRepeat(JSON.parse(text));

  const presets = {
    daily: { every: 1, unit: 'day' },
    'every day': { every: 1, unit: 'day' },
    weekdays: { every: 1, unit: 'week', weekdays: [1, 2, 3, 4, 5] },
    'every weekday': { every: 1, unit: 'week', weekdays: [1, 2, 3, 4, 5] },
    weekends: { every: 1, unit: 'week', weekdays: [0, 6] },
    weekly: { every: 1, unit: 'week' },
    biweekly: { every: 2, unit: 'week' },
    fortnightly: { every: 2, unit: 'week' },
    monthly: { every: 1, unit: 'month' },
    quarterly: { every: 3, unit: 'month' },
    yearly: { every: 1, unit: 'year' },
    annually: { every: 1, unit: 'year' },
  };
  if (presets[text]) return normalizeRepeat(presets[text]);

  const interval = text.match(/^every\s+(?:(\d+|other)\s+)?(day|week|month|year)s?(?:\s+on\s+(.+))?$/);
  if (interval) {
    const every = interval[1] === 'other' ? 2 : Number(interval[1] || 1);
    const repeat = { every, unit: interval[2] };
    if (interval[3]) {
      if (repeat.unit === 'week') {
        repeat.weekdays = parseWeekdays(interval[3]);
        if (!repeat.weekdays) throw new Error(`Couldn't read weekdays in "${input}"`);
      } else {
        const day = interval[3].match(/(\d{1,2})/);
        if (!day) throw new Error(`Couldn't read day of month in "${input}"`);
        repeat.day = Number(day[1]);
      }
    }
    return normalizeRepeat(repeat);
  }

  const named = text.match(/^(?:every|weekly on|on)\s+(.+)$/);
  if (named) {
    const weekdays = parseWeekdays(named[1]);
    if (weekdays) return normalizeRepeat({ every: 1, unit: 'week', weekdays });
  }

  throw new Error(`Couldn't understand repeat "${input}"`);
}

function ordinal(n) {
  const suffix = n % 100 >= 11 && n % 100 <= 13 ? 'th' : { 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] || 'th';
  return `${n}${suffix}`;
}

export function describeRepeat(repeat) {
  if (!repeat) return '';
  const { every, unit, weekdays, day } = repeat;
  if (unit === 'week' && weekdays?.length) {
    const key = weekdays.join(',');
    const prefix = every === 1 ? '' : `Every ${every} weeks on `;
    if (every === 1 && key === '1,2,3,4,5') return 'Weekdays';
    if (every === 1 && key === '0,6') return 'Weekends';
    const names = weekdays.map((d) => WEEKDAY_NAMES[d]).join(', ');
    return every === 1 ? `Every ${names}` : `${prefix}${names}`;
  }
  const base =
    every === 1
      ? { day: 'Daily', week: 'Weekly', month: 'Monthly', year: 'Yearly' }[unit]
      : `Every ${every} ${unit}s`;
  if (unit === 'month' && day) return `${base} on the ${ordinal(day)}`;
  return base;
}

// region tasks

export function makeId(prefix = 't') {
  const rand = Math.random().toString(36).slice(2, 8);
  return `${prefix}_${Date.now().toString(36)}${rand}`;
}

function cleanText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeSource(source) {
  if (!source) return null;
  if (typeof source === 'string') source = { key: source };
  const key = cleanText(source.key);
  if (!key) return null;
  const result = { key };
  if (/^https?:\/\//i.test(cleanText(source.url))) result.url = cleanText(source.url);
  if (cleanText(source.label)) result.label = cleanText(source.label);
  return result;
}

function normalizeDue(due) {
  if (due == null || due === '' || due === 'none') return null;
  if (!isDate(due)) throw new Error(`Invalid due date "${due}" (use YYYY-MM-DD)`);
  return due;
}

export function normalizeTags(tags) {
  const list = Array.isArray(tags) ? tags : typeof tags === 'string' ? tags.split(/[,\s]+/) : [];
  const clean = list
    .map((tag) =>
      String(tag)
        .trim()
        .replace(/^#/, '')
        .toLowerCase()
        .replace(/\s+/g, '-')
        .replace(/[^\w-]/g, '')
    )
    .filter(Boolean);
  return [...new Set(clean)];
}

export function normalizeDoc(doc) {
  const result = doc && typeof doc === 'object' ? doc : emptyDoc();
  result.version = SCHEMA_VERSION;
  if (!Array.isArray(result.categories)) result.categories = [];
  if (!Array.isArray(result.tasks)) result.tasks = [];
  if (!result.suggested || typeof result.suggested !== 'object') result.suggested = {};
  if (!result.removed || typeof result.removed !== 'object') result.removed = {};
  result.tasks = result.tasks.filter((t) => STATUSES.includes(t.status));
  for (const task of result.tasks) {
    if (!Array.isArray(task.tags)) task.tags = [];
    if (task.category === undefined) task.category = null;
  }
  return result;
}

export function findBySource(doc, key) {
  return doc.tasks.find((t) => t.source?.key === key) || null;
}

export function findTask(doc, ref) {
  if (!ref) return null;
  if (ref.id) return doc.tasks.find((t) => t.id === ref.id) || null;
  if (ref.source) return findBySource(doc, typeof ref.source === 'string' ? ref.source : ref.source.key);
  return null;
}

export function findCategory(doc, ref) {
  if (!ref) return null;
  const byId = doc.categories.find((c) => c.id === ref);
  if (byId) return byId;
  const name = String(ref).trim().toLowerCase();
  if (!name) return null;
  const simple = (text) => text.toLowerCase().replace(/[^a-z0-9]/g, '');
  return (
    doc.categories.find((c) => c.name.toLowerCase() === name) ||
    doc.categories.find((c) => simple(c.name) === simple(name)) ||
    doc.categories.find((c) => simple(name).includes(simple(c.name)) || simple(c.name).includes(simple(name))) ||
    null
  );
}

function resolveCategory(doc, input) {
  if (input.category === null) return null;
  return findCategory(doc, input.category ?? input.categoryName)?.id ?? null;
}

function applyCategoryOp(doc, op, now) {
  switch (op.type) {
    case 'addCategory': {
      const input = op.category || {};
      if (input.id && doc.categories.some((c) => c.id === input.id)) return { skipped: 'exists' };
      const name = cleanText(input.name);
      if (!name) throw new Error('A category needs a name');
      const existing = doc.categories.find((c) => c.name.toLowerCase() === name.toLowerCase());
      if (existing) return { skipped: 'duplicate', category: existing };
      const category = { id: input.id || makeId('c'), name, created: now };
      doc.categories.push(category);
      return { category };
    }
    case 'renameCategory': {
      const category = doc.categories.find((c) => c.id === op.id);
      if (!category) return { skipped: 'missing' };
      const name = cleanText(op.name);
      if (!name) throw new Error('A category needs a name');
      category.name = name;
      return { category };
    }
    case 'moveCategory': {
      const from = doc.categories.findIndex((c) => c.id === op.id);
      if (from === -1) return { skipped: 'missing' };
      const [category] = doc.categories.splice(from, 1);
      const to = Math.max(0, Math.min(doc.categories.length, Number(op.index) || 0));
      doc.categories.splice(to, 0, category);
      return { category };
    }
    case 'deleteCategory': {
      const index = doc.categories.findIndex((c) => c.id === op.id);
      if (index === -1) return { skipped: 'missing' };
      const [category] = doc.categories.splice(index, 1);
      const moveTo = op.moveTo && doc.categories.some((c) => c.id === op.moveTo) ? op.moveTo : null;
      const affected = doc.tasks.filter((t) => t.category === category.id);
      if (op.deleteTasks) {
        for (const task of affected) removeTask(doc, task, now);
      } else {
        for (const task of affected) {
          task.category = moveTo;
          task.updated = now;
        }
      }
      return { category, tasks: affected.length };
    }
    case 'restoreCategory': {
      if (!doc.categories.some((c) => c.id === op.category.id)) {
        doc.categories.splice(Math.min(op.index ?? doc.categories.length, doc.categories.length), 0, op.category);
      }
      for (const snapshot of op.tasks || []) {
        const at = doc.tasks.findIndex((t) => t.id === snapshot.id);
        if (at === -1) doc.tasks.push(snapshot);
        else doc.tasks[at] = snapshot;
        if (snapshot.source) delete doc.removed[snapshot.source.key];
      }
      return { category: op.category };
    }
    default:
      return null;
  }
}

function removeTask(doc, task, now) {
  doc.tasks.splice(doc.tasks.indexOf(task), 1);
  if (task.source) doc.removed[task.source.key] = now.slice(0, 10);
}

export function applyOp(doc, op, ctx = {}) {
  const now = op.at || ctx.now || new Date().toISOString();
  const today = op.today || ctx.today || localToday();

  const categoryResult = applyCategoryOp(doc, op, now);
  if (categoryResult) return categoryResult;

  if (op.type === 'markSuggested') {
    for (const key of op.keys || []) if (cleanText(key)) doc.suggested[cleanText(key)] = today;
    pruneLog(doc.suggested, today);
    return { marked: (op.keys || []).length };
  }

  if (op.type === 'add') {
    const input = op.task || {};
    if (input.id && doc.tasks.some((t) => t.id === input.id)) return { skipped: 'exists' };
    const source = normalizeSource(input.source);
    if (source) {
      const existing = findBySource(doc, source.key);
      if (existing) return { skipped: 'duplicate', task: existing };
      if (doc.removed[source.key] && !op.revive) return { skipped: 'removed' };
      delete doc.removed[source.key];
    }
    const title = cleanText(input.title);
    if (!title) throw new Error('A task needs a title');
    const status = input.status || 'open';
    if (!STATUSES.includes(status)) throw new Error(`Unknown status "${status}"`);
    let due = normalizeDue(input.due);
    const repeat = normalizeRepeat(input.repeat, due);
    if (repeat && !due) due = today;
    const task = {
      id: input.id || makeId(),
      title,
      status,
      category: resolveCategory(doc, input),
      tags: normalizeTags(input.tags),
      due,
      repeat,
      created: now,
      updated: now,
    };
    const notes = cleanText(input.notes);
    if (notes) task.notes = notes;
    if (source) task.source = source;
    if (input.addedBy) task.addedBy = input.addedBy;
    doc.tasks.push(task);
    return { task };
  }

  if (op.type === 'restore') {
    const index = doc.tasks.findIndex((t) => t.id === op.task.id);
    const task = { ...op.task, updated: now };
    if (index === -1) doc.tasks.push(task);
    else doc.tasks[index] = task;
    if (task.source) delete doc.removed[task.source.key];
    return { task };
  }

  const task = findTask(doc, op);
  if (!task) return { skipped: 'missing' };

  switch (op.type) {
    case 'update': {
      const patch = op.patch || {};
      if ('title' in patch) {
        const title = cleanText(patch.title);
        if (!title) throw new Error('A task needs a title');
        task.title = title;
      }
      if ('notes' in patch) {
        const notes = cleanText(patch.notes);
        if (notes) task.notes = notes;
        else delete task.notes;
      }
      if ('category' in patch || 'categoryName' in patch) task.category = resolveCategory(doc, patch);
      if ('tags' in patch) task.tags = normalizeTags(patch.tags);
      if ('due' in patch) task.due = normalizeDue(patch.due);
      if ('repeat' in patch) task.repeat = normalizeRepeat(patch.repeat, task.due);
      if (task.repeat && !task.due) task.due = today;
      if ('source' in patch) {
        const source = normalizeSource(patch.source);
        if (source) task.source = source;
        else delete task.source;
      }
      break;
    }
    case 'complete': {
      if (task.repeat) {
        if (op.due !== undefined && task.due !== op.due) return { skipped: 'stale', task };
        let next = task.due || today;
        do next = nextOccurrence(next, task.repeat);
        while (next <= today);
        task.prevDue = task.due;
        task.due = next;
        task.lastDone = now;
      } else {
        if (task.status === 'done') return { skipped: 'already', task };
        task.status = 'done';
        task.completed = now;
      }
      break;
    }
    case 'reopen': {
      if (task.repeat) {
        if (!task.lastDone) return { skipped: 'already', task };
        if (task.prevDue) task.due = task.prevDue;
        delete task.prevDue;
        delete task.lastDone;
      } else {
        task.status = 'open';
        delete task.completed;
      }
      break;
    }
    case 'delete':
      removeTask(doc, task, now);
      return { task, deleted: true };
    default:
      throw new Error(`Unknown operation "${op.type}"`);
  }
  task.updated = now;
  return { task };
}

export function applyOps(doc, ops, ctx) {
  return ops.map((op) => applyOp(doc, op, ctx));
}

export function describeOp(op, doc) {
  if (op.type.endsWith('Category')) {
    const name = op.category?.name || op.name || doc.categories?.find((c) => c.id === op.id)?.name || op.id;
    return `${op.type} "${name}"`;
  }
  if (op.type === 'markSuggested') return `markSuggested ${(op.keys || []).length}`;
  const task = op.task?.title ? op.task : findTask(doc, op);
  const title = task?.title ? `"${task.title}"` : op.id || op.source || '';
  return `${op.type} ${title}`.trim();
}

export function pruneLog(log, today, days = 120) {
  const cutoff = addDays(today, -days);
  for (const [key, date] of Object.entries(log)) if (date < cutoff) delete log[key];
  return log;
}

// region agenda

export function encodeImport(tasks) {
  const bytes = new TextEncoder().encode(JSON.stringify({ v: 1, tasks }));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function decodeImport(payload) {
  const base64 = payload.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(base64 + '='.repeat((4 - (base64.length % 4)) % 4));
  const data = JSON.parse(new TextDecoder().decode(Uint8Array.from(binary, (c) => c.charCodeAt(0))));
  if (data?.v !== 1 || !Array.isArray(data.tasks)) throw new Error('Unrecognized import link');
  return data.tasks
    .filter((t) => t && typeof t.title === 'string' && t.title.trim())
    .slice(0, 50)
    .map((t) => ({
      title: t.title,
      notes: typeof t.notes === 'string' ? t.notes : undefined,
      categoryName: typeof t.category === 'string' ? t.category : undefined,
      tags: Array.isArray(t.tags) ? t.tags : [],
      due: typeof t.due === 'string' && isDate(t.due) ? t.due : null,
      source: t.source && typeof t.source.key === 'string' ? t.source : undefined,
    }));
}

export function agenda(doc, today, { upcomingDays = 7, timeZone } = {}) {
  const horizon = addDays(today, upcomingDays);
  const groups = { overdue: [], today: [], upcoming: [], later: [], someday: [], doneToday: [] };
  for (const task of doc.tasks) {
    if (task.status === 'done') {
      if (task.completed && localDateOf(task.completed, timeZone) === today) groups.doneToday.push(task);
    } else if (task.status === 'open') {
      if (task.repeat && task.lastDone && localDateOf(task.lastDone, timeZone) === today) groups.doneToday.push(task);
      if (!task.due) groups.someday.push(task);
      else if (task.due < today) groups.overdue.push(task);
      else if (task.due === today) groups.today.push(task);
      else if (task.due <= horizon) groups.upcoming.push(task);
      else groups.later.push(task);
    }
  }
  const byDue = (a, b) => (a.due || '').localeCompare(b.due || '') || a.created.localeCompare(b.created);
  const byCreated = (a, b) => a.created.localeCompare(b.created);
  for (const key of ['overdue', 'today', 'upcoming', 'later']) groups[key].sort(byDue);
  groups.someday.sort(byCreated);
  return groups;
}
