# 04 — Live updates via SSE and Plan preview

**What to build:** The Panel updates in real time as new events arrive, pushed over SSE; Plan nodes appear as pending before they execute. This closes the manual smoke test for the MVP: simple request, tool run, plan preview, clean tree at the end.

**Blocked by:** 03 — Panel renders the step tree (snapshot)

**Status:** resolved

- [x] Panel updates live without manual refresh
- [x] Plan (todo) nodes appear before execution as pending
- [x] Smoke test passes all four criteria: simple request; tool run with ToolCall/ToolResult; plan preview; tree clean after completion

## Comments

Added SSE to the panel server: `GET /events` streams the rendered flow HTML, `publish()` pushes after every dispatch (called from the plugin event hook). The page embeds a minimal `EventSource` client that replaces `#flow` innerHTML — the server stays the single source of truth for rendering (no client-side render duplication). Plan preview was already in the reducer (`todo.updated` → `unit.plan`, chips); SSE makes it appear live before the steps execute.

Verification: unit tests — SSE stream test (fetch + ReadableStream), publish no-op, single-line flow HTML, embedded client script (24/24 green, typecheck/lint clean). Live: while a real session streamed, `curl -N <url>/events` captured 23.5 KB of `data:` updates containing `flow-probe` and `Tool: bash`. Smoke criteria 1/2 verified live in prior sessions; criteria 3 (plan preview) and 4 (clean tree after completion) verified by reducer unit tests.

Code-review fixes: SSE sends an initial snapshot frame on connect (resync after reconnect); plan renders above the steps it previews; `todo.updated` arriving before a unit opens is stashed and applied to the next unit; `publish()` skips work with no clients and tolerates dead sockets; `/events` path and flow container id are shared constants. Final: 27/27 tests, typecheck/lint clean, live SSE re-verified.
