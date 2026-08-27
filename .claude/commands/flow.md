---
description: Open the Agent Flow panel for this session
---

Call the `flow_open` tool from the `flow-panel` MCP server and report the URL it returns.

Do not perform any other actions.

If that tool is not available, stop and say so. Do not substitute anything for it: not another tool, not a shell command, and not code that imports this project and starts a panel itself. A panel started any other way is fed by a different session and shows the wrong flow — usually an empty one, labelled with the wrong agent.

This command is for agents that reach the panel over MCP, which today means Claude Code. Under Pi or oh-my-pi, `/flow` is a command the extension registers itself; if you are seeing this text there, the extension was not loaded with `-e`.
