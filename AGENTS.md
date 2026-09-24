# Notes for agents

- `core.js` is the single source of truth for the data model and is imported by the browser app, the CLI, and the tests. Every change to `tasks.json` goes through `applyOp`; add new behavior as an op there, with a test in `test/core.test.js`, rather than editing the document directly.
- Ops carry their own `at` and `today` so they can be replayed after a sync conflict; `store.js#commitOps` reloads and reapplies on a 409/422. Recurring `complete` ops include the task's `due` so a replay can't advance a task twice.
- `doc.removed` records source keys of deleted tasks so the brief's Linear sync never re-adds them; `doc.suggested` is the brief's log of Slack/email items it already offered. Neither creates tasks.
- Category matching (`findCategory`) is deliberately loose (case, punctuation, substring) because the morning brief passes Linear project names.
- Import links (`#import=`) come from outside the app: `decodeImport` whitelists fields and caps at 50 tasks, and `normalizeSource` drops any non-http(s) URL. Keep both checks when changing the format.
- `sw.js` caches the app shell network-first; bump `VERSION` when adding files to `SHELL`.
- The app can't be connected to GitHub by an agent (it would mean typing a token). Use `?demo`, which swaps in `demo.js`'s in-memory store and prefixes all localStorage keys with `todo.demo.`.
- `mockups/` holds the approved static design; `mockups/build.sh` bundles it for opening from `file://`. The live app is the root `index.html`.
