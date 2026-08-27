# Architecture

## Shared core (60% portable)

- `src/flow/types.ts` — domain (`StepType`, `StepState`, `FlowTree`, `UnitOfWork`, `PlanItem`). Unchanged across platforms.
- `src/flow/render.ts` — rendering `renderTree` (text) + `renderPanelHtml`/`renderFlowHtml` (HTML). Recursive `walk`, `truncate` 80/120, `escapeHtml`/`attrEscape`. `STYLES` with CSS variables per type (`--orchestration: #6b7280` dashed). `CLIENT_SCRIPT` — `EventSource("/events" + location.search)`, `collapsed` Set, `selectedId`, `data-content`/`data-reasoning` for details. Single-line `renderFlowHtml` for SSE.
- `src/flow/tracker.ts` — `BaseSessionTracker<S>`: `stores:Map<sessionID,S>` + `childrenOf:Map<parentID,{id,created}[]>`, `registerChild` (idempotent), `tree`/`compose`/`graft`/`summaryNode` (`MAX_DETAILED_SUBTASKS=3`). Both adapters extend it; only `dispatch` is platform-specific.
- `src/server/panel-server.ts` — `http` + SSE: `GET /` → `renderPanelHtml(getTree())`, `/data` → `JSON`, `/events` → `text/event-stream` (`: connected` + `data: <html>`), `publish()` broadcasts to `Set<ServerResponse>`, random port `0`. Every route is gated by a per-run 128-bit token (`?t=…`, `timingSafeEqual`); `url(path?)` builds tokenized URLs.

## Adapters — thin isolation

```
src/
  flow/            # shared: types, render, tracker (BaseSessionTracker)
  server/          # panel-server
  adapters/
    opencode/      # FlowStore, SessionTracker (Event)
    pi/            # PiFlowStore, PiSessionTracker, extension.ts
  server.ts        # OpenCode entry (plugin module)
  extension.ts     # re-export pi (Pi/omp entry)
```

The dependency arrow points one way: `flow/` never imports an adapter. Adapter tests live next to their adapter (`adapters/opencode/*.test.ts`, `adapters/pi/*.test.ts`).

### OpenCode (`adapters/opencode/`)

`FlowStore` on `Event{ message.updated, message.part.updated{delta}, todo.updated, session.idle, session.created{parentID} }`:
- `Unit` opens on the first `text` with `role=user` (ignores synthetic), closes on `session.idle` or the next `UserRequest`.
- `TurnState{modelCall→modelReply}` on `step-start`/`step-finish`, `reasoning`/`text` via `delta`.
- `tool` part `pending→running→completed/failed`, `tool==="task"` + `subtask` part merge into a single `subtask:true` node (queues `turnUnmatched`/`turnTaskCalls` for ordering).
- `Plan` from `todo.updated` (buffer `pendingTodos`).

`SessionTracker extends BaseSessionTracker<FlowStore>` — adds only `dispatch(event)`: `session.created{parentID}` → `registerChild`, everything else routed by `sessionIDOf`. Composition (sort by `created`, tie-break on `id`, recursive flat graft of `request+steps`, `subtask-summary` beyond the third) lives in the shared base.

### Pi / omp (`adapters/pi/`)

`PiFlowStore`:
- `before_agent_start{prompt}` → `UserRequest` + `Unit`, `turn_start{turnIndex}` → `ModelCall/Reply{running}`, `message_update{assistantMessageEvent{type,delta}}` → `appendAssistantText` (filters the `{"i":` delegate payload on the **accumulated** text, so a payload split across deltas is caught too; splits `text_delta`/`thinking_delta`), `tool_call{input}` → `ToolCall` (for `oh_my_pi_delegate_task`/`oh_my_pi_subagent` label from `agent`/`category`), `tool_result`/`tool_execution_end` → `completed|failed`, `markToolRunning`, `turn_end`/`agent_end|settled` → `completed` + `Answer`.

Empty turns without content/tools → `finishTurn` converts `model-call` to `orchestration` (dashed, kept by design instead of hidden).

`PiSessionTracker extends BaseSessionTracker<PiFlowStore>` — adds `dispatchBySession` and defaults the fork ordering key to `Date.now()` (Pi's `session_start{reason:"fork", previousSessionFile}` carries no timestamp; parent id = basename without `.json`, fallback `lastActiveSessionID`).

## Build & entry points

- `package.json:exports` → `./server` = `src/server.ts`, `./extension` = `src/extension.ts`
- `pi.extensions` + `omp.extensions` → `["./dist/extension.js","./src/extension.ts"]` (jiti dev + bundle prod)
- `npm run build` → `dist/server.js` (467kb) + `dist/extension.js` (~146kb, `--external:@earendil-works/* --external:@oh-my-pi/*`)
- `src/server.ts` — `tracker`+`panelServer` created **per plugin instance** (not per module), `flow_panel` (reset), `flow_open` (keep), `flow_tree` (text). `server:Plugin{ event→tracker.dispatch }`, `server.instance.disposed` → `panelServer.close()`.

See `docs/adr/0001-external-renderer-for-panel.md` (why browser, not TUI), `0002-pi-and-oh-my-pi-adaptation.md` (dual-platform).
