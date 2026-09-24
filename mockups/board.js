import { addDays, daysBetween, describeRepeat, localDateOf, localToday, nextOccurrence, parseRepeat, weekday } from '../core.js';

const today = localToday();
const nowIso = () => new Date().toISOString();

const categories = [
  { id: 'admin', name: 'Admin' },
  { id: 'thundercloud', name: 'Thundercloud' },
  { id: 'prodev', name: 'Professional development' },
  { id: 'personal', name: 'Personal' },
];

let seq = 0;
const task = (category, title, extra = {}) => ({
  id: `m${++seq}`,
  category,
  title,
  status: 'open',
  due: null,
  repeat: null,
  tags: [],
  created: nowIso(),
  ...extra,
});

const firstOfNextMonth = (() => {
  const [y, m] = today.split('-').map(Number);
  return new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 10);
})();

const tasks = [
  task('admin', 'Send invoice to Acme', {
    due: addDays(today, -2),
    tags: ['finance'],
    source: { key: 'gmail:18f2a', label: 'Email', url: '#' },
  }),
  task('admin', 'Pay rent', { due: firstOfNextMonth, repeat: parseRepeat('every month on the 1st') }),
  task('admin', 'Submit expense report', { due: addDays(today, 3), tags: ['finance'] }),
  task('admin', 'Renew passport', { tags: ['errand'] }),
  task('admin', 'Reply to landlord', { status: 'done', completed: nowIso() }),
  task('thundercloud', 'Fix login redirect loop', {
    due: today,
    tags: ['deep-work'],
    source: { key: 'linear:RM-12', label: 'RM-12', url: '#' },
  }),
  task('thundercloud', 'Review dock quote PR', {
    due: addDays(today, 4),
    source: { key: 'linear:RM-14', label: 'RM-14', url: '#' },
  }),
  task('thundercloud', 'Write migration plan for pricing tables', { tags: ['deep-work'] }),
  task('thundercloud', 'Post standup notes', { status: 'done', completed: nowIso() }),
  task('prodev', 'Read for 30 minutes', { due: today, repeat: parseRepeat('weekdays') }),
  task('prodev', 'Rails course, chapter 4', { due: addDays(today, 1) }),
  task('prodev', 'Outline lunch & learn talk', { due: addDays(today, 9), tags: ['writing'] }),
  task('personal', 'Groceries', { due: today, tags: ['errand'] }),
  task('personal', 'Call mom', { due: addDays(today, (7 - weekday(today)) % 7 || 7), repeat: parseRepeat('every sunday') }),
  task('personal', 'Book dentist appointment', { due: addDays(today, 6) }),
  task('personal', 'Replace bike tire', { tags: ['errand'] }),
];

const ui = {
  filter: 'all',
  tag: '',
  activeCategory: categories[0].id,
  showDone: new Set(),
  addingIn: null,
  addingCategory: false,
  editingId: null,
  undo: null,
};

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
  h('span', { class: 'material-symbols-outlined icon icon--weight-light', 'aria-hidden': 'true' }, name);

const shortDate = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
const weekdayName = new Intl.DateTimeFormat('en-US', { weekday: 'short', timeZone: 'UTC' });
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

const endOfWeek = addDays(today, (7 - weekday(today)) % 7);

function matchesFilter(t) {
  if (ui.tag && !t.tags.includes(ui.tag)) return false;
  if (ui.filter === 'all') return true;
  if (!t.due) return false;
  if (ui.filter === 'overdue') return t.due < today;
  if (ui.filter === 'today') return t.due <= today;
  if (ui.filter === 'week') return t.due <= endOfWeek;
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

const sourceIcon = (key) => (key.startsWith('linear') ? 'change_history' : key.startsWith('slack') ? 'tag' : 'mail');

// region render

function isoWeek(date) {
  const d = utc(date);
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = Date.UTC(d.getUTCFullYear(), 0, 1);
  return Math.ceil(((d - yearStart) / 86400000 + 1) / 7);
}

const filterNames = { all: 'All', today: 'Today', week: 'This week', overdue: 'Overdue' };

function counts() {
  const open = tasks.filter((t) => t.status === 'open');
  return {
    due: open.filter((t) => t.due === today).length,
    overdue: open.filter((t) => t.due && t.due < today).length,
  };
}

const NUMBER_WORDS = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];
const inWords = (n) => NUMBER_WORDS[n] ?? String(n);
const capitalize = (text) => text.charAt(0).toUpperCase() + text.slice(1);

function deck() {
  const { due, overdue } = counts();
  const done = tasks.filter(doneToday).length;
  const parts = [due ? `${inWords(due)} due today` : 'nothing due today'];
  if (overdue) parts.push(h('em', {}, `${inWords(overdue)} overdue`));
  if (done) parts.push(`${inWords(done)} already done`);
  parts[0] = capitalize(parts[0]);
  const nodes = parts.flatMap((part, i) => (i === 0 ? [part] : [i === parts.length - 1 ? ' and ' : ', ', part]));
  return [...nodes, '.'];
}

function renderHeader() {
  $('#deck').replaceChildren(...deck());
  $('#dateline').textContent = `Week ${isoWeek(today)} · ${today.slice(0, 4)}`;
  $('#crumbs').textContent = ['Tasks', 'Board', filterNames[ui.filter] + (ui.tag ? ` #${ui.tag}` : '')].join(' / ');

  $('#today-label').replaceChildren(
    new Intl.DateTimeFormat('en-US', { weekday: 'long', timeZone: 'UTC' }).format(utc(today)),
    h(
      'span',
      { class: 'masthead__date' },
      new Intl.DateTimeFormat('en-US', { month: 'long', day: 'numeric', timeZone: 'UTC' }).format(utc(today))
    )
  );

  renderTagMenu();
}

const tagDot = (tag) =>
  h('span', { class: `tag-dot${tag ? '' : ' tag-dot--none'}`, style: tag ? `--td-tag-mix: ${tagMix(tag)}%` : null });

function renderTagMenu() {
  const open = tasks.filter((t) => t.status === 'open');
  const tagCounts = new Map();
  for (const t of open) for (const tag of t.tags) tagCounts.set(tag, (tagCounts.get(tag) || 0) + 1);
  const allTags = [...new Set(tasks.flatMap((t) => t.tags))].sort(
    (a, b) => tagMix(b) - tagMix(a) || a.localeCompare(b)
  );

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
    h('div', { class: 'tag-menu__divider', role: 'separator' }),
    ...allTags.map((tag) => option(tag, tag, tagCounts.get(tag) || 0))
  );
  $('#tag-menu-label').textContent = ui.tag || 'Tags';
  $('#tag-menu-icon').replaceChildren(ui.tag ? tagDot(ui.tag) : icon('sell'));
}

function renderTabs() {
  $('#category-tabs').replaceChildren(
    ...categories.map((c) => {
      const count = tasks.filter((t) => t.category === c.id && t.status === 'open').length;
      return h(
        'button',
        {
          type: 'button',
          class: `category-tabs__tab${c.id === ui.activeCategory ? ' category-tabs__tab--active' : ''}`,
          onclick: () => {
            ui.activeCategory = c.id;
            render();
          },
        },
        c.name,
        h('span', { class: 'category-tabs__count' }, String(count))
      );
    })
  );
}

function renderCard(t) {
  const due = dueInfo(t.due);
  const done = t.status === 'done';
  const meta = h(
    'div',
    { class: 'task-card__meta' },
    t.tags.map((tag) =>
      h('span', { class: 'task-card__meta-item task-card__tag', style: `--td-tag-mix: ${tagMix(tag)}%` }, tag)
    ),
    due &&
      !done &&
      h(
        'span',
        { class: `task-card__meta-item${due.state ? ` task-card__meta-item--${due.state}` : ''}` },
        icon('calendar_today'),
        due.label
      ),
    t.repeat && h('span', { class: 'task-card__meta-item' }, icon('repeat'), describeRepeat(t.repeat)),
    t.source &&
      h(
        'a',
        {
          class: 'task-card__meta-item',
          href: t.source.url,
          target: '_blank',
          rel: 'noopener',
          onclick: (e) => e.stopPropagation(),
        },
        icon(sourceIcon(t.source.key)),
        t.source.label
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
        if (e.key === 'Enter' && !done) openEditor(t.id);
      },
      ondragstart: (e) => {
        e.dataTransfer.setData('text/plain', t.id);
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
    h('div', { class: 'task-card__body' }, h('p', { class: 'task-card__title' }, h('span', { class: 'task-card__strike' }, t.title)), done ? null : meta)
  );
  return card;
}

function startAdding(categoryId) {
  ui.addingIn = categoryId;
  render();
  $(`[data-add-input="${categoryId}"]`)?.focus();
}

function renderAddForm(c) {
  return h(
    'form',
    {
      class: 'board-column__add-form',
      onsubmit: (e) => {
        e.preventDefault();
        const input = e.target.elements.title;
        const { title, tags } = parseTitle(input.value);
        if (title) tasks.push(task(c.id, title, { tags }));
        input.value = '';
        startAdding(c.id);
      },
    },
    h('input', {
      class: 'board-column__add-input',
      name: 'title',
      placeholder: 'Task title, #tags',
      autocomplete: 'off',
      dataset: { addInput: c.id },
      onkeydown: (e) => {
        if (e.key === 'Escape') {
          ui.addingIn = null;
          render();
        }
      },
      onblur: (e) => {
        if (!e.target.value) {
          ui.addingIn = null;
          setTimeout(render);
        }
      },
    })
  );
}

function renderColumn(c) {
  const open = tasks.filter((t) => t.category === c.id && t.status === 'open').sort(sortCards);
  const done = tasks.filter((t) => t.category === c.id && doneToday(t));
  const showingDone = ui.showDone.has(c.id);

  const column = h(
    'section',
    {
      class: `board-column${c.id === ui.activeCategory ? ' board-column--active' : ''}`,
      'aria-label': c.name,
      dataset: { category: c.id },
      ondragover: (e) => {
        e.preventDefault();
        column.classList.add('board-column--drop-target');
      },
      ondragleave: (e) => {
        if (!column.contains(e.relatedTarget)) column.classList.remove('board-column--drop-target');
      },
      ondrop: (e) => {
        e.preventDefault();
        column.classList.remove('board-column--drop-target');
        const moved = tasks.find((t) => t.id === e.dataTransfer.getData('text/plain'));
        if (moved && moved.category !== c.id) {
          const snapshot = structuredClone(moved);
          moved.category = c.id;
          toast(`Moved to ${c.name}`, () => Object.assign(moved, snapshot));
          render();
        }
      },
    },
    h(
      'header',
      { class: 'board-column__header' },
      h('h2', { class: 'board-column__name', title: c.name }, c.name),
      h('span', { class: 'board-column__count', 'aria-label': `${open.length} open` }, String(open.length)),
      h(
        'span',
        { class: 'board-column__sub label' },
        done.length ? `${done.length} done today` : open.length ? 'Open' : 'Clear'
      )
    ),
    h(
      'div',
      { class: 'board-column__cards' },
      open.map(renderCard),
      !open.length && ui.addingIn !== c.id && h('p', { class: 'board-column__empty' }, 'No tasks'),
      ui.addingIn === c.id && renderAddForm(c),
      showingDone && done.map((t) => renderCard({ ...t, status: 'done' }))
    ),
    h(
      'footer',
      { class: 'board-column__footer' },
      ui.addingIn !== c.id &&
        h(
          'button',
          { class: 'quiet-button', type: 'button', onclick: () => startAdding(c.id) },
          icon('add'),
          'Add task'
        ),
      done.length > 0 &&
        h(
          'button',
          {
            class: 'quiet-button',
            type: 'button',
            'aria-expanded': String(showingDone),
            onclick: () => {
              if (showingDone) ui.showDone.delete(c.id);
              else ui.showDone.add(c.id);
              render();
            },
          },
          icon(showingDone ? 'expand_less' : 'check'),
          showingDone ? 'Hide done' : `${done.length} done today`
        )
    )
  );
  return column;
}

function renderGhostColumn() {
  const body = ui.addingCategory
    ? h(
        'form',
        {
          class: 'board-column__add-form',
          onsubmit: (e) => {
            e.preventDefault();
            const name = e.target.elements.name.value.trim();
            if (name) {
              const id = name.toLowerCase().replace(/\W+/g, '-');
              categories.push({ id, name });
              ui.activeCategory = id;
            }
            ui.addingCategory = false;
            render();
          },
        },
        h('input', {
          class: 'board-column__add-input',
          name: 'name',
          placeholder: 'Category name',
          autocomplete: 'off',
          dataset: { newCategory: '' },
          onkeydown: (e) => {
            if (e.key === 'Escape') {
              ui.addingCategory = false;
              render();
            }
          },
        })
      )
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
        icon('add'),
        'Add category'
      );
  return h('section', { class: 'board-column board-column--ghost' }, h('header', { class: 'board-column__header' }, body));
}

function render() {
  renderHeader();
  renderTabs();
  $('#board').replaceChildren(...categories.map(renderColumn), renderGhostColumn());
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

function complete(id, card) {
  const t = tasks.find((x) => x.id === id);
  const snapshot = structuredClone(t);
  foldAway(card).then(() => {
    if (t.repeat) {
      let next = t.due || today;
      do next = nextOccurrence(next, t.repeat);
      while (next <= today);
      t.prevDue = t.due;
      t.due = next;
      t.lastDone = nowIso();
      toast(`Completed · next ${dueInfo(next).label.toLowerCase()}`, () =>
        Object.assign(t, snapshot, { lastDone: undefined })
      );
    } else {
      t.status = 'done';
      t.completed = nowIso();
      toast('Completed', () => Object.assign(t, snapshot));
    }
    render();
  });
}

function reopen(id) {
  const t = tasks.find((x) => x.id === id);
  if (t.repeat) {
    t.due = t.prevDue ?? t.due;
    delete t.lastDone;
    delete t.prevDue;
  } else {
    t.status = 'open';
    delete t.completed;
  }
  render();
}

let toastTimer;
function toast(text, undo) {
  ui.undo = undo;
  $('#toast-text').textContent = text;
  $('#toast-undo').hidden = !undo;
  $('#toast').hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => ($('#toast').hidden = true), 5000);
}

$('#toast-undo').addEventListener('click', () => {
  ui.undo?.();
  ui.undo = null;
  $('#toast').hidden = true;
  render();
});

// region editor

const presetFor = (repeat) => {
  if (!repeat) return '';
  const key = (r) => `${r.every}|${r.unit}|${(r.weekdays || []).join(',')}`;
  const presets = ['daily', 'weekdays', 'weekly', 'biweekly', 'monthly', 'yearly'];
  return presets.find((p) => key(parseRepeat(p)) === key(repeat)) ?? 'custom';
};

function openEditor(id) {
  const t = tasks.find((x) => x.id === id);
  ui.editingId = id;
  const form = $('#editor-form');
  form.elements.title.value = t.title;
  form.elements.notes.value = t.notes || '';
  form.elements.due.value = t.due || '';
  form.elements.tags.value = t.tags.join(', ');
  form.elements.category.replaceChildren(
    ...categories.map((c) => h('option', { value: c.id, selected: c.id === t.category }, c.name))
  );
  const repeat = form.elements.repeat;
  repeat.querySelector('[value="custom"]')?.remove();
  const preset = presetFor(t.repeat);
  if (preset === 'custom') repeat.append(h('option', { value: 'custom' }, describeRepeat(t.repeat)));
  repeat.value = preset;

  $('#editor-crumb').textContent = categories.find((c) => c.id === t.category)?.name ?? '';
  $('#editor-source').replaceChildren(
    ...(t.source ? ['From ', h('a', { href: t.source.url, target: '_blank', rel: 'noopener' }, t.source.key)] : [])
  );

  $('#editor').classList.add('modal-wrapper--active');
  $('#editor').setAttribute('aria-hidden', 'false');
  setTimeout(() => form.elements.title.focus(), 50);
}

function closeEditor() {
  $('#editor').classList.remove('modal-wrapper--active');
  $('#editor').setAttribute('aria-hidden', 'true');
  ui.editingId = null;
}

$('#editor-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const t = tasks.find((x) => x.id === ui.editingId);
  const f = e.target.elements;
  t.title = f.title.value.trim() || t.title;
  t.notes = f.notes.value.trim();
  t.category = f.category.value;
  t.tags = f.tags.value
    .split(',')
    .map((s) => s.trim().replace(/^#/, '').toLowerCase())
    .filter(Boolean);
  t.due = f.due.value || null;
  if (f.repeat.value !== 'custom') t.repeat = f.repeat.value ? parseRepeat(f.repeat.value) : null;
  if (t.repeat && !t.due) t.due = today;
  ui.activeCategory = t.category;
  closeEditor();
  render();
});

$('#editor-delete').addEventListener('click', () => {
  const index = tasks.findIndex((x) => x.id === ui.editingId);
  const [removed] = tasks.splice(index, 1);
  closeEditor();
  toast('Deleted', () => tasks.splice(index, 0, removed));
  render();
});

document.querySelectorAll('#editor [data-close]').forEach((el) => el.addEventListener('click', closeEditor));
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && ui.editingId) closeEditor();
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
  if (e.newState === 'open') (tagOptions().find((o) => o.dataset.tag === ui.tag) || tagOptions()[0]).focus();
});

tagMenu.addEventListener('keydown', (e) => {
  const options = tagOptions();
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

render();
