#!/bin/sh
set -e
cd "$(dirname "$0")"

strip() {
  perl -0pe "s/^import\s[^;]*?from\s+'[^']+';\n//gm; s/^export //gm" "$1"
}

{
  echo '(() => {'
  strip ../core.js
  strip ../store.js
  strip ../demo.js
  strip ../app.js | perl -pe "s/^const DEMO = .*;\$/const DEMO = true;/; s/'serviceWorker' in navigator &&/false &&/"
  echo '})();'
} > board.bundle.js

grep -q '^const DEMO = true;$' board.bundle.js || { echo 'build.sh: could not force demo mode' >&2; exit 1; }

sed -E \
  -e 's|<title>[^<]*</title>|<title>Todo Board Mockup</title>|' \
  -e '/rel="manifest"/d' \
  -e 's|(href\|src)="(styles\.css\|icons/)|\1="../\2|g' \
  -e 's|<script type="module" src="app\.js"></script>|<script src="board.bundle.js" defer></script>|' \
  ../index.html > board.html
