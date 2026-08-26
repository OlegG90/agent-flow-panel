# Panel

Live flowchart of the session in the browser: step tree on the left (60%), selected step details on the right (40%, sticky). Dark theme, states shown by color/badge.

## Server

`src/server/panel-server.ts`:
- `GET /` → `renderPanelHtml(getTree())` (full HTML with `STYLES` + `CLIENT_SCRIPT`)
- `GET /data` → `JSON FlowTree`
- `GET /events` → SSE (`Content-Type: text/event-stream`, `: connected` + `data: <renderFlowHtml>` on each `publish()`)
- Port `0` → random `http://127.0.0.1:<port>/`, `publish()` is a no-op without clients and tolerates dead sockets

Opened via `execFile("cmd /c start")` / `open` / `xdg-open` from `openInBrowser`, but a failure to open does not crash the server — the URL is still returned.

## Render

`src/flow/render.ts`:
- `walk(node, leaf)` recursively, `textLeaf` (for `flow_tree`) and `htmlLeaf` (for panel)
- `truncate` 80 (text) / 120 (html), `escapeHtml`/`attrEscape` (XSS, `&#10;` for SSE)
- `data-id`/`data-type`/`data-state`/`data-content`/`data-reasoning` on `<li>` — for collapse and details
- `Plan` chips above `steps`: `pending` grey, `in-progress` yellow, `completed` green
- Types → CSS: `step--user-request` blue, `model-call` purple, `tool-call` yellow, `orchestration` grey dashed 0.6, `subtask` purple background

Client (`CLIENT_SCRIPT`):
- `EventSource("/events")` replaces `#flow` innerHTML (single-line `renderFlowHtml` for SSE)
- `collapsed: Set<id>` keeps collapsed nodes between updates, `selectedId` — highlight `step--selected` + details panel

## Static previews

`npm run panel:fixture` (`scripts/render-fixture.ts`) generates from `fixtures/*.json`:
- `docs/previews/panel-preview-subagent-session.html` — one sub-agent expanded
- `docs/previews/panel-preview-subagent-summary.html` — >3 sub-agents → `summary`

Fixtures: `fixtures/subagent-session.json`, `subagent-summary.json`. Preview HTML is committed in `docs/previews/` (only `/panel-preview-*.html` at the repo root is ignored via `.gitignore`).

## Limitations

- Localhost only, no auth (`/data` is open to any local process).
- `structuredClone` requires Node ≥17.
