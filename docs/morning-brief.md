Run my morning brief. This is an unattended scheduled run: don't ask questions.

In the cloud shell, run this once:

  printf %s "PASTE_TOKEN_HERE" > "$HOME/.todo-token" && chmod 600 "$HOME/.todo-token"
  git clone --depth 1 https://github.com/gmceachran/todo.git "$HOME/todo"

Then read "$HOME/todo/docs/morning/SKILL.md" in full and follow it. It builds on the morning skill (anthropic-skills:morning) and overrides it where they differ.
