# Agent Flow Panel

Plugin that visualizes agent work as a **live flowchart in the browser**: step tree on the left, selected step details on the right. A single codebase runs on **OpenCode**, **Pi**, and **oh-my-pi / omp**.

![Panel preview — sub-agent session](docs/previews/panel-preview-subagent-session.html)
> Static previews: [`docs/previews/panel-preview-subagent-session.html`](docs/previews/panel-preview-subagent-session.html) · [`docs/previews/panel-preview-subagent-summary.html`](docs/previews/panel-preview-subagent-summary.html) (generated from `fixtures/`)

## What it is

Each human request is a **Unit of Work** — a tree `UserRequest → ModelCall → ModelReply → ToolCall → ToolResult → Answer`. Sub-agents expand under their `ToolCall{subtask}`, >3 collapse into `Sub-agent summary`, empty `oh-my-pi` turns become `Orchestration` (dashed). The panel updates via SSE without reload.

Details: [`docs/concepts.md`](docs/concepts.md) (step types, states), original glossary — [`CONTEXT.md`](CONTEXT.md).

## Quick start

```sh
npm install
npm run build   # → dist/server.js (OpenCode) + dist/extension.js (Pi/omp)
```

| Agent | How to connect |
|---|---|
| **OpenCode** | `opencode.json` → `"plugin": ["./src/server.ts"]` (dev) or `"plugin": ["file:///…/dist/server.js"]` |
| **Pi** | `pi -e C:/path/to/dist/extension.js` or `~/.pi/agent/extensions/` |
| **omp** | `omp -e C:/path/to/dist/extension.js` (recommended) or `omp plugin link` |

Full guide: [`docs/installation.md`](docs/installation.md) · Architecture: [`docs/architecture.md`](docs/architecture.md) · Panel: [`docs/panel.md`](docs/panel.md) · ADRs: [`docs/adr/`](docs/adr/) · API research: [`docs/opencode-plugin-system-research.md`](docs/opencode-plugin-system-research.md)

## Usage

- `/flow` / `flow_open` — open panel (keep history)
- `/flow-reset` / `flow_panel` — open from scratch
- `/flow_tree` / `flow_tree` — text tree in chat

Panel: `http://127.0.0.1:<port>/?t=<token>` (`/` HTML, `/data` JSON, `/events` SSE — all require the token). Click `step-label` for details, `▾` to collapse.

## Development

```sh
npm test            # 90 tests (node --test)
npm run typecheck
npm run lint
npm run panel:fixture  # → docs/previews/panel-preview-*.html
```

Layout: `src/flow/` (shared core — types, render, `BaseSessionTracker`), `src/server/panel-server.ts`, `src/adapters/opencode|pi/`, `src/server.ts` / `src/extension.ts`. Agent docs: `AGENTS.md`.
