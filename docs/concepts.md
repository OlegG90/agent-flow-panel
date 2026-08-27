# Domain — Agent Flow Visualization

> Source of truth for terminology is `CONTEXT.md` at the repo root (concise glossary for the agent). This document is the expanded GitHub version with examples and relationships.

The plugin observes agent work and renders it as a **live flowchart** in the browser. The panel updates via SSE without reload.

## Step nodes — what is captured

| Type | Meaning | When it appears | Avoid |
|---|---|---|---|
| **UserRequest** | Human message that starts a `Unit of Work` | `message.updated{role:user}` / `before_agent_start{prompt}` | `request` alone |
| **ModelCall** | A single LLM invocation | `step-start` / `turn_start` | `model request` |
| **ModelReply** | Raw response to `ModelCall`, including `reasoning` | `reasoning` delta + `text` delta | `reasoning` as a separate node |
| **ToolCall** | One invocation of one tool. Sub-agent launch is also `ToolCall{subtask:true}`: `task` in OpenCode, `Agent` (older: `Task`) in Claude Code, `oh_my_pi_delegate_task`/`oh_my_pi_subagent` in omp | `tool` part `pending→running` / `tool_call` / `tool_use` block | `tool launch` as a single aggregate |
| **ToolResult** | Output of `ToolCall` (nested under it) | `tool.state=completed` → `tool-result` | — |
| **Answer** | Final message shown to the human | `session.idle`/`agent_end` + last `ModelReply.text` | `result` |
| **Orchestration** | Harness work around the model. **oh-my-pi**: an empty turn (worktree, queue). **Claude Code**: a `system` record that changed the run — compaction, API error, model fallback, local command | `finishTurn` without content, or a `system` record of one of four subtypes | hiding it — or showing every harness record |
| **Sub-agent summary** | Sub-agent work summarised rather than expanded — either >3 `Subtask` collapsed, or a run the platform never recorded | `BaseSessionTracker.compose` when `refs.length>3` (OpenCode, Pi); `applyAgentSummary` on Claude Code | filing it as `Orchestration` |

| **planned** | A `Plan` item declared but not started, previewed at the tail of the unit | render only — no reducer emits it | — |

Every node has a `State`: `pending` (from Plan, dashed), `running` (pulse), `completed` (`done`), `failed` (red).

## Structure

- **Session** — conversation between human and agent, consisting of several `Unit of Work`.
- **Unit of Work** — one `UserRequest` plus the full step tree that fulfills it.
- **Subtask** — internal work of a sub-agent, nested as `Unit(s)` under the launch node on OpenCode and Pi. **Claude Code records none of it**: the launch node carries the brief, the report and a run summary instead.
- **Plan** — agent-declared upcoming steps → `PlanItem{pending|in-progress|completed}`. From `todo.updated` in OpenCode (filters `cancelled`) and from `TodoWrite` calls in Claude Code; empty in Pi, which has no such primitive.
- **Panel** — live flowchart of the session (`/` → HTML, `/data` → JSON, `/events` → SSE; all gated by `?t=<token>`).

## Relationships

```
UserRequest
  └─ ModelCall ── ModelReply ─┬─ ToolCall ── ToolResult
                              ├─ ToolCall{subtask} ── [grafted child Unit(s) | summary]   (not on Claude Code)
                              └─ Orchestration (if turn was empty)
  └─ Answer
  └─ Plan chips (above steps)
```

See also: `docs/architecture.md` (how the tree is built), `docs/panel.md` (rendering), `docs/adr/` (decisions).
