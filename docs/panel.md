# Panel

Live flowchart of the session in the browser: step tree on the left (60%), selected step details on the right (40%, sticky). Dark theme, states shown by color/badge.

## Server

`src/server/panel-server.ts`:
- Every route requires the per-run access token: `?t=<token>`; without it → `401`. `url(path?)` builds a tokenized URL (`url()` → `/?t=…`, `url("data")` → `/data?t=…`).
- `GET /` → `renderPanelHtml(getTree())` (full HTML with the stylesheet and client script inlined)
- `GET /data` → `JSON FlowTree`
- `GET /node?id=<id>` → one step's full `content`/`reasoning` (looked up on the collapsed tree, so it agrees with what was rendered); `404` for an unknown id
- `GET /export` → the standalone snapshot as `attachment; filename="agent-flow.html"`
- `GET /events` → SSE (`Content-Type: text/event-stream`, `: connected` + `data: <renderFlowHtml>` on each `publish()`)
- Port `0` → random `http://127.0.0.1:<port>/?t=<token>`, `publish()` is a no-op without clients, tolerates dead sockets, and coalesces frames on a leading+trailing window (`coalesceMs`, default 120ms; `0` disables)

Opened via `execFile("cmd /c start")` / `open` / `xdg-open` from `openInBrowser`, but a failure to open does not crash the server — the URL is still returned.

## Render

`src/flow/render.ts` (tree rendering and page assembly; the stylesheet lives in `panel-styles.ts` and the browser half in `panel-client.ts`):
- `collapseTurn` merges each `ModelCall` with its single `ModelReply` before walking (display only — the domain keeps both; the `ModelCall` id is preserved so collapse/selection survive)
- `walk(node, leaf)` recursively, `textLeaf` (for `flow_tree`) and `htmlLeaf` (for panel)
- `metrics(node)` → duration / `1.2k→380 tok (900 cached)` / `$0.0042` badges, each with a `title` explaining it on hover; `unitSummary` totals them per unit in the heading. Nodes without reported metrics render unchanged.

**Reading a token badge.** `2→816 tok (44.6k cached)` is *not* "2 tokens in". Providers
report `input` as the tokens the model had to read fresh, counting anything served from
the prompt cache separately — so that call actually took ~44.6k tokens of context and
generated 816. The hover text spells the whole split out, cache writes included.

**Metrics by platform.** OpenCode and Claude Code report token counts; Pi and omp
report none, so their steps carry duration only. Duration is exact on OpenCode and
Claude Code, and the wall clock the extension observes on Pi.
- `truncate` 80 (text) / 120 (html), `escapeHtml`/`attrEscape` (XSS, `&#10;` for SSE)
- `data-id`/`data-type`/`data-state` on `<li>`, plus `data-detail="1"` when the node has content worth fetching. Full content is **not** in the frame — the details pane fetches `/node`. The static export inlines `data-content`/`data-reasoning` instead, since a saved page has no server.
- `Plan` chips above `steps`: `pending` grey, `in-progress` yellow, `completed` green. Plan items still to be started are also previewed inline as dashed `planned` nodes at the tail of the unit — completed and in-progress ones are not, their work is already visible as real steps.
- Types → CSS: `step--user-request` blue, `model-call` purple, `tool-call` yellow, `orchestration` grey dashed 0.6, `subtask` purple background

Client (`src/flow/panel-client.ts`, behaviour covered by `panel-client.test.ts` driving the real page in jsdom):
- `EventSource("/events" + location.search)` (carries the token) replaces `#flow` innerHTML (single-line `renderFlowHtml` for SSE)
- `collapsed: Set<id>` keeps collapsed nodes between updates, `selectedId` — highlight `step--selected` + details panel
- Details are fetched on select and refetched only when the selection or that step's `data-state` changes
- Toolbar: text filter over labels/previews (`step--hit` / `step--hidden`, ancestors of a hit stay visible, `filtering` forces collapsed ancestors open), `Failed only`, `Follow` (scrolls to the last running step), `Collapse all` / `Expand all`, `Export`
- `clientScript(live)`: the export omits the event-stream block entirely (`LIVE = false`) and reads details from inlined attributes

## Static previews

`npm run panel:fixture` (`scripts/render-fixture.ts`) generates the standalone export page from `scripts/fixtures/*.json`, so the committed previews are interactive offline:
- `docs/previews/panel-preview-subagent-session.html` — one sub-agent expanded
- `docs/previews/panel-preview-subagent-summary.html` — >3 sub-agents → `summary`

Fixtures live next to the generator that is their only consumer: `scripts/fixtures/subagent-session.json`, `subagent-summary.json`. Preview HTML is committed in `docs/previews/` (only `/panel-preview-*.html` at the repo root is ignored via `.gitignore`).

## Limitations

- Localhost only. Access is gated by a random 128-bit token in the URL, regenerated per panel server, so another local process cannot read `/data` without the link. The token lives in the query string, so it also lands in browser history.
- `structuredClone` requires Node ≥17.
