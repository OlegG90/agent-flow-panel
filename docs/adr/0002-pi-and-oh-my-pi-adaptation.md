# 0002 — Adapting the panel to Pi and oh-my-pi (dual-platform)

## Context

The plugin is currently OpenCode-only (`@opencode-ai/plugin` `PluginModule{ id, server }`, events `message.*`/`todo.updated`/`session.*`). Pi (`@earendil-works/pi-coding-agent` `ExtensionAPI`) has a different model: `export default function(pi){ pi.on(...); pi.registerTool(); pi.registerCommand() }`, events `turn_*`/`message_*`/`tool_call`/`tool_result`/`agent_*`, and no `todo.updated`/`subtask` as core primitives.

`oh-my-pi` (`oh-my-pi@0.2.0`, `pi.extensions: ["./dist/extension.js"]`) is an enhancement framework on top of Pi: it adds orchestration through two delegator tools, `oh_my_pi_delegate_task(category, task)` and `oh_my_pi_subagent(agent, task)`, plus categories (`quick/deep/ultrabrain/...`). From the flow panel's point of view this is the analogue of `task` in OpenCode — the branch point into a sub-agent.

Requirement: one repository/codebase runs on **OpenCode and on Pi, with or without oh-my-pi**.

## Decision

**Shared core + two thin adapters.** 60% of the code is portable and stays shared:

* `src/flow/types.ts` — the domain (StepType/State, FlowTree, UnitOfWork) — unchanged.
* `src/flow/render.ts` — text/html rendering — unchanged.
* `src/server/panel-server.ts` — `http`+SSE (`/, /data, /events`) — unchanged.

Platform-specific code is isolated in the adapters:

```
src/
  flow/            # shared core (types, render, panel-server)
  adapters/
    opencode/      # OpenCode: reducer.ts, session-tracker.ts, binding.ts
    pi/            # Pi: pi-reducer.ts, pi-session.ts, extension.ts
  server.ts        # re-export of the OpenCode adapter (backwards compatibility)
  extension.ts     # re-export of the Pi adapter (entry point for Pi)
```

**The OpenCode adapter** — existing logic, unchanged: `FlowStore` on `Event{ message.updated, message.part.updated(delta), todo.updated, session.idle, session.created }`, `SessionTracker` on `parentID`.

**The Pi adapter** — a new `PiFlowStore` implementation:

* `before_agent_start` → `UserRequest` + opens a `UnitOfWork`
* `turn_start` → `ModelCall`/`ModelReply` (running)
* `message_update` (assistant streaming) → appends to `ModelReply.content/reasoning`
* `tool_call` → `ToolCall` (pending→running); `tool_result`/`tool_execution_end` → `ToolResult`/`completed|failed`
* `oh_my_pi_delegate_task` / `oh_my_pi_subagent` → `ToolCall{subtask:true}` (the analogue of `tool==="task"` in OpenCode), with `SessionTracker`-like grafting when oh-my-pi forks the session (`session_start{reason:"fork"}` + `previousSessionFile`)
* `turn_end` → `completed` for ModelCall/Reply
* `agent_end` / `agent_settled` → closes the Unit + an `Answer` node
* `todo.updated` does not exist in Pi → `Plan` stays empty (possible future: listen to a custom `oh_my_pi` todo tool or the `.oh-my-pi/boulder-state` file — out of scope for the MVP)

**Distribution:**

* OpenCode: `opencode.json` → `plugin: ["file:///…/dist/server.js"]`, `exports["./server"]` (esbuild bundle).
* Pi / oh-my-pi: `pi install` from npm, or `.pi/extensions/flow-panel/index.ts` (jiti, no bundle), or `package.json: { pi:{ extensions:["./dist/extension.js"] } }`. Since oh-my-pi already occupies `pi.extensions`, the flow panel is installed **alongside it** — Pi loads every `pi.extensions` entry from every installed package, so there is no conflict.

## Alternatives

* Forking the repository for Pi — rejected: duplicates 60% of the code, and the two copies drift apart.
* A unified `Event` union with `if (platform)` — rejected: the abstraction leaks, and the SDK types are incompatible (`@opencode-ai/sdk` vs `@earendil-works/pi-coding-agent`).

## Consequences

* A single `npm run build` produces **two bundles**: `dist/server.js` (OpenCode) and `dist/extension.js` (Pi).
* Tests are duplicated: `src/adapters/opencode/*.test.ts` and `src/adapters/pi/*.test.ts` over shared fixtures.
* oh-my-pi compatibility needs no extra dependencies: matching the tool names `oh_my_pi_delegate_task`/`oh_my_pi_subagent` as subtasks is enough.
