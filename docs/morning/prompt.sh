#!/bin/sh
set -e
cd "$(dirname "$0")"
cat <<'HEADER'
Run my morning brief. This is an unattended scheduled run: don't ask questions. Don't use the anthropic-skills:morning skill; the instructions below replace it.

Setup, in the cloud shell. Run the clone once, and start every shell call that uses the CLI with the export line:

  export GITHUB_TOKEN="PASTE_TOKEN_HERE" TODO_TZ=America/New_York
  git clone --depth 1 https://github.com/gmceachran/todo.git "$HOME/todo"

HEADER
awk 'NR == 1 && /^---$/ { front = 1; next } front && /^---$/ { front = 0; next } !front' SKILL.md
