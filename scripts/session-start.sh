#!/usr/bin/env bash
# SessionStart hook (see .claude/settings.json). In Claude Code cloud sessions, make sure node_modules
# matches package-lock.json (cheap when nothing changed). Does nothing on your own computer.
[ "${CLAUDE_CODE_REMOTE:-}" = "true" ] || exit 0
cd "${CLAUDE_PROJECT_DIR:-.}" || exit 0
stamp=node_modules/.lock.sha256
if ! sha256sum --check --status "$stamp" 2>/dev/null; then
  rm -f "$stamp"
  npm ci --no-audit --no-fund >/dev/null 2>&1 && sha256sum package-lock.json > "$stamp"
fi
exit 0
