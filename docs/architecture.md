# Architecture

## Shared core (60% portable)

- `src/flow/types.ts` — domain (`StepType`, `StepState`, `FlowTree`, `UnitOfWork`, `PlanItem`, `TokenUsage`). `StepNode` carries optional `startedAt`/`endedAt`/`tokens`/`cost`. Unchanged across platforms.
- `src/flow/render.ts` — rendering `renderTree` (text) + `renderPanelHtml`/`renderFlowHtml` (HTML). Recursive `walk`, `collapseTurn` (ModelCall+ModelReply → one row), `metrics`/`unitSummary` (duration, tokens, cost badges), `truncate` 80/120, `escapeHtml`/`attrEscape`. `STYLES` with CSS variables per type (`--orchestration: #6b7280` dashed). `clientScript(live)` — `EventSource("/events" + location.search)`, `collapsed` Set, `selectedId`, details fetched from `/node`, filter/follow/collapse-all toolbar. `renderExportHtml` renders the same page with content inlined and no stream. Single-line `renderFlowHtml` for SSE.
- `src/flow/tracker.ts` — `BaseSessionTracker<S>`: `stores:Map<sessionID,S>` + `childrenOf:Map<parentID,{id,created}[]>`, `registerChild` (idempotent), `tree`/`compose`/`graft`/`summaryNode` (`MAX_DETAILED_SUBTASKS=3`). Both adapters extend it; only `dispatch` is platform-specific.
- `src/server/panel-server.ts` — `http` + SSE: `GET /` → `renderPanelHtml(getTree())`, `/data` → `JSON`, `/events` → `text/event-stream` (`: connected` + `data: <html>`), `publish()` coalesces frames on a leading+trailing window (`coalesceMs`, default 120ms) and broadcasts to `Set<ServerResponse>`, random port `0`. Routes: `/`, `/data`, `/node?id=`, `/export`, `/events`. Every one is gated by a per-run 128-bit token (`?t=…`, `timingSafeEqual`); `url(path?)` builds tokenized URLs.

## Adapters — thin isolation

```
src/
  flow/            # shared: types, render, tracker (BaseSessionTracker)
  server/          # panel-server
  adapters/
    opencode/      # FlowStore, SessionTracker (Event)
    claude/        # transcript reducer, session-source, mcp-server
    pi/            # PiFlowStore, PiSessionTracker, extension.ts
  server.ts        # OpenCode entry (plugin module)
  mcp.ts           # Claude Code entry (stdio MCP server)
  extension.ts     # re-export pi (Pi/omp entry)
```

The dependency arrow points one way: `flow/` never imports an adapter. Adapter tests live next to their adapter (`adapters/opencode/*.test.ts`, `adapters/pi/*.test.ts`).

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

**Sub-agent internals are not in the transcript.** Verified by running one: the file gains the `Agent` launch and its result, and nothing in between — no `isSidechain` records are written. The launch node therefore shows the brief, the returned report, and the run summary the result carries (`agentType`, `resolvedModel`, `totalDurationMs`, `usage`, `totalToolUseCount`). The tool is named `Agent` in Claude Code 2.x; `Task` is still matched for older transcripts.

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
