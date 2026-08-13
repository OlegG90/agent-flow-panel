# 01 — Plugin skeleton with Panel command

**What to build:** OpenCode loads this repo as a server plugin. A slash command opens the Panel — for now a stub page that proves the plugin runs end to end. The plugin packaging (server entry), local dev config, a test runner, and a typecheck/lint step are wired so later tickets land on a green base.

**Blocked by:** None — can start immediately.

**Status:** resolved

- [x] OpenCode loads the plugin from this repo without errors
- [x] A slash command is registered and invocable inside a session
- [x] The command opens the Panel stub (placeholder page)
- [x] Test runner, typecheck and lint run green

## Comments

Verified live: `opencode run "/flow"` invoked the command; the agent called the `flow_panel` tool, which opened the Panel stub in the default browser. Local checks green: `npm run typecheck`, `npm run lint`, `npm test` (1 test).
