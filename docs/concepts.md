# Domain — Agent Flow Visualization

> Source of truth for terminology is `CONTEXT.md` at the repo root (concise glossary for the agent). This document is the expanded GitHub version with examples and relationships.

The plugin observes agent work and renders it as a **live flowchart** in the browser. The panel updates via SSE without reload.

## Step nodes — what is captured

| Type | Meaning | When it appears | Avoid |
|---|---|---|---|
| **UserRequest** | Human message that starts a `Unit of Work` | `message.updated{role:user}` / `before_agent_start{prompt}` | `request` alone |
| **ModelCall** | A single LLM invocation | `step-start` / `turn_start` | `model request` |
| **ModelReply** | Raw response to `ModelCall`, including `reasoning` | `reasoning` delta + `text` delta | `reasoning` as a separate node |
| **ToolCall** | One invocation of one tool. Sub-agent launch (`task` in OpenCode, `oh_my_pi_delegate_task`/`oh_my_pi_subagent` in omp) is also `ToolCall{subtask:true}` | `tool` part `pending→running` / `tool_call` | `tool launch` as a single aggregate |
| **ToolResult** | Output of `ToolCall` (nested under it) | `tool.state=completed` → `tool-result` | — |
| **Answer** | Final message shown to the human | `session.idle`/`agent_end` + last `ModelReply.text` | `result` |
| **Orchestration** | Empty turn with no text/tools — `oh-my-pi` bookkeeping (worktree, queue) | `finishTurn` without content → converted to `orchestration` (dashed, `opacity:0.6`) | hiding it |
| **Sub-agent summary** | Single node collapsing >3 `Subtask` | `SessionTracker.compose` when `refs.length>3` | — |

Every node has a `State`: `pending` (from Plan, dashed), `running` (pulse), `completed` (`done`), `failed` (red).

## Structure

- **Session** — conversation between human and agent, consisting of several `Unit of Work`.
- **Unit of Work** — one `UserRequest` plus the full step tree that fulfills it.
- **Subtask** — internal work of a sub-agent, nested as `Unit(s)` under the launch node.
- **Plan** — agent-declared upcoming steps (`todo.updated` → `PlanItem{pending|in-progress|completed}`, filters `cancelled`). Empty in Pi (no core primitive).
- **Panel** — live flowchart of the session (`/` → HTML, `/data` → JSON, `/events` → SSE; all gated by `?t=<token>`).

## Relationships

```
UserRequest
  └─ ModelCall ── ModelReply ─┬─ ToolCall ── ToolResult
                              ├─ ToolCall{subtask} ── [grafted child Unit(s) | summary]
                              └─ Orchestration (if turn was empty)
  └─ Answer
  └─ Plan chips (above steps)
```

See also: `docs/architecture.md` (how the tree is built), `docs/panel.md` (rendering), `docs/adr/` (decisions).
