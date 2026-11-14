# CLAUDE.md

@AGENTS.md

## Claude Code specifics
- **Cloud sessions (claude.ai/code):** the environment's Setup script should be `bash scripts/setup.sh` (installs packages, test browser, builds). `.claude/settings.json` adds a SessionStart hook (`scripts/session-start.sh`) that re-syncs `node_modules` in cloud sessions only.
- **Workflow the owner prefers:** plan first (short design note or PRD chapter for anything non-trivial), then build in small steps, then run `npm run typecheck` and `npm test` before saying a task is done.
- **Before claiming a feature works:** run the relevant test in `tests/` and look at the saved PDF (tests use pypdfium2 to extract text / render pages).
- Commit with clear messages; never commit `dist/`, `node_modules/`, `tests/out/` or `desktop/app/`.
