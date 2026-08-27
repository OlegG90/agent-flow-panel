# Installation

## OpenCode

**Local (dev, no build):**
```jsonc
// opencode.json
{ "$schema": "https://opencode.ai/config.json", "plugin": ["./src/server.ts"] }
```

**From bundle (prod) or global `~/.config/opencode/opencode.jsonc`:**
```jsonc
{ "plugin": ["file:///C:/absolute/path/dist/server.js"] }
```

After changes — **restart OpenCode** (config is not hot-reloaded). The plugin provides tools `flow_panel` / `flow_open` / `flow_tree`.

## Claude Code

Claude Code has no plugin event API, so the panel is served by an **MCP server**
that reads the session transcript Claude Code already writes to
`~/.claude/projects/<encoded-cwd>/<session-id>.jsonl`.

```sh
npm run build   # produces dist/mcp.js
claude mcp add flow-panel -- node C:/path/to/dist/mcp.js
```

Or per project, in `.mcp.json` next to the code you are working on:
```json
{ "mcpServers": { "flow-panel": { "command": "node", "args": ["C:/path/to/dist/mcp.js"] } } }
```

The server provides the same `flow_open` / `flow_panel` / `flow_tree` tools as the
other adapters. This repository ships a `.mcp.json` pointing at its own build, plus
`/flow` and `/flow-tree` commands under `.claude/commands/`.

Two things follow from reading a file rather than a stream:

- **It works on finished sessions.** Whatever the newest transcript for the
  working directory is, the panel will show it — including yesterday's.
- **Updates are per message, not per token.** A transcript line is written when a
  message completes, so steps appear as they finish.
- **Sub-agents show as one node, not a branch.** Claude Code does not record a
  sub-agent's own steps, so the panel shows its brief, its report and its run
  summary (model, duration, tokens, tool count) rather than an expandable tree.
  This is the one place the other adapters go deeper.

`flow_panel` re-resolves the newest transcript, which is what you want after
`/clear` starts a new session; `flow_open` keeps showing the one already loaded.

## Pi (mariozechner/pi-mono)

**One-off (no install):**
```sh
npm run build
pi -e C:/path/to/dist/extension.js
# single prompt:
pi -e C:/path/to/dist/extension.js -p "hello"
```

**Global:** copy `dist/extension.js` to `~/.pi/agent/extensions/` or add to `~/.pi/agent/settings.json`:
```json
{ "extensions": ["C:/path/to/dist/extension.js"] }
```

## oh-my-pi / omp (can1357/oh-my-pi)

> `omp` uses `~/.omp` (not `~/.pi`) and its own `plugin` manager. The `pi` field in `package.json` is not auto-picked up for `omp` without action.

**A — one-off (recommended):**
```sh
npm run build
omp -e C:/path/to/dist/extension.js
omp -e C:/path/to/dist/extension.js -p "hello"
```
Inside TUI: `/flow` (keep), `/flow-reset` (reset from scratch), `/flow_tree` or tools `flow_panel`/`flow_open`/`flow_tree`.

**B — permanent (requires Developer Mode / admin for symlink):**
```sh
omp plugin link "C:/path/to/project"  # symlink into ~/.omp/plugins
# if EPERM:
# xcopy /E /I dist C:\Users\<you>\.omp\plugins\flow-panel\dist
# or manually add to ~/.omp/agent/config.yml:
# extensions: ["C:/path/to/dist/extension.js"]
```

Check:
```sh
omp -e C:/path/to/dist/extension.js -p "echo hi" 2>&1 | findstr flow
# in TUI: /help should list /flow, /flow-reset
```

## Build & development

```sh
npm install
npm run build          # → dist/server.js + dist/extension.js
npm test               # node --test src/**/*.test.ts (148 tests)
npm run typecheck
npm run lint
npm run panel:fixture  # → docs/previews/panel-preview-*.html
```
