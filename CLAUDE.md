# Claude Code Orientation

This repository is multi-agent: OpenCode, Codex CLI, and Claude Code all work
here. The canonical agent orientation, conventions, repo rules, and command
reference live in **AGENTS.md** — read it first.

@AGENTS.md

## Claude-Code-specific notes

- Skills for Claude Code live in `.claude/skills/<name>/SKILL.md`. They mirror
  the OpenCode skills under `.opencode/skills/` and the Codex skills under
  `.codex/skills/`. When the same workflow ships to multiple harnesses, keep
  them in sync — substantive changes should be applied to all three.
- MCP servers for Claude Code are declared in `.mcp.json` at repo root.
  Equivalent OpenCode config is in `opencode.json`; equivalent Codex config is
  in `.codex/config.toml`. See the `mcp-setup-and-debug` skill.
- Per-user Claude Code permissions live in `.claude/settings.local.json`
  (gitignored entries belong there). Project-wide settings (when added) belong
  in `.claude/settings.json`.
- GitHub prose written by any agent (PR comments, issue comments, PR
  descriptions) **must** be prefixed with `[AGENT]` — this is a repo rule from
  AGENTS.md and applies equally to Claude Code.
- Do not create commits, force push, or amend unless the user explicitly asks.
  Never bypass git hooks (no `--no-verify`).

## Quick command reference

- `yarn lint:check` / `yarn lint`
- `yarn test` (Jest)
- `yarn build` / `yarn build:web` / `yarn build:all`
- `yarn frontend:dev` (Vite)
- `yarn docs:check` (Docusaurus build gate)
- `yarn test:e2e` / `yarn test:visual`

See AGENTS.md for the full list and for environment, infra, and product
context.
