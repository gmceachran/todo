# Todo

A personal task board. Plain HTML, CSS and JS, no build step. Served from GitHub Pages; tasks live in a separate private repo.

- **App:** https://gmceachran.github.io/todo/ (add `?demo` to try it with sample data, stored only in that tab)
- **Data:** `tasks.json` in the private `gmceachran/todo-data` repo, read and written through the GitHub Contents API with a fine-grained token (Contents: read and write, that repo only) stored in the browser.

## Using it

- Categories are the columns. Add one at the end of the board; rename by double-clicking its name or from the `⋯` menu, which also moves and deletes them.
- Type `#tag` in a new task's title to tag it. Tags, due dates and repeats are on each card; click a card to edit it.
- Checking off a repeating task moves it to its next date.
- Opening a link from the morning brief (`…/todo/#import=…`) adds the tasks you picked there.
- On a phone, open the app in Safari and choose Share → Add to Home Screen.

## Command line

`cli/tasks.mjs` reads and writes the same `tasks.json` (it uses `$GITHUB_TOKEN` or `gh auth token`):

```sh
node cli/tasks.mjs agenda
node cli/tasks.mjs add "Pay rent" --category Admin --repeat "every month on the 1st" --due 2026-10-01
node cli/tasks.mjs complete source:linear:RM-12
node cli/tasks.mjs --help
```

## Development

```sh
npm test                   # core logic tests (node --test)
npm run serve              # http://localhost:8787/?demo
```
