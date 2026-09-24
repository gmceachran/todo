#!/bin/sh
cd "$(dirname "$0")"
{
  echo '(() => {'
  sed -E 's/^export //' ../core.js
  sed -E '/^import .* from /d' board.js
  echo '})();'
} > board.bundle.js
