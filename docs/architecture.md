# Architecture

## Shared core (60% portable)

- `src/flow/types.ts` — domain (`StepType`, `StepState`, `FlowTree`, `UnitOfWork`, `PlanItem`, `TokenUsage`). `StepNode` carries optional `startedAt`/`endedAt`/`tokens`/`cost`. Unchanged across platforms.
- `src/flow/nodes.ts` — step construction shared by every adapter (`makeNode`, `makeAnswer`) and the node-id prefix contract the panel keys collapse/selection/`/node` off.
- `src/flow/panel-routes.ts` — the paths the server, renderer and client agree on.
- `src/flow/panel-styles.ts` / `src/flow/panel-client.ts` — the panel's stylesheet and its browser half, split out of render.ts so editing the toolbar no longer means editing a string buried in the tree renderer. `panel-client.test.ts` drives the real export page in jsdom, which is what catches cascade and filter regressions.
- `src/server/open-browser.ts` — one `openInBrowser`, shared by all three entry points.
- `src/flow/render.ts` — rendering `renderTree` (text) + `renderPanelHtml`/`renderFlowHtml`/`renderExportHtml` (HTML). Recursive `walk`, `collapseTurn` (ModelCall+ModelReply → one row), `metrics`/`unitSummary` (duration, tokens, cost badges), `truncate` 80/120, `escapeHtml`/`attrEscape`, and page assembly. It pulls `STYLES` and `clientScript(live)` from the panel modules above rather than owning them. `renderExportHtml` renders the same page with content inlined and no stream. Single-line `renderFlowHtml` for SSE.
- `src/flow/tracker.ts` — `BaseSessionTracker<S>`: `stores:Map<sessionID,S>` + `childrenOf:Map<parentID,{id,created}[]>`, `registerChild` (idempotent), `tree`/`compose`/`graft`/`summaryNode` (`MAX_DETAILED_SUBTASKS=3`). Both adapters extend it; only `dispatch` is platform-specific.
- `src/server/panel-server.ts` — `http` + SSE: `GET /` → `renderPanelHtml(getTree())`, `/data` → `JSON`, `/events` → `text/event-stream` (`: connected` + `data: <html>`), `publish()` coalesces frames on a leading+trailing window (`coalesceMs`, default 120ms) and broadcasts to `Set<ServerResponse>`, random port `0`. Routes: `/`, `/data`, `/node?id=`, `/export`, `/events`. Every one is gated by a per-run 128-bit token (`?t=…`, `timingSafeEqual`); `url(path?)` builds tokenized URLs.

## Adapters — thin isolation

```
src/
  flow/            # shared: types, nodes, render, panel-{routes,styles,client}, tracker
  server/          # panel-server, open-browser
  adapters/
    opencode/      # FlowStore, SessionTracker (Event)
    claude/        # transcript reducer, session-source, mcp-server
    pi/            # PiFlowStore, PiSessionTracker, extension.ts
  server.ts        # OpenCode entry (plugin module)
  mcp.ts           # Claude Code entry (stdio MCP server)
  extension.ts     # re-export pi (Pi/omp entry)
```

The dependency arrow points one way: `flow/` never imports an adapter. Adapter tests live next to their adapter (`adapters/opencode|claude|pi/*.test.ts`).

### OpenCode (`adapters/opencode/`)

`FlowStore` on `Event{ message.updated, message.part.updated{delta}, todo.updated, session.idle, session.created{parentID} }`:
- `Unit` opens on the first `text` with `role=user` (ignores synthetic), closes on `session.idle` or the next `UserRequest`.
- `TurnState{modelCall→modelReply}` on `step-start`/`step-finish`, `reasoning`/`text` via `delta`.
- `tool` part `pending→running→completed/failed`, `tool==="task"` + `subtask` part merge into a single `subtask:true` node (queues `turnUnmatched`/`turnTaskCalls` for ordering). `ToolState.time` → `startedAt`/`endedAt`; `ToolState.title` is promoted into the label (`Tool: bash · npm test`) unless it repeats the tool name.
- `AssistantMessage.time`/`tokens`/`cost` → metrics on the turn's `model-call`.
- `Plan` from `todo.updated` (buffer `pendingTodos`).

`SessionTracker extends BaseSessionTracker<FlowStore>` — adds only `dispatch(event)`: `session.created{parentID}` → `registerChild`, everything else routed by `sessionIDOf`. Composition (sort by `created`, tie-break on `id`, recursive flat graft of `request+steps`, `subtask-summary` beyond the third) lives in the shared base.

### Claude Code (`adapters/claude/`)

Claude Code exposes no plugin event API, so this adapter is **pull, not push**: it reduces the JSONL transcript Claude Code writes to `~/.claude/projects/<encoded-cwd>/<session-id>.jsonl`.

- `transcript.ts` — `reduceTranscript(lines)` → `FlowTree`. A human prompt is a `user` record whose `content` is a plain string (tool results arrive as a `tool_result` array); one `requestId` is one `ModelCall`; `text`/`thinking` blocks split into content/reasoning; `tool_use` ↔ `tool_result` link by `tool_use_id` with `is_error`; `TodoWrite.input.todos` becomes the `Plan`; `message.usage` becomes tokens (no cost — Claude Code does not report one).
- **Timing quirk:** a transcript timestamp is when the line was *written*, and most calls occupy one line, so `startedAt` comes from the preceding record — that gap is the real latency.
- **Labels:** no `ToolState.title` exists, so it is synthesized from the tool's input (`command`, `file_path`, `pattern`, …).
- `session-source.ts` — `encodeProjectDir` (every char outside `[a-zA-Z0-9-]` → `-`, verified against every project directory on disk), newest-transcript discovery, and an `fs.watch` that re-resolves when a new session file appears. Re-reduces the whole file (~17ms on 2.8MB) rather than tailing.
- `mcp-server.ts` — `McpServer` over stdio registering `flow_open`/`flow_panel`/`flow_tree`.

**Orchestration nodes are selective.** Pi's rule — an empty turn — never fires here: of 458 turns in the transcript this was built against, zero produced no text, reasoning or tools. Claude Code records its harness work as `system` records instead, and only four subtypes carry signal:

| Subtype | Node | Fields used |
|---|---|---|
| `compact_boundary` | `Context compacted (auto / manual)` | `compactMetadata.preTokens` → `postTokens`, `durationMs` becomes the node's duration |
| `api_error` | `API error <status>`, state `failed` | `error.status`, or `error.formatted`/`message` for transport failures that carry no status, plus `retryAttempt`/`maxRetries` |
| `model_refusal_fallback` | `Model fallback: <from> → <to>`, state `failed` | `originalModel`, `fallbackModel`, `apiRefusalCategory` |
| `local_command` | `Local command` | `content`, with the `<local-command-*>` wrapper stripped |

Everything else is dropped on purpose. `stop_hook_summary` is the notable exclusion: a one-time survey of every transcript on the development machine found ~1900 of them and **not one** with a `hookError`, a `stopReason`, or `preventedContinuation` set — about 24 identical dimmed nodes per session, which is exactly the clutter the node type exists to prevent. `attachment`, `last-prompt`, `ai-title`, `custom-title`, `mode`, `queue-operation`, `pr-link`, `atis-latch` and `bridge-session` are UI and persistence bookkeeping rather than agent work. A `system` record that arrives before the first prompt has no unit to attach to and is dropped.

That same survey produced 106 orchestration nodes covering all four subtypes, and 54 sub-agent summaries. The counts are a snapshot of one machine, not a property of the plugin — what they establish is that the four chosen subtypes occur and the excluded one never carries signal.

**Sub-agent internals are not in the transcript.** Verified by running one: the file gains the `Agent` launch and its result, and nothing in between — no `isSidechain` records are written. The launch node therefore shows the brief, the returned report, and the run summary the result carries (`agentType`, `resolvedModel`, `totalDurationMs`, `usage`, `totalToolUseCount`). That summary is a `subtask-summary` node, not an `orchestration` one: Orchestration means work the *harness* did, and mixing the two made a filter for `orchestration` return sub-agent nodes in sessions with no harness events at all. The tool is named `Agent` in Claude Code 2.x; `Task` is still matched for older transcripts.

### Pi / omp (`adapters/pi/`)

`PiFlowStore`:
- `before_agent_start{prompt}` → `UserRequest` + `Unit`, `turn_start{turnIndex}` → `ModelCall/Reply{running}`, `message_update{assistantMessageEvent{type,delta}}` → `appendAssistantText` (filters the `{"i":` delegate payload on the **accumulated** text, so a payload split across deltas is caught too; splits `text_delta`/`thinking_delta`), `tool_call{input}` → `ToolCall` (for `oh_my_pi_delegate_task`/`oh_my_pi_subagent` label from `agent`/`category`), `tool_result`/`tool_execution_end` → `completed|failed`, `markToolRunning`, `turn_end`/`agent_end|settled` → `completed` + `Answer`.

Empty turns without content/tools → `finishTurn` converts `model-call` to `orchestration` (dashed, kept by design instead of hidden).

Pi events carry no timestamps, so `PiFlowStore(sessionID, now = Date.now)` takes an injectable clock and stamps the wall clock it observes; tokens/cost are unavailable on this platform.

`PiSessionTracker extends BaseSessionTracker<PiFlowStore>` — adds `dispatchBySession` and defaults the fork ordering key to `Date.now()` (Pi's `session_start{reason:"fork", previousSessionFile}` carries no timestamp; parent id = basename without `.json`, fallback `lastActiveSessionID`).

## Build & entry points

- `package.json:exports` → `./server` = `src/server.ts`, `./extension` = `src/extension.ts`, `./mcp` = `src/mcp.ts`
- `pi.extensions` + `omp.extensions` → `["./dist/extension.js","./src/extension.ts"]` (jiti dev + bundle prod)
- `npm run build` → `dist/server.js` (OpenCode) + `dist/extension.js` (Pi/omp, `--external:@earendil-works/* --external:@oh-my-pi/*`) + `dist/mcp.js` (Claude Code, MCP SDK inlined)
- `src/server.ts` — `tracker`+`panelServer` created **per plugin instance** (not per module), `flow_panel` (reset), `flow_open` (keep), `flow_tree` (text). `server:Plugin{ event→tracker.dispatch }`, `server.instance.disposed` → `panelServer.close()`.

See `docs/adr/0001-external-renderer-for-panel.md` (why browser, not TUI), `0002-pi-and-oh-my-pi-adaptation.md` (dual-platform).
