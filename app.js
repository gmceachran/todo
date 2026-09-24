import {
  addDays,
  normalizeTags,
  applyOp,
  daysBetween,
  decodeImport,
  describeRepeat,
  emptyDoc,
  localDateOf,
  localToday,
  makeId,
  normalizeDoc,
  parseRepeat,
  weekday,
} from './core.js';
import { AuthError, GitHubStore, commitOps, parseRepo } from './store.js';
import { createDemoStore } from './demo.js';

const demoStore = createDemoStore();

const DEMO = new URLSearchParams(location.search).has('demo');
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
  $('#dateline').textContent = `Week ${isoWeek(today)} · ${today.slice(0, 4)}`;
  $('#crumbs').textContent = [
    'Tasks',
    'Board',
    { all: 'All', today: 'Today', week: 'This week', overdue: 'Overdue' }[ui.filter] + (ui.tag ? ` #${ui.tag}` : ''),
  ].join(' / ');
  $('#today-label').replaceChildren(
    new Intl.DateTimeFormat('en-US', { weekday: 'long', timeZone: 'UTC' }).format(utc(today)),
    h(
      'span',
      { class: 'masthead__date' },
      new Intl.DateTimeFormat('en-US', { month: 'long', day: 'numeric', timeZone: 'UTC' }).format(utc(today))
    )
  );
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

if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  navigator.serviceWorker.register('./sw.js').catch((error) => console.warn('Service worker failed', error));
}
