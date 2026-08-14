# 01 — One subtask launch node in the reducer

**What to build:** A sub-agent launch shows as exactly one node in the Unit of Work: the subtask part and the task tool call merge into a single `subtask`-marked ToolCall node regardless of which arrives first; the node carries the sub-agent's name/description and tracks the tool's execution state.

**Blocked by:** None — can start immediately.

**Status:** resolved

- [x] A launch with only a subtask part produces one marked node
- [x] A launch where the task tool call arrives before or after the subtask part still produces one marked node
- [x] Regular tool calls are unaffected (no marker)
- [x] Unit tests green

## Comments

`StepNode` gained a `subtask?: boolean` marker. The reducer now keys a launch node per turn (`launch-<messageID>`): the subtask part and the task tool call merge into one node order-independently — content from the subtask (agent name/description, kept on completion), lifecycle from the tool part via `applyToolState`. Regular tools are unchanged.
