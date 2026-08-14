# 03 — Compose subtask trees into the panel tree

**What to build:** The tracker's tree() grafts each child session's composed tree under the matching subtask launch node — recursively, flat (the child's request and steps become the node's children, its plan is dropped) — and marks the launch node running while the child works and completed when it finishes. The panel and /flow-tree show the expanded sub-agent flow, live.

**Blocked by:** 01 — One subtask launch node in the reducer; 02 — Session hierarchy and child completion in the tracker

**Status:** resolved

- [x] A child session's tree appears under its launch node
- [x] Two sub-agents match to their nodes in creation order
- [x] The launch node is running while the child works and completed after the child idles
- [x] Nested sub-agents expand recursively (depth 2)
- [x] The child's plan is not shown (flat shape)
- [x] A live run with a sub-agent shows the expansion in the panel and /flow-tree

## Comments

`tree()` composes: walks the session's tree for `subtask`-marked launch nodes in document order, grafts each matched child session's recursively-composed tree flat (request + steps, plan dropped), and overrides the launch node state (running while the child is active, completed after its idle). Verified live: a task-tool run expanded into the sub-agent's full flow (request → several model calls with glob/read/bash → answer) under the launch node.
