# Architecture

## Shared core (60% portable)

- `src/flow/types.ts` — domain (`StepType`, `StepState`, `FlowTree`, `UnitOfWork`, `PlanItem`). Unchanged across platforms.
- `src/flow/render.ts` — rendering `renderTree` (text) + `renderPanelHtml`/`renderFlowHtml` (HTML). Recursive `walk`, `truncate` 80/120, `escapeHtml`/`attrEscape`. `STYLES` with CSS variables per type (`--orchestration: #6b7280` dashed). `CLIENT_SCRIPT` — `EventSource("/events")`, `collapsed` Set, `selectedId`, `data-content`/`data-reasoning` for details. Single-line `renderFlowHtml` for SSE.
- `src/server/panel-server.ts` — `http` + SSE: `GET /` → `renderPanelHtml(getTree())`, `/data` → `JSON`, `/events` → `text/event-stream` (`: connected` + `data: <html>`), `publish()` broadcasts to `Set<ServerResponse>`, random port `0`.

## Adapters — thin isolation

```
src/
  flow/            # shared
  server/          # panel-server
  adapters/
    opencode/      # FlowStore, SessionTracker (Event)
    pi/            # PiFlowStore, PiSessionTracker, extension.ts
  server.ts        # re-export opencode (OpenCode entry)
  extension.ts     # re-export pi (Pi/omp entry)
```

### OpenCode (`adapters/opencode/`)

`FlowStore` on `Event{ message.updated, message.part.updated{delta}, todo.updated, session.idle, session.created{parentID} }`:
- `Unit` opens on the first `text` with `role=user` (ignores synthetic), closes on `session.idle` or the next `UserRequest`.
- `TurnState{modelCall→modelReply}` on `step-start`/`step-finish`, `reasoning`/`text` via `delta`.
- `tool` part `pending→running→completed/failed`, `tool==="task"` + `subtask` part merge into a single `subtask:true` node (queues `turnUnmatched`/`turnTaskCalls` for ordering).
- `Plan` from `todo.updated` (buffer `pendingTodos`).

`SessionTracker` — `stores:Map<sessionID,FlowStore>` + `childrenOf:Map<parentID,{id,created}[]>`, `compose`/`graft`/`summaryNode` (`MAX_DETAILED_SUBTASKS=3`), sort by `created`, recursive flat graft (`request+steps`, `plan` dropped), summary `subtask-summary`.

### Pi / omp (`adapters/pi/`)

`PiFlowStore`:
- `before_agent_start{prompt}` → `UserRequest` + `Unit`, `turn_start{turnIndex}` → `ModelCall/Reply{running}`, `message_update{assistantMessageEvent{type,delta}}` → `appendAssistantText` (filters `{"i":` payload, splits `text_delta`/`thinking_delta`), `tool_call{input}` → `ToolCall` (for `oh_my_pi_delegate_task`/`oh_my_pi_subagent` label from `agent`/`category`), `tool_result`/`tool_execution_end` → `completed|failed`, `markToolRunning`, `turn_end`/`agent_end|settled` → `completed` + `Answer`.

Empty turns without content/tools → `finishTurn` converts `model-call` to `orchestration` (dashed, kept by design instead of hidden).

`PiSessionTracker` — analog of `SessionTracker` but `registerChild(parent,child)` on `session_start{reason:"fork", previousSessionFile}` (basename without `.json` + fallback `lastActiveSessionID`), same `compose`/`graft`/`summary`.

## Build & entry points

- `package.json:exports` → `./server` = `src/server.ts`, `./extension` = `src/extension.ts`
- `pi.extensions` + `omp.extensions` → `["./dist/extension.js","./src/extension.ts"]` (jiti dev + bundle prod)
- `npm run build` → `dist/server.js` (467kb) + `dist/extension.js` (~146kb, `--external:@earendil-works/* --external:@oh-my-pi/*`)
- `src/server.ts` — singleton `tracker`+`panelServer`, `flow_panel` (reset), `flow_open` (keep), `flow_tree` (text). `server:Plugin{ event→tracker.dispatch }`

See `docs/adr/0001-external-renderer-for-panel.md` (why browser, not TUI), `0002-pi-and-oh-my-pi-adaptation.md` (dual-platform).
