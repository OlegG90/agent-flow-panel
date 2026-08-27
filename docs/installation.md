# Installation

## OpenCode

**Local (dev, no build):**
```jsonc
// opencode.json
{ "$schema": "https://opencode.ai/config.json", "plugin": ["./src/server.ts"] }
```

**From bundle (prod) or global `~/.config/opencode/opencode.jsonc`:**
```jsonc
{ "plugin": ["file:///C:/absolute/path/dist/opencode/server.js"] }
```

After changes — **restart OpenCode** (config is not hot-reloaded). The plugin provides tools `flow_panel` / `flow_open` / `flow_tree`.

## Claude Code

Claude Code has no plugin event API, so the panel is served by an **MCP server**
that reads the session transcript Claude Code already writes to
`~/.claude/projects/<encoded-cwd>/<session-id>.jsonl`.

```sh
npm run build   # produces dist/claude/mcp.js
claude mcp add flow-panel -s local -- node C:/path/to/dist/claude/mcp.js
```

Or per project, in `.mcp.json` next to the code you are working on:
```json
{ "mcpServers": { "flow-panel": { "command": "node", "args": ["C:/path/to/dist/claude/mcp.js"] } } }
```

The server provides the same `flow_open` / `flow_panel` / `flow_tree` tools as the
other adapters. This repository ships `/flow` and `/flow-tree` commands under
`.claude/commands/`, which call them.

> **Use `-s local`, and here is why it matters.** oh-my-pi reads Claude Code's
> configuration, and this server reads `~/.claude/projects` — so a `flow_open`
> called from omp opens a **Claude Code** panel rather than omp's. Nothing
> breaks; it is simply the wrong agent's flow, silently.
>
> The scope decides who else can see it. Measured by starting omp in the
> project and watching whether it spawns this server:
>
> | Scope | Stored in | Claude Code | omp |
> |---|---|---|---|
> | `user` | `~/.claude.json` → `mcpServers` | sees it | **sees it everywhere** |
> | `project` | `.mcp.json` in the project root | sees it | **sees it in that directory** (`mcp.enableProjectConfig`) |
> | `local` | `~/.claude.json` → `projects[path].mcpServers` | sees it | **does not see it** |
>
> omp walks the top-level `mcpServers` and any `.mcp.json`, but not the nested
> `projects[path]` structure, which is Claude Code's own. For omp's flow, use
> its extension: `omp -e dist/pi/extension.js`.

It deliberately does **not** ship a `.mcp.json`: such a file could only point at
`./dist/claude/mcp.js`, which does not exist until you build, so a fresh clone would get an
entry that prompts for approval and then fails — and registering the server at user
scope as well would put the same name in two scopes, which starts two copies of it.

Two things follow from reading a file rather than a stream:

- **It works on finished sessions.** Whatever the newest transcript for the
  working directory is, the panel will show it — including yesterday's.
- **Updates are per message, not per token.** A transcript line is written when a
  message completes, so steps appear as they finish.
- **Harness events show up as dimmed `Orchestration` nodes** — context
  compaction (with before/after token counts), API errors and their retries,
  model fallbacks. Hook summaries are deliberately not shown: they carry no
  outcome and would add a couple of dozen identical nodes per session.
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
pi -e C:/path/to/dist/pi/extension.js
# single prompt:
pi -e C:/path/to/dist/pi/extension.js -p "hello"
```

**Global:** copy `dist/pi/extension.js` to `~/.pi/agent/extensions/` or add to `~/.pi/agent/settings.json`:
```json
{ "extensions": ["C:/path/to/dist/pi/extension.js"] }
```

## oh-my-pi / omp (can1357/oh-my-pi)

> `omp` uses `~/.omp` (not `~/.pi`) and its own `plugin` manager. The `pi` field in `package.json` is not auto-picked up for `omp` without action.

**A — one-off (recommended):**
```sh
npm run build
omp -e C:/path/to/dist/pi/extension.js
omp -e C:/path/to/dist/pi/extension.js -p "hello"
```
Inside TUI: `/flow` (keep), `/flow-reset` (reset from scratch), `/flow_tree` or tools `flow_panel`/`flow_open`/`flow_tree`.

**B — permanent (requires Developer Mode / admin for symlink):**
```sh
omp plugin link "C:/path/to/project"  # symlink into ~/.omp/plugins
# if EPERM:
# xcopy /E /I dist C:\Users\<you>\.omp\plugins\flow-panel\dist
# or manually add to ~/.omp/agent/config.yml:
# extensions: ["C:/path/to/dist/pi/extension.js"]
```

Check:
```sh
omp -e C:/path/to/dist/pi/extension.js -p "echo hi" 2>&1 | findstr flow
# in TUI: /help should list /flow, /flow-reset
```

## Build & development

**Node versions.** `package.json` declares `engines: { node: ">=22.18" }`, which is what
*this repository* needs: `npm test` and `npm run panel:fixture` run `.ts` files directly,
and unflagged type stripping landed in 22.18. The **built bundles** are plain JavaScript
and only need **Node ≥ 17** (for `structuredClone`), so an agent on an older runtime can
still load them.

```sh
npm install
npm run build          # → dist/opencode/server.js + dist/claude/mcp.js + dist/pi/extension.js
npm test               # node --test src/**/*.test.ts (188 tests)
npm run typecheck
npm run lint
npm run panel:fixture  # → docs/previews/panel-preview-*.html
```
