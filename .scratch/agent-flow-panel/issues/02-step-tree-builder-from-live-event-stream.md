# 02 — Step-tree builder from the live event stream

**What to build:** The plugin subscribes to the session event stream and builds the step tree of the current Unit of Work: UserRequest, one ModelCall per assistant turn, ModelReply (including embedded reasoning), ToolCall (a sub-agent launch is a single ToolCall node), ToolResult, Answer. Each node tracks its State (pending/running/completed/failed); Plan preview nodes come from todo list updates. The tree is exposed so the Panel can render it.

**Blocked by:** 01 — Plugin skeleton with Panel command

**Status:** resolved

- [x] Unit tests prove correct tree shapes from synthetic event sequences (incl. tool runs, errors, sub-agent launch, plan updates)
- [x] A live session's tree is observable (e.g. command output) and correct
- [x] States transition pending → running → completed / failed

## Comments

`FlowStore` reducer (src/flow/) consumes v1 events and builds Unit of Work trees; `/flow-tree` command exposes the current session's tree via the `flow_tree` tool. Live check: a session that ran `bash echo` then called `flow_tree` reported one Unit of Work with User request → Model call → Model reply (reasoning) → Tool calls with live states. Key discovery: opencode emits synthetic user messages for tool-result feedback — a new Unit must open only on a real (non-synthetic) user text part, otherwise every tool roundtrip forks a new unit.
