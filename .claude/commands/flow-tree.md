---
description: Show the Agent Flow step tree for this session
---

Call the `flow_tree` tool from the `flow-panel` MCP server and report its output verbatim.

Do not perform any other actions.

If that tool is not available, stop and say so. Do not substitute anything for it: not another tool, not a shell command, and not code that imports this project and renders a tree itself. A tree built any other way comes from a different session and describes the wrong flow.

This command is for agents that reach the panel over MCP, which today means Claude Code. Under Pi or oh-my-pi, `/flow-tree` is a command the extension registers itself; if you are seeing this text there, the extension was not loaded with `-e`.
