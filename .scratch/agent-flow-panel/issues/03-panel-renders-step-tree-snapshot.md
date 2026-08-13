# 03 — Panel renders the step tree (snapshot)

**What to build:** The Panel command opens the browser page served by a local HTTP server owned by the plugin. The page renders the built step tree as a vertical timeline with node types and states distinguishable by colour/label, showing type, short content, and state per node. Refreshing the page reflects the current snapshot.

**Blocked by:** 02 — Step-tree builder from the live event stream

**Status:** resolved

- [x] The command opens a page served by the plugin's own local server
- [x] The page renders the current Unit of Work tree: types, short content, states
- [x] Refreshing re-renders from the latest snapshot

## Comments

Added `src/panel/render.ts` (pure HTML renderer: node types/states as colour/label, escaped content) and `src/server/panel-server.ts` (local HTTP server: `/` renders the tree, `/data` returns the JSON snapshot). `/flow` now starts the server and opens `http://127.0.0.1:<port>/`. Live check: a session ran `echo flow-probe`, opened the panel, and `Invoke-WebRequest` on the returned URL confirmed the served HTML contains "Agent Flow Panel", "flow-probe" and "Tool: bash". Tests: render (5), panel server (4).
