(() => {
const SCHEMA_VERSION = 2;
const STATUSES = ['open', 'done'];
const UNITS = ['day', 'week', 'month', 'year'];
const WEEKDAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const DAY_MS = 86400000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function emptyDoc() {
  return { version: SCHEMA_VERSION, categories: [], tasks: [], suggested: {}, removed: {} };
}

// region dates

function localToday(timeZone) {
  return localDateOf(new Date(), timeZone);
}

function localDateOf(date, timeZone) {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(
    new Date(date)
  );
}

function isDate(value) {
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

function addDays(value, days) {
  return formatDate(new Date(parseDate(value).getTime() + days * DAY_MS));
}

function daysBetween(from, to) {
  return Math.round((parseDate(to) - parseDate(from)) / DAY_MS);
}

function weekday(value) {
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

function normalizeRepeat(repeat, due) {
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

function nextOccurrence(value, repeat) {
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

function parseRepeat(input) {
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

function describeRepeat(repeat) {
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

function makeId(prefix = 't') {
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

function normalizeTags(tags) {
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

function normalizeDoc(doc) {
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

function findBySource(doc, key) {
  return doc.tasks.find((t) => t.source?.key === key) || null;
}

function findTask(doc, ref) {
  if (!ref) return null;
  if (ref.id) return doc.tasks.find((t) => t.id === ref.id) || null;
  if (ref.source) return findBySource(doc, typeof ref.source === 'string' ? ref.source : ref.source.key);
  return null;
}

function findCategory(doc, ref) {
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

function applyOp(doc, op, ctx = {}) {
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

function applyOps(doc, ops, ctx) {
  return ops.map((op) => applyOp(doc, op, ctx));
}

function describeOp(op, doc) {
  if (op.type.endsWith('Category')) {
    const name = op.category?.name || op.name || doc.categories?.find((c) => c.id === op.id)?.name || op.id;
    return `${op.type} "${name}"`;
  }
  if (op.type === 'markSuggested') return `markSuggested ${(op.keys || []).length}`;
  const task = op.task?.title ? op.task : findTask(doc, op);
  const title = task?.title ? `"${task.title}"` : op.id || op.source || '';
  return `${op.type} ${title}`.trim();
}

function pruneLog(log, today, days = 120) {
  const cutoff = addDays(today, -days);
  for (const [key, date] of Object.entries(log)) if (date < cutoff) delete log[key];
  return log;
}

// region agenda

function encodeImport(tasks) {
  const bytes = new TextEncoder().encode(JSON.stringify({ v: 1, tasks }));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function decodeImport(payload) {
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

function agenda(doc, today, { upcomingDays = 7, timeZone } = {}) {
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

class ConflictError extends Error {}

class AuthError extends Error {}

function encodeBase64(text) {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

function decodeBase64(base64) {
  const binary = atob(base64.replace(/\s/g, ''));
  return new TextDecoder().decode(Uint8Array.from(binary, (c) => c.charCodeAt(0)));
}

function parseRepo(value) {
  const match = String(value || '').trim().match(/^([\w.-]+)\/([\w.-]+)$/);
  if (!match) throw new Error(`Repository should look like "owner/name", got "${value}"`);
  return { owner: match[1], repo: match[2] };
}

class GitHubStore {
  constructor({ repo, token, path = 'tasks.json', branch = 'main', fetch: fetchImpl }) {
    const { owner, repo: name } = parseRepo(repo);
    this.repoUrl = `https://api.github.com/repos/${owner}/${name}`;
    this.url = `${this.repoUrl}/contents/${path}`;
    this.token = token;
    this.branch = branch;
    this.fetch = fetchImpl || globalThis.fetch.bind(globalThis);
  }

  headers() {
    return {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${this.token}`,
      'X-GitHub-Api-Version': '2022-11-28',
    };
  }

  async fail(res) {
    const body = await res.json().catch(() => ({}));
    const message = body.message || res.statusText;
    if (res.status === 401 || res.status === 403) throw new AuthError(`GitHub refused access: ${message}`);
    throw new Error(`GitHub ${res.status}: ${message}`);
  }

  async check() {
    const res = await this.fetch(this.repoUrl, { headers: this.headers(), cache: 'no-store' });
    if (res.status === 404) throw new AuthError('GitHub could not find that repo with this token');
    if (!res.ok) await this.fail(res);
    const repo = await res.json();
    if (repo.permissions && !repo.permissions.push) throw new AuthError('This token can read the repo but not write to it');
    return repo;
  }

  async load() {
    const res = await this.fetch(`${this.url}?ref=${encodeURIComponent(this.branch)}`, {
      headers: this.headers(),
      cache: 'no-store',
    });
    if (res.status === 404) return { doc: emptyDoc(), sha: null };
    if (!res.ok) await this.fail(res);
    const body = await res.json();
    const doc = normalizeDoc(JSON.parse(decodeBase64(body.content)));
    return { doc, sha: body.sha };
  }

  async readText(path) {
    const url = `${this.repoUrl}/contents/${path.split('/').map(encodeURIComponent).join('/')}`;
    const res = await this.fetch(`${url}?ref=${encodeURIComponent(this.branch)}`, {
      headers: { ...this.headers(), Accept: 'application/vnd.github.raw' },
      cache: 'no-store',
    });
    if (res.status === 404) return null;
    if (!res.ok) await this.fail(res);
    return res.text();
  }

  async save(doc, sha, message) {
    const body = {
      message,
      branch: this.branch,
      content: encodeBase64(`${JSON.stringify(doc, null, 2)}\n`),
    };
    if (sha) body.sha = sha;
    const res = await this.fetch(this.url, {
      method: 'PUT',
      headers: { ...this.headers(), 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (res.status === 409 || res.status === 422) throw new ConflictError('tasks.json changed underneath us');
    if (!res.ok) await this.fail(res);
    return (await res.json()).content.sha;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function commitMessage(ops, doc, author = 'app') {
  const lines = ops.map((op) => describeOp(op, doc));
  const head = lines.length === 1 ? lines[0] : `${lines.length} changes`;
  return `${author}: ${head}${lines.length > 1 ? `\n\n${lines.join('\n')}` : ''}`;
}

async function commitOps(store, ops, { ctx, author, base, attempts = 5 } = {}) {
  let current = base;
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (!current) current = await store.load();
    const doc = structuredClone(current.doc);
    const message = commitMessage(ops, current.doc, author);
    const results = applyOps(doc, ops, ctx);
    if (results.every((r) => r.skipped)) return { doc: current.doc, sha: current.sha, results };
    try {
      const sha = await store.save(doc, current.sha, message);
      return { doc, sha, results };
    } catch (error) {
      if (!(error instanceof ConflictError)) throw error;
      current = null;
      await sleep(400 * (attempt + 1));
    }
  }
  throw new ConflictError('Gave up after repeated conflicts');
}

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

function createDemoStore() {
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

const demoStore = createDemoStore();

const DEMO = true;
const PREFIX = DEMO ? 'todo.demo.' : 'todo.';
const KEYS = Object.fromEntries(['config', 'cache', 'pending', 'ui', 'inbox'].map((key) => [key, `${PREFIX}${key}`]));
const UNCATEGORIZED = 'none';
const POLL_MS = 60000;

const storage = {
  get(key, fallback) {
    try {
      const value = localStorage.getItem(key);
      return value ? JSON.parse(value) : fallback;
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {}
  },
  remove(key) {
    try {
      localStorage.removeItem(key);
    } catch {}
  },
};

const savedUi = storage.get(KEYS.ui, {});

const state = {
  config: DEMO ? { repo: 'demo/demo', demo: true } : storage.get(KEYS.config, null),
  remote: storage.get(KEYS.cache, null),
  pending: storage.get(KEYS.pending, []),
  doc: emptyDoc(),
  sync: 'idle',
  syncMessage: '',
  lastSynced: null,
  flushing: false,
  loading: false,
  stale: false,
};

const ui = {
  filter: 'all',
  tag: '',
  activeCategory: savedUi.activeCategory ?? null,
  showDone: new Set(),
  creatingIn: null,
  addingCategory: false,
  renamingId: null,
  editingId: null,
  menuCategoryId: null,
  deletingId: null,
  undo: null,
};

let today = localToday();

// region helpers

const $ = (selector) => document.querySelector(selector);

function h(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value == null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else if (value === true) node.setAttribute(key, '');
    else node.setAttribute(key, value);
  }
  for (const child of children.flat()) {
    if (child == null || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(child));
  }
  return node;
}

const icon = (name) =>
  h('i', { class: `ph ph-${name} icon`, 'aria-hidden': 'true' });

const shortDate = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
const weekdayName = new Intl.DateTimeFormat('en-US', { weekday: 'short', timeZone: 'UTC' });
const clock = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit' });
const utc = (d) => new Date(`${d}T00:00:00Z`);

function dueInfo(due) {
  if (!due) return null;
  const diff = daysBetween(today, due);
  if (diff < 0) return { label: diff === -1 ? 'Yesterday' : `${-diff}d overdue`, state: 'overdue' };
  if (diff === 0) return { label: 'Today', state: 'today' };
  if (diff === 1) return { label: 'Tomorrow', state: '' };
  if (diff < 7) return { label: weekdayName.format(utc(due)), state: '' };
  return { label: shortDate.format(utc(due)), state: '' };
}

function matchesFilter(t) {
  if (ui.tag && !t.tags.includes(ui.tag)) return false;
  if (ui.filter === 'all') return true;
  if (!t.due) return false;
  if (ui.filter === 'overdue') return t.due < today;
  if (ui.filter === 'today') return t.due <= today;
  if (ui.filter === 'week') return t.due <= addDays(today, (7 - weekday(today)) % 7);
  return true;
}

function sortCards(a, b) {
  if (a.due && b.due) return a.due.localeCompare(b.due) || a.created.localeCompare(b.created);
  if (a.due) return -1;
  if (b.due) return 1;
  return a.created.localeCompare(b.created);
}

function doneToday(t) {
  if (t.status === 'done') return Boolean(t.completed) && localDateOf(t.completed) === today;
  return Boolean(t.repeat && t.lastDone) && localDateOf(t.lastDone) === today;
}

function parseTitle(text) {
  const tags = [...text.matchAll(/#([\w-]+)/g)].map((m) => m[1].toLowerCase());
  const title = text.replace(/#[\w-]+/g, '').replace(/\s+/g, ' ').trim();
  return { title, tags };
}

const TAG_STOPS = [0, 33, 67, 100];
const tagMix = (tag) =>
  TAG_STOPS[([...tag].reduce((hash, c) => ((hash << 5) + hash + c.charCodeAt(0)) >>> 0, 5381) >>> 3) % TAG_STOPS.length];

const URL_PATTERN = /https?:\/\/[^\s<>"']+/g;

function noteLinks(notes = '') {
  const links = [];
  for (const line of notes.split('\n')) {
    for (const match of line.matchAll(URL_PATTERN)) {
      let host;
      try {
        host = new URL(match[0]).hostname.replace(/^www\./, '');
      } catch {
        continue;
      }
      const label = line.slice(0, match.index).replace(/[\s:–-]+$/, '').trim();
      links.push({ url: match[0], label: label || host, host });
    }
  }
  return links;
}

const SOURCE_ICONS = { linear: 'triangle', slack: 'hash', gmail: 'envelope-simple' };
const sourceIcon = (key) => SOURCE_ICONS[key.split(':')[0]] ?? 'link';

const tasks = () => state.doc.tasks;
const categories = () => state.doc.categories;
const columnOf = (task) => (categories().some((c) => c.id === task.category) ? task.category : UNCATEGORIZED);
const categoryName = (id) => categories().find((c) => c.id === id)?.name ?? 'Uncategorized';
const findTaskById = (id) => tasks().find((t) => t.id === id);

function isoWeek(date) {
  const d = utc(date);
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = Date.UTC(d.getUTCFullYear(), 0, 1);
  return Math.ceil(((d - yearStart) / 86400000 + 1) / 7);
}

function counts() {
  const open = tasks().filter((t) => t.status === 'open');
  return {
    due: open.filter((t) => t.due === today).length,
    overdue: open.filter((t) => t.due && t.due < today).length,
  };
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
// region sync

let storeInstance = null;
function store() {
  if (!state.config) return null;
  storeInstance ??= state.config.demo ? demoStore : new GitHubStore(state.config);
  return storeInstance;
}

function persist() {
  storage.set(KEYS.cache, state.remote);
  storage.set(KEYS.pending, state.pending);
}

function computeView() {
  const doc = normalizeDoc(structuredClone(state.remote?.doc ?? emptyDoc()));
  for (const op of state.pending) {
    try {
      applyOp(doc, op);
    } catch {}
  }
  state.doc = doc;
}

function setSync(sync, message = '') {
  state.sync = sync;
  state.syncMessage = message;
  renderSync();
}

function handleSyncError(error) {
  if (error instanceof AuthError) setSync('error', 'Reconnect');
  else if (error instanceof TypeError || !navigator.onLine) setSync('offline');
  else setSync('error', 'Sync failed');
  console.error(error);
}

function dispatch(ops) {
  const stamped = ops.map((op) => ({ ...op, at: new Date().toISOString(), today }));
  const preview = structuredClone(state.doc);
  let results;
  try {
    results = stamped.map((op) => applyOp(preview, op));
  } catch (error) {
    toast(error.message);
    return null;
  }
  state.pending.push(...stamped);
  persist();
  computeView();
  render();
  flush();
  return results;
}

async function flush() {
  if (state.flushing || !state.pending.length || !store()) return;
  if (!navigator.onLine) return setSync('offline');
  state.flushing = true;
  setSync('saving');
  const batch = state.pending.slice();
  try {
    const result = await commitOps(store(), batch, { author: 'app', base: state.remote ?? undefined });
    state.remote = { doc: result.doc, sha: result.sha };
    state.pending = state.pending.slice(batch.length);
    state.lastSynced = new Date();
    persist();
    setSync('idle');
  } catch (error) {
    handleSyncError(error);
  } finally {
    state.flushing = false;
    computeView();
    safeRender();
    if (state.pending.length && state.sync === 'idle') flush();
  }
}

async function refresh() {
  if (!store() || state.loading) return;
  if (state.pending.length) return flush();
  state.loading = true;
  if (!state.remote) setSync('loading');
  try {
    state.remote = await store().load();
    state.lastSynced = new Date();
    persist();
    if (!state.pending.length) setSync('idle');
  } catch (error) {
    handleSyncError(error);
  } finally {
    state.loading = false;
    computeView();
    safeRender();
  }
}

function isEditing() {
  const active = document.activeElement;
  const typing = active?.closest?.('.board') && active.matches('input') && active.value.trim() !== '';
  return Boolean(ui.editingId || ui.creatingIn || ui.deletingId || ui.renamingId || typing);
}

function safeRender() {
  if (isEditing()) state.stale = true;
  else render();
}

// region render

function renderSync() {
  const button = $('#sync-status');
  const labels = {
    idle: 'Synced',
    saving: 'Saving',
    loading: 'Loading',
    offline: state.pending.length ? `Offline · ${state.pending.length} pending` : 'Offline',
    error: state.syncMessage || 'Sync failed',
  };
  button.dataset.state = state.sync;
  $('#sync-label').textContent = store() ? labels[state.sync] : 'Not connected';
  button.title =
    state.sync === 'idle' && state.lastSynced ? `Synced at ${clock.format(state.lastSynced)}. Click to refresh.` : 'Sync now';
}

function renderHeader() {
  $('#dateline').textContent = [
    new Intl.DateTimeFormat('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' }).format(utc(today)),
    `Week ${isoWeek(today)}`,
    today.slice(0, 4),
  ].join(' · ');
  document.title = `${counts().due ? `(${counts().due}) ` : ''}Todo`;
  renderTagMenu();
}

const tagDot = (tag) =>
  h('span', { class: `tag-dot${tag ? '' : ' tag-dot--none'}`, style: tag ? `--td-tag-mix: ${tagMix(tag)}%` : null });

function renderTagMenu() {
  const open = tasks().filter((t) => t.status === 'open');
  const tagCounts = new Map();
  for (const t of open) for (const tag of t.tags) tagCounts.set(tag, (tagCounts.get(tag) || 0) + 1);
  const allTags = [...new Set(tasks().flatMap((t) => t.tags))].sort(
    (a, b) => tagMix(b) - tagMix(a) || a.localeCompare(b)
  );
  if (ui.tag && !allTags.includes(ui.tag)) ui.tag = '';

  const option = (tag, name, count) =>
    h(
      'button',
      {
        class: 'tag-menu__option',
        type: 'button',
        role: 'option',
        'aria-selected': String(ui.tag === tag),
        dataset: { tag },
        onclick: () => {
          ui.tag = tag;
          $('#tag-menu-list').hidePopover();
          render();
          $('#tag-menu-button').focus();
        },
      },
      tagDot(tag),
      h('span', { class: 'tag-menu__name' }, name),
      h('span', { class: 'tag-menu__count' }, String(count)),
      h('span', { class: 'tag-menu__check' }, ui.tag === tag ? icon('check') : null)
    );

  $('#tag-menu-list').replaceChildren(
    h('p', { class: 'tag-menu__heading label' }, 'Filter by tag'),
    option('', 'All tags', open.length),
    allTags.length ? h('div', { class: 'tag-menu__divider', role: 'separator' }) : null,
    ...allTags.map((tag) => option(tag, tag, tagCounts.get(tag) || 0))
  );
  $('#tag-menu-label').textContent = ui.tag || 'Tags';
  $('#tag-menu-icon').replaceChildren(ui.tag ? tagDot(ui.tag) : icon('tag'));
}

function columns() {
  const list = categories().map((c) => ({ id: c.id, name: c.name, category: c }));
  const loose = tasks().some((t) => columnOf(t) === UNCATEGORIZED && (t.status === 'open' || doneToday(t)));
  if (loose) list.unshift({ id: UNCATEGORIZED, name: 'Uncategorized', category: null });
  return list;
}

function renderTabs(list) {
  $('#category-tabs').replaceChildren(
    ...list.map((c) =>
      h(
        'button',
        {
          type: 'button',
          class: `category-tabs__tab${c.id === ui.activeCategory ? ' category-tabs__tab--active' : ''}`,
          onclick: () => {
            ui.activeCategory = c.id;
            storage.set(KEYS.ui, { activeCategory: c.id });
            render();
          },
        },
        c.name,
        h(
          'span',
          { class: 'category-tabs__count' },
          String(tasks().filter((t) => columnOf(t) === c.id && t.status === 'open').length)
        )
      )
    )
  );
}

function renderCard(t, { done = false } = {}) {
  const due = dueInfo(t.due);
  const linkCount = noteLinks(t.notes).length;
  const meta = h(
    'div',
    { class: 'task-card__meta' },
    t.tags.map((tag) =>
      h('span', { class: 'task-card__meta-item task-card__tag', style: `--td-tag-mix: ${tagMix(tag)}%` }, tag)
    ),
    due &&
      h(
        'span',
        { class: `task-card__meta-item${due.state ? ` task-card__meta-item--${due.state}` : ''}` },
        icon('calendar-blank'),
        due.label
      ),
    t.repeat && h('span', { class: 'task-card__meta-item' }, icon('repeat'), describeRepeat(t.repeat)),
    linkCount > 0 &&
      h(
        'span',
        { class: 'task-card__meta-item', title: `${plural(linkCount, 'link')} in notes` },
        icon('link'),
        String(linkCount)
      ),
    t.source &&
      h(
        t.source.url ? 'a' : 'span',
        {
          class: 'task-card__meta-item',
          href: t.source.url,
          target: t.source.url ? '_blank' : null,
          rel: t.source.url ? 'noopener' : null,
          onclick: (e) => e.stopPropagation(),
        },
        icon(sourceIcon(t.source.key)),
        t.source.label || t.source.key.split(':')[0]
      )
  );

  const card = h(
    'article',
    {
      class: `task-card${done ? ' task-card--done' : ''}${!done && !matchesFilter(t) ? ' task-card--dimmed' : ''}`,
      tabindex: '0',
      draggable: done ? null : 'true',
      dataset: { id: t.id },
      onclick: () => !done && openEditor(t.id),
      onkeydown: (e) => {
        if (e.key === 'Enter' && e.target === card && !done) openEditor(t.id);
      },
      ondragstart: (e) => {
        e.stopPropagation();
        e.dataTransfer.setData('application/x-todo-task', t.id);
        e.dataTransfer.effectAllowed = 'move';
        requestAnimationFrame(() => card.classList.add('task-card--dragging'));
      },
      ondragend: () => card.classList.remove('task-card--dragging'),
    },
    h(
      'button',
      {
        class: 'task-card__check',
        type: 'button',
        'aria-label': done ? `Mark "${t.title}" not done` : `Complete "${t.title}"`,
        onclick: (e) => {
          e.stopPropagation();
          if (done) reopen(t.id);
          else complete(t.id, card);
        },
      },
      icon('check')
    ),
    h(
      'div',
      { class: 'task-card__body' },
      h('p', { class: 'task-card__title' }, h('span', { class: 'task-card__strike' }, t.title)),
      done ? null : meta
    )
  );
  return card;
}

function startAdding(columnId) {
  openNewTask(columnId);
}

function stopEditingInline() {
  ui.addingCategory = false;
  ui.renamingId = null;
  setTimeout(() => {
    if (!isEditing()) render();
  });
}

function renderRename(c) {
  const commit = (input) => {
    const name = input.value.trim();
    ui.renamingId = null;
    if (name && name !== c.name) dispatch([{ type: 'renameCategory', id: c.id, name }]);
    else render();
  };
  return h('input', {
    class: 'board-column__rename',
    value: c.name,
    'aria-label': `Rename ${c.name}`,
    dataset: { rename: c.id },
    onkeydown: (e) => {
      if (e.key === 'Enter') commit(e.target);
      if (e.key === 'Escape') stopEditingInline();
    },
    onblur: (e) => {
      if (ui.renamingId === c.id) commit(e.target);
    },
    onclick: (e) => e.stopPropagation(),
  });
}

function renderColumn(c, index, list) {
  const isLoose = c.id === UNCATEGORIZED;
  const open = tasks().filter((t) => columnOf(t) === c.id && t.status === 'open').sort(sortCards);
  const done = tasks().filter((t) => columnOf(t) === c.id && doneToday(t));
  const showingDone = ui.showDone.has(c.id);
  const firstCategoryIndex = list.findIndex((x) => x.id !== UNCATEGORIZED);

  const column = h(
    'section',
    {
      class: `board-column${isLoose ? ' board-column--uncategorized' : ''}${
        c.id === ui.activeCategory ? ' board-column--active' : ''
      }`,
      'aria-label': c.name,
      dataset: { column: c.id },
      ondragover: (e) => {
        const types = e.dataTransfer.types;
        if (types.includes('application/x-todo-task') || (!isLoose && types.includes('application/x-todo-category'))) {
          e.preventDefault();
          column.classList.add('board-column--drop-target');
        }
      },
      ondragleave: (e) => {
        if (!column.contains(e.relatedTarget)) column.classList.remove('board-column--drop-target');
      },
      ondrop: (e) => {
        e.preventDefault();
        column.classList.remove('board-column--drop-target');
        const taskId = e.dataTransfer.getData('application/x-todo-task');
        const categoryId = e.dataTransfer.getData('application/x-todo-category');
        if (taskId) moveTask(taskId, c.id);
        else if (categoryId && categoryId !== c.id && !isLoose) {
          dispatch([{ type: 'moveCategory', id: categoryId, index: index - firstCategoryIndex }]);
        }
      },
    },
    h(
      'header',
      {
        class: 'board-column__header',
        draggable: isLoose || ui.renamingId === c.id ? null : 'true',
        ondragstart: (e) => {
          e.dataTransfer.setData('application/x-todo-category', c.id);
          e.dataTransfer.effectAllowed = 'move';
          requestAnimationFrame(() => column.classList.add('board-column--dragging'));
        },
        ondragend: () => column.classList.remove('board-column--dragging'),
        ondblclick: () => {
          if (isLoose) return;
          ui.renamingId = c.id;
          render();
          $(`[data-rename="${c.id}"]`)?.select();
        },
      },
      ui.renamingId === c.id ? renderRename(c) : h('h2', { class: 'board-column__name', title: c.name }, c.name),
      h('span', { class: 'board-column__count', 'aria-label': `${open.length} open` }, String(open.length)),
      isLoose
        ? null
        : h(
            'button',
            {
              class: 'quiet-button quiet-button--icon board-column__menu-button',
              type: 'button',
              'aria-label': `${c.name} actions`,
              'aria-haspopup': 'menu',
              'aria-expanded': String(ui.menuCategoryId === c.id),
              onclick: (e) => {
                e.stopPropagation();
                openColumnMenu(c.id, e.currentTarget);
              },
            },
            icon('dots-three')
          ),
      done.length
        ? h(
            'button',
            {
              class: 'board-column__sub board-column__done-toggle label',
              type: 'button',
              'aria-expanded': String(showingDone),
              ondblclick: (e) => e.stopPropagation(),
              onclick: (e) => {
                e.stopPropagation();
                if (showingDone) ui.showDone.delete(c.id);
                else ui.showDone.add(c.id);
                render();
              },
            },
            showingDone ? 'Hide done' : `${done.length} done today`
          )
        : h('span', { class: 'board-column__sub label' }, isLoose ? 'Sort these into a category' : open.length ? 'Open' : 'Clear')
    ),
    h(
      'div',
      { class: 'board-column__cards' },
      open.map((t) => renderCard(t)),
      !open.length && h('p', { class: 'board-column__empty' }, 'No tasks'),
      showingDone && done.map((t) => renderCard(t, { done: true }))
    ),
    h(
      'footer',
      { class: 'board-column__footer' },
      !isLoose &&
        h('button', { class: 'quiet-button', type: 'button', onclick: () => startAdding(c.id) }, icon('plus'), 'Add task')
    )
  );
  return column;
}

function renderCategoryForm() {
  return h(
    'form',
    {
      class: 'board-column__add-form',
      onsubmit: (e) => {
        e.preventDefault();
        const name = e.target.elements.name.value.trim();
        if (!name) return;
        const id = makeId('c');
        ui.addingCategory = false;
        ui.activeCategory = id;
        dispatch([{ type: 'addCategory', category: { id, name } }]);
      },
    },
    h('input', {
      class: 'board-column__add-input',
      name: 'name',
      placeholder: 'Category name',
      autocomplete: 'off',
      'aria-label': 'New category name',
      dataset: { newCategory: '' },
      onkeydown: (e) => {
        if (e.key === 'Escape') stopEditingInline();
      },
      onblur: (e) => {
        if (!e.target.value && categories().length) stopEditingInline();
      },
    })
  );
}

function renderGhostColumn() {
  const body = ui.addingCategory
    ? renderCategoryForm()
    : h(
        'button',
        {
          class: 'quiet-button',
          type: 'button',
          onclick: () => {
            ui.addingCategory = true;
            render();
            $('[data-new-category]')?.focus();
          },
        },
        icon('plus'),
        'Add category'
      );
  return h('section', { class: 'board-column board-column--ghost' }, h('header', { class: 'board-column__header' }, body));
}

function renderEmptyBoard() {
  return h(
    'section',
    { class: 'board-empty' },
    h('h2', { class: 'board-empty__title' }, store() ? 'Start with a category' : 'Connect to get started'),
    h(
      'p',
      { class: 'board-empty__lede' },
      store()
        ? 'Categories are the columns of your board: Admin, a project, anything you want to group.'
        : 'Point the board at your private task repo and your tasks will show up here.'
    ),
    store()
      ? renderCategoryForm()
      : h(
          'button',
          { class: 'quiet-button quiet-button--primary', type: 'button', onclick: () => openConnect() },
          'Connect'
        )
  );
}

function focusedField() {
  const data = document.activeElement?.dataset ?? {};
  if ('newCategory' in data) return '[data-new-category]';
  return null;
}

function render() {
  today = localToday();
  state.stale = false;
  const refocus = focusedField();
  const list = columns();
  if (!list.some((c) => c.id === ui.activeCategory)) ui.activeCategory = list[0]?.id ?? null;
  renderHeader();
  renderSync();
  renderTabs(list);
  $('#board').replaceChildren(
    ...(list.length ? [...list.map((c, i) => renderColumn(c, i, list)), renderGhostColumn()] : [renderEmptyBoard()])
  );
  if (refocus) $(refocus)?.focus({ preventScroll: true });
}

// region actions

const prefersReducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

function foldAway(card) {
  if (prefersReducedMotion()) return Promise.resolve();
  card.classList.add('task-card--completing');
  return new Promise((resolve) => setTimeout(resolve, 520)).then(
    () =>
      card.animate(
        [
          { blockSize: `${card.offsetHeight}px`, opacity: 1 },
          { blockSize: '0px', paddingBlock: '0px', opacity: 0 },
        ],
        { duration: 260, easing: 'cubic-bezier(0.16, 1, 0.3, 1)', fill: 'forwards' }
      ).finished
  );
}

const restoreTask = (snapshot) => () => dispatch([{ type: 'restore', task: snapshot }]);

function complete(id, card) {
  const t = findTaskById(id);
  if (!t) return;
  const snapshot = structuredClone(t);
  foldAway(card).then(() => {
    const [result] = dispatch([{ type: 'complete', id, due: t.due ?? undefined }]) ?? [];
    if (!result || result.skipped) return;
    const next = result.task.repeat ? dueInfo(result.task.due) : null;
    toast(next ? `Completed · next ${next.label.toLowerCase()}` : 'Completed', restoreTask(snapshot));
  });
}

function reopen(id) {
  dispatch([{ type: 'reopen', id }]);
}

function moveTask(id, columnId) {
  const t = findTaskById(id);
  const category = columnId === UNCATEGORIZED ? null : columnId;
  if (!t || columnOf(t) === columnId) return;
  const snapshot = structuredClone(t);
  dispatch([{ type: 'update', id, patch: { category } }]);
  toast(`Moved to ${categoryName(category)}`, restoreTask(snapshot));
}

let toastTimer;
function toast(text, undo) {
  ui.undo = undo;
  $('#toast-text').textContent = text;
  $('#toast-undo').hidden = !undo;
  $('#toast').hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => ($('#toast').hidden = true), 6000);
}

$('#toast-undo').addEventListener('click', () => {
  const undo = ui.undo;
  ui.undo = null;
  $('#toast').hidden = true;
  undo?.();
});

// region dialogs

function showModal(id) {
  $(id).classList.add('modal-wrapper--active');
  $(id).setAttribute('aria-hidden', 'false');
}

function hideModal(id) {
  $(id).classList.remove('modal-wrapper--active');
  $(id).setAttribute('aria-hidden', 'true');
}

const presetFor = (repeat) => {
  if (!repeat) return '';
  const key = (r) => `${r.every}|${r.unit}|${(r.weekdays || []).join(',')}`;
  const presets = ['daily', 'weekdays', 'weekly', 'biweekly', 'monthly', 'yearly'];
  return presets.find((p) => key(parseRepeat(p)) === key(repeat)) ?? 'custom';
};

const categoryOptions = (selected, exclude) => [
  h('option', { value: UNCATEGORIZED, selected: selected === UNCATEGORIZED }, 'Uncategorized'),
  ...categories()
    .filter((c) => c.id !== exclude)
    .map((c) => h('option', { value: c.id, selected: c.id === selected }, c.name)),
];

function openEditor(id) {
  const t = findTaskById(id);
  if (!t) return;
  ui.editingId = id;
  ui.creatingIn = null;
  const form = $('#editor-form');
  setEditorMode('edit');
  form.elements.title.value = t.title;
  form.elements.notes.value = t.notes || '';
  renderEditorLinks(t.notes);
  form.elements.due.value = t.due || '';
  editorTags = [...t.tags];
  form.elements.tagQuery.value = '';
  renderTagChips();
  form.elements.category.replaceChildren(...categoryOptions(columnOf(t)));
  const repeat = form.elements.repeat;
  repeat.querySelector('[value="custom"]')?.remove();
  const preset = presetFor(t.repeat);
  if (preset === 'custom') repeat.append(h('option', { value: 'custom' }, describeRepeat(t.repeat)));
  repeat.value = preset;

  $('#editor-crumb').textContent = categoryName(t.category);
  $('#editor-source').replaceChildren(
    ...(t.source
      ? [
          'From ',
          t.source.url
            ? h('a', { href: t.source.url, target: '_blank', rel: 'noopener' }, t.source.key)
            : t.source.key,
        ]
      : [])
  );
  showModal('#editor');
  setTimeout(() => form.elements.title.focus(), 50);
}

function setEditorMode(mode) {
  const creating = mode === 'create';
  $('#editor-delete').hidden = creating;
  $('#editor-submit').textContent = creating ? 'Add task' : 'Save';
  $('#editor-form').setAttribute('aria-label', creating ? 'New task' : 'Edit task');
}

function openNewTask(columnId) {
  ui.creatingIn = columnId;
  ui.editingId = null;
  const form = $('#editor-form');
  setEditorMode('create');
  form.elements.title.value = '';
  form.elements.notes.value = '';
  renderEditorLinks('');
  form.elements.due.value = '';
  editorTags = [];
  form.elements.tagQuery.value = '';
  renderTagChips();
  form.elements.category.replaceChildren(...categoryOptions(columnId));
  form.elements.repeat.querySelector('[value="custom"]')?.remove();
  form.elements.repeat.value = '';
  $('#editor-crumb').textContent = `New task · ${categoryName(columnId === UNCATEGORIZED ? null : columnId)}`;
  $('#editor-source').replaceChildren();
  showModal('#editor');
  setTimeout(() => form.elements.title.focus(), 50);
}

function renderEditorLinks(notes) {
  const links = noteLinks(notes);
  const list = $('#editor-links');
  list.hidden = !links.length;
  list.replaceChildren(
    ...links.map((link) =>
      h(
        'li',
        {},
        h(
          'a',
          { class: 'editor__link', href: link.url, target: '_blank', rel: 'noopener' },
          icon('arrow-up-right'),
          h('span', { class: 'editor__link-label' }, link.label),
          h('span', { class: 'editor__link-host' }, link.host)
        )
      )
    )
  );
}

$('#editor-notes').addEventListener('input', (e) => renderEditorLinks(e.target.value));

function closeEditor() {
  closeTagSuggest();
  hideModal('#editor');
  ui.editingId = null;
  ui.creatingIn = null;
  if (state.stale) render();
}

$('#editor-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const f = e.target.elements;
  commitTag(f.tagQuery.value);
  const category = f.category.value === UNCATEGORIZED ? null : f.category.value;
  if (ui.creatingIn) {
    const { title, tags } = parseTitle(f.title.value);
    if (!title) return f.title.focus();
    const task = {
      id: makeId(),
      title,
      notes: f.notes.value,
      category,
      tags: [...new Set([...editorTags, ...tags])],
      due: f.due.value || null,
      repeat: f.repeat.value || null,
      addedBy: 'app',
    };
    ui.activeCategory = category ?? UNCATEGORIZED;
    closeEditor();
    dispatch([{ type: 'add', task }]);
    return;
  }
  const t = findTaskById(ui.editingId);
  if (!t) return closeEditor();
  const patch = {
    title: f.title.value.trim() || t.title,
    notes: f.notes.value,
    category,
    tags: editorTags,
    due: f.due.value || null,
  };
  if (f.repeat.value !== 'custom') patch.repeat = f.repeat.value || null;
  ui.activeCategory = category ?? UNCATEGORIZED;
  const id = ui.editingId;
  closeEditor();
  dispatch([{ type: 'update', id, patch }]);
});

$('#editor-delete').addEventListener('click', () => {
  const t = findTaskById(ui.editingId);
  closeEditor();
  if (!t) return;
  const snapshot = structuredClone(t);
  dispatch([{ type: 'delete', id: t.id }]);
  toast('Deleted', restoreTask(snapshot));
});

document.querySelectorAll('#editor [data-close]').forEach((el) => el.addEventListener('click', closeEditor));

// region tag picker

let editorTags = [];
let tagHighlight = 0;
let tagNavigated = false;
const tagInput = $('#editor-tags');
const tagSuggest = $('#tag-suggest');

const knownTags = () =>
  [...new Set(tasks().flatMap((t) => t.tags))].sort((a, b) => tagMix(b) - tagMix(a) || a.localeCompare(b));

function renderTagChips() {
  $('#editor-tag-chips').replaceChildren(
    ...editorTags.map((tag) =>
      h(
        'span',
        { class: 'tag-chip', style: `--td-tag-mix: ${tagMix(tag)}%` },
        tag,
        h(
          'button',
          {
            class: 'tag-chip__remove',
            type: 'button',
            'aria-label': `Remove ${tag}`,
            onclick: (e) => {
              e.stopPropagation();
              editorTags = editorTags.filter((t) => t !== tag);
              renderTagChips();
              tagInput.focus();
              if (tagSuggest.matches(':popover-open')) renderTagSuggest();
            },
          },
          icon('x')
        )
      )
    )
  );
  tagInput.placeholder = editorTags.length ? '' : 'Add tag';
}

function tagSuggestions() {
  const query = normalizeTags([tagInput.value])[0] ?? '';
  const pool = knownTags().filter((tag) => !editorTags.includes(tag));
  const matches = query
    ? pool
        .filter((tag) => tag.includes(query))
        .sort((a, b) => Number(!a.startsWith(query)) - Number(!b.startsWith(query)))
    : pool;
  const options = matches.map((tag) => ({ tag, create: false }));
  if (query && !knownTags().includes(query) && !editorTags.includes(query)) options.push({ tag: query, create: true });
  return options;
}

function renderTagSuggest() {
  const options = tagSuggestions();
  tagHighlight = Math.min(tagHighlight, Math.max(options.length - 1, 0));
  tagSuggest.replaceChildren(
    ...(options.length
      ? options.map((option, i) =>
          h(
            'div',
            {
              class: `tag-menu__option${option.create ? ' tag-suggest__create' : ''}`,
              id: `tag-option-${i}`,
              role: 'option',
              'aria-selected': String(i === tagHighlight && (tagNavigated || tagInput.value.trim() !== '')),
              onpointerdown: (e) => e.preventDefault(),
              onclick: () => {
                commitTag(option.tag);
                tagInput.focus();
              },
              onpointermove: () => {
                if (tagHighlight !== i) {
                  tagHighlight = i;
                  renderTagSuggest();
                }
              },
            },
            option.create ? icon('plus') : tagDot(option.tag),
            option.create
              ? h('span', { class: 'tag-menu__name' }, 'Create ', h('b', {}, option.tag))
              : h('span', { class: 'tag-menu__name' }, option.tag)
          )
        )
      : [h('p', { class: 'tag-suggest__empty' }, editorTags.length ? 'All your tags are on this task' : 'Type to create a tag')])
  );
  tagInput.setAttribute('aria-activedescendant', options.length ? `tag-option-${tagHighlight}` : '');
  return options;
}

function openTagSuggest() {
  const rect = $('#editor-tag-field').getBoundingClientRect();
  tagSuggest.style.top = `${rect.bottom + 4}px`;
  tagSuggest.style.left = `${rect.left}px`;
  tagSuggest.style.right = 'auto';
  tagSuggest.style.inlineSize = `${Math.max(rect.width, 200)}px`;
  renderTagSuggest();
  if (!tagSuggest.matches(':popover-open')) tagSuggest.showPopover();
  tagInput.setAttribute('aria-expanded', 'true');
}

function closeTagSuggest() {
  if (tagSuggest.matches(':popover-open')) tagSuggest.hidePopover();
  tagInput.setAttribute('aria-expanded', 'false');
  tagInput.removeAttribute('aria-activedescendant');
}

function commitTag(value) {
  const [tag] = normalizeTags([value]);
  tagInput.value = '';
  tagHighlight = 0;
  tagNavigated = false;
  if (tag && !editorTags.includes(tag)) editorTags.push(tag);
  renderTagChips();
  if (tagSuggest.matches(':popover-open')) openTagSuggest();
}

$('#editor-tag-field').addEventListener('click', () => tagInput.focus());
tagInput.addEventListener('focus', openTagSuggest);
tagInput.addEventListener('blur', closeTagSuggest);
tagInput.addEventListener('input', () => {
  tagHighlight = 0;
  tagNavigated = false;
  if (tagInput.value.includes(',')) {
    tagInput.value.split(',').slice(0, -1).forEach(commitTag);
    tagInput.value = '';
  }
  openTagSuggest();
});
tagInput.addEventListener('keydown', (e) => {
  const open = tagSuggest.matches(':popover-open');
  const options = open ? tagSuggestions() : [];
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    if (!open) return openTagSuggest();
    if (!options.length) return;
    tagHighlight = tagNavigated
      ? (tagHighlight + (e.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length
      : e.key === 'ArrowDown'
        ? 0
        : options.length - 1;
    tagNavigated = true;
    renderTagSuggest();
  } else if (e.key === 'Enter' && (tagInput.value.trim() || (open && tagNavigated && options.length))) {
    e.preventDefault();
    const pick = options[tagHighlight];
    commitTag(pick ? pick.tag : tagInput.value);
  } else if (e.key === 'Backspace' && !tagInput.value && editorTags.length) {
    editorTags.pop();
    renderTagChips();
    if (open) renderTagSuggest();
  } else if (e.key === 'Escape' && open) {
    e.stopPropagation();
    closeTagSuggest();
  }
});

const columnMenu = $('#column-menu');

function openColumnMenu(categoryId, anchor) {
  ui.menuCategoryId = categoryId;
  const index = categories().findIndex((c) => c.id === categoryId);
  columnMenu.querySelector('[data-action="left"]').hidden = index <= 0;
  columnMenu.querySelector('[data-action="right"]').hidden = index >= categories().length - 1;
  const rect = anchor.getBoundingClientRect();
  columnMenu.style.top = `${rect.bottom + 4}px`;
  columnMenu.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - 220))}px`;
  columnMenu.style.right = 'auto';
  columnMenu.showPopover();
  anchor.setAttribute('aria-expanded', 'true');
  columnMenu.querySelector('.tag-menu__option:not([hidden])')?.focus();
}

columnMenu.addEventListener('toggle', (e) => {
  if (e.newState !== 'closed') return;
  ui.menuCategoryId = null;
  document.querySelectorAll('.board-column__menu-button').forEach((b) => b.setAttribute('aria-expanded', 'false'));
});

columnMenu.addEventListener('click', (e) => {
  const action = e.target.closest('[data-action]')?.dataset.action;
  if (!action) return;
  const id = ui.menuCategoryId;
  columnMenu.hidePopover();
  const index = categories().findIndex((c) => c.id === id);
  if (action === 'rename') {
    ui.renamingId = id;
    render();
    $(`[data-rename="${id}"]`)?.select();
  } else if (action === 'left' || action === 'right') {
    dispatch([{ type: 'moveCategory', id, index: index + (action === 'left' ? -1 : 1) }]);
  } else if (action === 'delete') {
    openDeleteCategory(id);
  }
});

function deleteCategory(id, { moveTo = null, deleteTasks = false } = {}) {
  const index = categories().findIndex((c) => c.id === id);
  const category = structuredClone(categories()[index]);
  const snapshot = structuredClone(tasks().filter((t) => t.category === id));
  dispatch([{ type: 'deleteCategory', id, moveTo, deleteTasks }]);
  toast(`Deleted ${category.name}`, () => dispatch([{ type: 'restoreCategory', category, index, tasks: snapshot }]));
}

function openDeleteCategory(id) {
  const category = categories().find((c) => c.id === id);
  if (!category) return;
  const inside = tasks().filter((t) => t.category === id);
  if (!inside.length) return deleteCategory(id);
  ui.deletingId = id;
  const open = inside.filter((t) => t.status === 'open').length;
  const form = $('#delete-category-form');
  $('#delete-category-title').textContent = `Delete ${category.name}?`;
  $('#delete-category-lede').textContent = `It holds ${plural(open, 'open task')}${
    inside.length > open ? ` and ${inside.length - open} finished` : ''
  }.`;
  form.elements.moveTo.replaceChildren(...categoryOptions(UNCATEGORIZED, id));
  form.elements.fate.value = 'move';
  showModal('#delete-category');
  setTimeout(() => form.elements.moveTo.focus(), 50);
}

function closeDeleteCategory() {
  hideModal('#delete-category');
  ui.deletingId = null;
  if (state.stale) render();
}

$('#delete-category-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const f = e.target.elements;
  const id = ui.deletingId;
  closeDeleteCategory();
  if (f.fate.value === 'delete') deleteCategory(id, { deleteTasks: true });
  else deleteCategory(id, { moveTo: f.moveTo.value === UNCATEGORIZED ? null : f.moveTo.value });
});

$('#delete-category-form').elements.moveTo.addEventListener('change', (e) => {
  e.target.form.elements.fate.value = 'move';
});

document.querySelectorAll('#delete-category [data-close]').forEach((el) =>
  el.addEventListener('click', closeDeleteCategory)
);

function openConnect() {
  const form = $('#connect-form');
  form.elements.repo.value = state.config?.repo || 'gmceachran/todo-data';
  form.elements.token.value = state.config?.token || '';
  $('#connect-error').hidden = true;
  $('#connect-forget').hidden = !state.config;
  $('#connect-cancel').hidden = !state.config;
  $('#connect .modal-wrapper__backdrop').toggleAttribute('data-close', Boolean(state.config));
  showModal('#connect');
  setTimeout(() => (state.config ? form.elements.repo : form.elements.token).focus(), 50);
}

function closeConnect() {
  if (!state.config) return;
  hideModal('#connect');
}

$('#connect-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target.elements;
  const error = $('#connect-error');
  const submit = e.target.querySelector('[type="submit"]');
  error.hidden = true;
  try {
    parseRepo(f.repo.value);
  } catch (err) {
    error.textContent = err.message;
    error.hidden = false;
    return;
  }
  const config = { repo: f.repo.value.trim(), token: f.token.value.trim(), branch: 'main', path: 'tasks.json' };
  const candidate = new GitHubStore(config);
  submit.disabled = true;
  submit.textContent = 'Checking…';
  try {
    await candidate.check();
    const loaded = await candidate.load();
    const switchedRepo = state.config?.repo !== config.repo;
    state.config = config;
    storeInstance = candidate;
    storage.set(KEYS.config, config);
    state.remote = loaded;
    if (switchedRepo) state.pending = [];
    persist();
    hideModal('#connect');
    computeView();
    setSync('idle');
    render();
    processInbox();
    flush();
  } catch (err) {
    error.textContent =
      err instanceof AuthError
        ? `${err.message}. Check the token can read and write Contents on ${config.repo}.`
        : err instanceof TypeError
          ? "Couldn't reach GitHub. Check your connection and try again."
          : err.message;
    error.hidden = false;
  } finally {
    submit.disabled = false;
    submit.textContent = 'Connect';
  }
});

$('#connect-forget').addEventListener('click', () => {
  const unsynced = state.pending.length;
  const message = unsynced
    ? `Forget this device? ${plural(unsynced, 'change')} haven't synced yet and will be lost.`
    : 'Forget this device? Your tasks stay in GitHub; this just removes the token and cached copy here.';
  if (!window.confirm(message)) return;
  for (const key of Object.values(KEYS)) storage.remove(key);
  state.config = null;
  state.remote = null;
  state.pending = [];
  storeInstance = null;
  hideModal('#connect');
  computeView();
  render();
  openConnect();
});

document.querySelectorAll('#connect [data-close]').forEach((el) => el.addEventListener('click', closeConnect));
$('#open-settings').addEventListener('click', openConnect);
$('#add-fab').addEventListener('click', () => startAdding(ui.activeCategory ?? UNCATEGORIZED));

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (ui.editingId || ui.creatingIn) closeEditor();
  else if (ui.deletingId) closeDeleteCategory();
  else if ($('#connect').classList.contains('modal-wrapper--active')) closeConnect();
});

$('#sync-status').addEventListener('click', () => {
  if (!store() || (state.sync === 'error' && state.syncMessage === 'Reconnect')) openConnect();
  else refresh();
});

// region import

function readImportHash() {
  const match = location.hash.match(/^#import=([\w-]+)$/);
  if (!match) return;
  history.replaceState(null, '', location.pathname + location.search);
  try {
    const incoming = decodeImport(match[1]);
    if (incoming.length) storage.set(KEYS.inbox, [...storage.get(KEYS.inbox, []), ...incoming]);
  } catch {
    toast("That link from your brief couldn't be read");
  }
}

function processInbox() {
  const incoming = storage.get(KEYS.inbox, []);
  if (!incoming.length || !store()) return;
  storage.remove(KEYS.inbox);
  const ops = incoming.map((task) => ({ type: 'add', task: { ...task, id: makeId(), addedBy: 'brief' } }));
  const results = dispatch(ops) ?? [];
  const added = results.filter((r) => r.task && !r.skipped);
  const skipped = results.length - added.length;
  if (!added.length) return toast(skipped ? 'Those tasks are already on your list' : 'Nothing to add');
  const loose = added.filter((r) => !r.task.category).length;
  const bits = [`Added ${plural(added.length, 'task')} from your brief`];
  if (skipped) bits.push(`${skipped} already on your list`);
  if (loose) bits.push(`${loose} in Uncategorized`);
  toast(bits.join(' · '), () => dispatch(added.map((r) => ({ type: 'delete', id: r.task.id }))));
}

window.addEventListener('hashchange', () => {
  readImportHash();
  processInbox();
});

// region filters

document.querySelectorAll('input[name="filter"]').forEach((input) =>
  input.addEventListener('change', () => {
    ui.filter = input.value;
    render();
  })
);

const tagMenu = $('#tag-menu-list');
const tagMenuButton = $('#tag-menu-button');
const tagOptions = () => [...tagMenu.querySelectorAll('.tag-menu__option')];

tagMenu.addEventListener('beforetoggle', (e) => {
  if (e.newState !== 'open') return;
  const rect = tagMenuButton.getBoundingClientRect();
  tagMenu.style.top = `${rect.bottom + 6}px`;
  tagMenu.style.right = `${window.innerWidth - rect.right}px`;
});

tagMenu.addEventListener('toggle', (e) => {
  tagMenuButton.setAttribute('aria-expanded', String(e.newState === 'open'));
  if (e.newState === 'open') (tagOptions().find((o) => o.dataset.tag === ui.tag) || tagOptions()[0])?.focus();
});

function menuKeys(menu) {
  menu.addEventListener('keydown', (e) => {
    const options = [...menu.querySelectorAll('.tag-menu__option:not([hidden])')];
    const index = options.indexOf(document.activeElement);
    const moves = { ArrowDown: 1, ArrowUp: -1 };
    if (e.key in moves) {
      e.preventDefault();
      options[(index + moves[e.key] + options.length) % options.length].focus();
    } else if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      options[e.key === 'Home' ? 0 : options.length - 1].focus();
    }
  });
}

menuKeys(tagMenu);
menuKeys(columnMenu);

// region boot

computeView();
readImportHash();
render();

if (store()) {
  refresh().then(processInbox);
} else {
  openConnect();
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') refresh();
});
window.addEventListener('online', () => (state.pending.length ? flush() : refresh()));
window.addEventListener('offline', () => setSync('offline'));
document.addEventListener('focusout', () => {
  setTimeout(() => {
    if (state.stale && !isEditing()) render();
  });
});

setInterval(() => {
  if (document.visibilityState === 'visible') refresh();
}, POLL_MS);

setInterval(() => {
  if (localToday() !== today) safeRender();
}, 60000);

if (false && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  navigator.serviceWorker.register('./sw.js').catch((error) => console.warn('Service worker failed', error));
}
})();
