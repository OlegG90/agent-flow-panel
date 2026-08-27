# Agent Flow Panel

Plugin that visualizes agent work as a **live flowchart in the browser**: step tree on the left, selected step details on the right. A single codebase runs on **OpenCode**, **Claude Code**, **Pi**, and **oh-my-pi / omp**.

![Panel preview — sub-agent session](docs/previews/panel-preview-subagent-session.html)
> Static previews: [`docs/previews/panel-preview-subagent-session.html`](docs/previews/panel-preview-subagent-session.html) · [`docs/previews/panel-preview-subagent-summary.html`](docs/previews/panel-preview-subagent-summary.html) (generated from `scripts/fixtures/`)

## What it is

Every step carries its duration, and OpenCode and Claude Code add token counts — hover a badge to see how to read it, since `input` counts only the tokens that were not served from cache. OpenCode is the only platform that reports a cost field at all, and it reads `0` wherever the provider does not bill per message, so the cost badge often never appears. Each human request is a **Unit of Work** — a tree `UserRequest → ModelCall → ModelReply → ToolCall → ToolResult → Answer`. On OpenCode and Pi, sub-agents expand under their `ToolCall{subtask}` and >3 collapse into `Sub-agent summary`; Claude Code records none of their steps, so the launch node carries a run summary instead. Harness work — an empty `oh-my-pi` turn, a Claude Code compaction or API error — becomes `Orchestration` (dashed). The panel updates via SSE without reload.

Details: [`docs/concepts.md`](docs/concepts.md) (step types, states), original glossary — [`CONTEXT.md`](CONTEXT.md).

## Quick start

```sh
npm install
npm run build   # → dist/server.js (OpenCode) + dist/extension.js (Pi/omp) + dist/mcp.js (Claude Code)
```

| Agent | How to connect |
|---|---|
| **OpenCode** | `opencode.json` → `"plugin": ["./src/server.ts"]` (dev) or `"plugin": ["file:///…/dist/server.js"]` |
| **Claude Code** | `claude mcp add flow-panel -- node /…/dist/mcp.js` (MCP server, reads the session transcript) |
| **Pi** | `pi -e C:/path/to/dist/extension.js` or `~/.pi/agent/extensions/` |
| **omp** | `omp -e C:/path/to/dist/extension.js` (recommended) or `omp plugin link` |

Full guide: [`docs/installation.md`](docs/installation.md) · Architecture: [`docs/architecture.md`](docs/architecture.md) · Panel: [`docs/panel.md`](docs/panel.md) · ADRs: [`docs/adr/`](docs/adr/) · API research: [`docs/opencode-plugin-system-research.md`](docs/opencode-plugin-system-research.md)

## Usage

- `/flow` / `flow_open` — open panel (keep history)
- `/flow-reset` / `flow_panel` — open from scratch
- `/flow_tree` / `flow_tree` — text tree in chat

Panel: `http://127.0.0.1:<port>/?t=<token>` (`/` HTML, `/data` JSON, `/node?id=` one step, `/export` standalone snapshot, `/events` SSE — all require the token). Click `step-label` for details, `▾` to collapse; the toolbar filters steps, follows the running one, and exports the flow.

## Development

```sh
npm test            # 179 tests (node --test)
npm run typecheck
npm run lint
npm run panel:fixture  # → docs/previews/panel-preview-*.html
```

Layout: `src/flow/` (shared core — types, render, `BaseSessionTracker`), `src/server/panel-server.ts`, `src/adapters/opencode|claude|pi/`, `src/server.ts` / `src/mcp.ts` / `src/extension.ts`. Agent docs: `AGENTS.md`.
