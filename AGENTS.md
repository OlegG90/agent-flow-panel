# AGENTS.md

## Status

A **TypeScript plugin** that visualizes an agent's work as a live flowchart panel, running on **OpenCode**, **Claude Code**, **Pi** and **oh-my-pi / omp** from one codebase. Released as `v0.2.0`. Domain model: `CONTEXT.md`. Design decisions: `docs/adr/`. Architecture: `docs/architecture.md`.

## Working here

- Dev commands: `npm run typecheck`, `npm run lint`, `npm test` (node built-in test runner, `.ts` run via Node type stripping).
- The plugin is loaded from the project via `opencode.json` → `"plugin": ["./src/server.ts"]`. Plugin module contract: one default export serving both APIs (verified against OpenCode 1.18.16 and 2.2.3).
  - OpenCode 1.x calls `server()` — `tool()` helper and types from `@opencode-ai/plugin`; V1 events (`message.part.updated`, …) feed `adapters/opencode/reducer.ts`.
  - OpenCode 2.x reads `id` + `setup(ctx)` — types from `@opencode/plugin` (type-only, dev dependency); tools via `ctx.tool.transform` with `codemode: false`, events via `ctx.event.subscribe` feed `adapters/opencode/v2-reducer.ts`. 2.x loads local plugins only from a directory path, not a `.ts` file. API docs: `services/www/src/docs/content/build/plugins/{server,migrate-v1}.mdx` in `anomalyco/opencode`.
- Headless verification on Windows: pipe `opencode run` output through `Start-Process` with redirected files — piping straight into PowerShell `Select-String` hangs.
- Before adding plugin/config files, load the `customize-opencode` skill (built-in) for the current OpenCode plugin, config, and agent conventions — do not guess the plugin API from memory.
- Keep commits scoped and conventional.
- Windows environment (PowerShell 5.1): prefer `;` / `if ($?)` for chaining commands; avoid `&&` in shell instructions.

## Agent skills

### Issue tracker

Issues live as local markdown files under `.scratch/<feature-slug>/`. See `docs/agents/issue-tracker.md`.

### Triage labels

Default five-role vocabulary (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `CONTEXT.md` at root + `docs/adr/`. See `docs/agents/domain.md`.
