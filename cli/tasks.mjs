#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { agenda, describeRepeat, emptyDoc, encodeImport, localToday, makeId, normalizeDoc } from '../core.js';
import { GitHubStore, commitOps } from '../store.js';

const HELP = `Usage: tasks [options] <command> [args]

Reading:
  agenda                       Overdue, today, next 7 days, later, someday, done today
  list [--status open|done|all] [--category NAME]
  categories                   Category names and ids, in board order
  has <source-key>             Exit 0 if a task with that source key exists (or was deleted)
  was-suggested <source-key>   Exit 0 if the brief already suggested that key

Writing:
  add <title>                  Add a task
  update <ref> [fields]        Change --title, --due, --repeat, --notes, --category, --tags
  complete|reopen|delete <ref>...
  category add <name>
  category rename <ref> <name>
  category delete <ref> [--move-to REF | --delete-tasks]
  mark-suggested <key>...      Record source keys the brief has shown as suggestions
  apply <file|->               Apply a JSON array of operations in one commit

Brief helpers:
  link <file|->                Print an app link that adds a JSON array of tasks when opened

Task fields:
  --due YYYY-MM-DD|none   --repeat "weekdays"|"every 2 weeks"|"every mon, thu"|none
  --notes TEXT   --category NAME|none   --tags "a, b"
  --source KEY (e.g. linear:RM-12)   --url URL   --label TEXT

Options:
  --repo owner/name   Data repo (default $TODO_REPO or gmceachran/todo-data)
  --file PATH         Use a local tasks.json instead of GitHub
  --tz ZONE           Time zone for "today" (default $TODO_TZ or America/New_York)
  --today YYYY-MM-DD  Override today
  --by NAME           Recorded as addedBy and in the commit message (default cli)
  --json              Machine-readable output

<ref> is a task id, a unique id prefix, or source:<key>. Category refs are an id or a name.
GitHub token: $GITHUB_TOKEN, else \`gh auth token\`.
App URL for links: $TODO_APP_URL (default https://gmceachran.github.io/todo/).`;

const { values: opts, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    repo: { type: 'string' },
    file: { type: 'string' },
    tz: { type: 'string' },
    today: { type: 'string' },
    by: { type: 'string' },
    json: { type: 'boolean' },
    status: { type: 'string' },
    title: { type: 'string' },
    due: { type: 'string' },
    repeat: { type: 'string' },
    notes: { type: 'string' },
    category: { type: 'string' },
    tags: { type: 'string' },
    source: { type: 'string' },
    url: { type: 'string' },
    label: { type: 'string' },
    'move-to': { type: 'string' },
    'delete-tasks': { type: 'boolean' },
    help: { type: 'boolean', short: 'h' },
  },
});

const [command, ...args] = positionals;
if (!command || opts.help) {
  console.log(HELP);
  process.exit(command || opts.help ? 0 : 1);
}

const timeZone = opts.tz || process.env.TODO_TZ || 'America/New_York';
const today = opts.today || localToday(timeZone);
const author = opts.by || 'cli';
const ctx = { today };
const appUrl = process.env.TODO_APP_URL || 'https://gmceachran.github.io/todo/';

function githubToken() {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  try {
    return execFileSync('gh', ['auth', 'token'], { encoding: 'utf8' }).trim();
  } catch {
    throw new Error('No GitHub token: set GITHUB_TOKEN or log in with `gh auth login`');
  }
}

function fileStore(path) {
  return {
    async load() {
      if (!existsSync(path)) return { doc: emptyDoc(), sha: null };
      return { doc: normalizeDoc(JSON.parse(readFileSync(path, 'utf8'))), sha: null };
    },
    async save(doc) {
      writeFileSync(path, `${JSON.stringify(doc, null, 2)}\n`);
      return null;
    },
  };
}

let store;
const getStore = () =>
  (store ??= opts.file
    ? fileStore(opts.file)
    : new GitHubStore({ repo: opts.repo || process.env.TODO_REPO || 'gmceachran/todo-data', token: githubToken() }));

function readInput(path) {
  return !path || path === '-' ? readFileSync(0, 'utf8') : readFileSync(path, 'utf8');
}

function resolveRef(doc, ref) {
  if (!ref) throw new Error('Missing task id');
  if (ref.startsWith('source:')) return { source: ref.slice('source:'.length) };
  const exact = doc.tasks.find((t) => t.id === ref);
  if (exact) return { id: exact.id };
  const matches = doc.tasks.filter((t) => t.id.startsWith(ref));
  if (matches.length === 1) return { id: matches[0].id };
  throw new Error(matches.length ? `"${ref}" matches ${matches.length} tasks` : `No task "${ref}"`);
}

function categoryId(doc, ref) {
  const category =
    doc.categories.find((c) => c.id === ref) ||
    doc.categories.find((c) => c.name.toLowerCase() === String(ref).toLowerCase());
  if (!category) throw new Error(`No category "${ref}"`);
  return category.id;
}

function sourceFromOpts() {
  if (!opts.source) return undefined;
  return { key: opts.source, url: opts.url, label: opts.label };
}

function categoryField(value) {
  if (value === undefined) return {};
  return value === 'none' ? { category: null } : { categoryName: value };
}

function specToOp(doc, spec) {
  const { op: type, id, source, ...rest } = spec;
  if (type === 'add') {
    const { category, ...fields } = rest;
    return {
      type: 'add',
      task: {
        id: makeId(),
        addedBy: author,
        ...fields,
        ...categoryField(category),
        source: typeof source === 'string' ? { key: source, url: rest.url, label: rest.label } : source,
      },
    };
  }
  if (type === 'markSuggested') return { type, keys: rest.keys || [] };
  const target = id ? resolveRef(doc, id) : { source: typeof source === 'string' ? source : source?.key };
  if (!target.id && !target.source) throw new Error(`Operation needs an id or source: ${JSON.stringify(spec)}`);
  if (type === 'update') {
    const { category, ...patch } = rest.patch || rest;
    return { type, ...target, patch: { ...patch, ...categoryField(category) } };
  }
  return { type, ...target, today };
}

function categoryName(doc, id) {
  return doc.categories.find((c) => c.id === id)?.name ?? 'Uncategorized';
}

function formatTask(doc, task) {
  const bits = [categoryName(doc, task.category)];
  if (task.due) bits.push(task.due);
  if (task.repeat) bits.push(`↻ ${describeRepeat(task.repeat)}`);
  if (task.tags.length) bits.push(task.tags.map((t) => `#${t}`).join(' '));
  if (task.source) bits.push(task.source.key);
  return `  ${task.id}  ${task.title}  (${bits.join(' · ')})`;
}

function print(data, text) {
  console.log(opts.json ? JSON.stringify(data, null, 2) : text);
}

async function mutate(buildOps) {
  const base = await getStore().load();
  const ops = buildOps(base.doc);
  const { doc, results } = await commitOps(getStore(), ops, { ctx, author, base });
  const describe = (r, op) => {
    const name = r.task?.title || r.category?.name || op.task?.title || op.category?.name || op.id || op.source;
    if (r.skipped) return `skipped (${r.skipped}): ${name}`;
    if (op.type === 'markSuggested') return `marked ${r.marked} suggested`;
    return `${op.type}: ${name}  [${r.task?.id || r.category?.id}]`;
  };
  print(
    results.map((r) => ({ ...r, doc: undefined })),
    results.map((r, i) => describe(r, ops[i])).join('\n')
  );
  return { doc, results };
}

async function run() {
  switch (command) {
    case 'agenda': {
      const { doc } = await getStore().load();
      const groups = agenda(doc, today, { timeZone });
      const labels = {
        overdue: 'Overdue',
        today: 'Today',
        upcoming: 'Next 7 days',
        later: 'Later',
        someday: 'Someday',
        doneToday: 'Done today',
      };
      const text = Object.entries(labels)
        .filter(([key]) => groups[key].length)
        .map(([key, label]) => `${label}\n${groups[key].map((t) => formatTask(doc, t)).join('\n')}`)
        .join('\n\n');
      const withNames = Object.fromEntries(
        Object.entries(groups).map(([key, tasks]) => [
          key,
          tasks.map((t) => ({ ...t, categoryName: categoryName(doc, t.category) })),
        ])
      );
      print({ today, categories: doc.categories, ...withNames }, text || 'Nothing on the list.');
      return;
    }
    case 'list': {
      const { doc } = await getStore().load();
      const status = opts.status || 'open';
      let tasks = status === 'all' ? doc.tasks : doc.tasks.filter((t) => t.status === status);
      if (opts.category) {
        const id = opts.category === 'none' ? null : categoryId(doc, opts.category);
        tasks = tasks.filter((t) => t.category === id);
      }
      print(tasks, tasks.map((t) => formatTask(doc, t)).join('\n') || `No ${status} tasks.`);
      return;
    }
    case 'categories': {
      const { doc } = await getStore().load();
      const rows = doc.categories.map((c) => ({
        ...c,
        open: doc.tasks.filter((t) => t.category === c.id && t.status === 'open').length,
      }));
      print(rows, rows.map((c) => `  ${c.id}  ${c.name}  (${c.open} open)`).join('\n') || 'No categories yet.');
      return;
    }
    case 'has': {
      const { doc } = await getStore().load();
      const task = doc.tasks.find((t) => t.source?.key === args[0]);
      const removed = doc.removed[args[0]];
      print(task || (removed ? { removed } : null), task ? formatTask(doc, task) : removed ? `deleted ${removed}` : 'no');
      process.exitCode = task || removed ? 0 : 1;
      return;
    }
    case 'was-suggested': {
      const { doc } = await getStore().load();
      const date = doc.suggested[args[0]];
      print(date || null, date || 'no');
      process.exitCode = date ? 0 : 1;
      return;
    }
    case 'add': {
      await mutate(() => [
        {
          type: 'add',
          task: {
            id: makeId(),
            title: args.join(' '),
            due: opts.due,
            repeat: opts.repeat,
            notes: opts.notes,
            tags: opts.tags,
            ...categoryField(opts.category),
            source: sourceFromOpts(),
            addedBy: author,
          },
        },
      ]);
      return;
    }
    case 'update': {
      const patch = {};
      for (const key of ['title', 'due', 'repeat', 'notes', 'tags']) if (opts[key] !== undefined) patch[key] = opts[key];
      Object.assign(patch, categoryField(opts.category));
      if (opts.source !== undefined) patch.source = sourceFromOpts();
      await mutate((doc) => [{ type: 'update', ...resolveRef(doc, args[0]), patch }]);
      return;
    }
    case 'complete':
    case 'reopen':
    case 'delete':
      await mutate((doc) => args.map((ref) => ({ type: command, ...resolveRef(doc, ref), today })));
      return;
    case 'category': {
      const [action, ref, ...rest] = args;
      if (action === 'add') {
        await mutate(() => [{ type: 'addCategory', category: { name: [ref, ...rest].join(' ') } }]);
      } else if (action === 'rename') {
        await mutate((doc) => [{ type: 'renameCategory', id: categoryId(doc, ref), name: rest.join(' ') }]);
      } else if (action === 'delete') {
        await mutate((doc) => [
          {
            type: 'deleteCategory',
            id: categoryId(doc, ref),
            moveTo: opts['move-to'] ? categoryId(doc, opts['move-to']) : null,
            deleteTasks: Boolean(opts['delete-tasks']),
          },
        ]);
      } else {
        throw new Error('Use: category add|rename|delete');
      }
      return;
    }
    case 'mark-suggested':
      if (!args.length) throw new Error('mark-suggested needs at least one source key');
      await mutate(() => [{ type: 'markSuggested', keys: args }]);
      return;
    case 'apply': {
      const specs = JSON.parse(readInput(args[0]));
      if (!Array.isArray(specs)) throw new Error('apply expects a JSON array');
      if (!specs.length) return print([], 'Nothing to apply.');
      await mutate((doc) => specs.map((spec) => specToOp(doc, spec)));
      return;
    }
    case 'link': {
      const tasks = JSON.parse(readInput(args[0]));
      if (!Array.isArray(tasks) || !tasks.length) throw new Error('link expects a non-empty JSON array of tasks');
      const url = `${appUrl}#import=${encodeImport(tasks)}`;
      print({ url, count: tasks.length }, url);
      return;
    }
    default:
      throw new Error(`Unknown command "${command}"\n\n${HELP}`);
  }
}

run().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
