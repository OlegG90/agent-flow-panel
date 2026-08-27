# Agent Flow Visualization

Context for the OpenCode plugin that visualizes an agent's work as a live flowchart of steps. The plugin watches the agent's activity and renders the steps as a panel the user watches while working.

## Step nodes

**UserRequest**:
The human's incoming message that starts a unit of work.
_Avoid_: "запит" on its own (ambiguous)

**ModelCall**:
A single LLM invocation made by the agent.
_Avoid_: "запит моделі"

**ModelReply**:
The model's raw response to a ModelCall, including any embedded reasoning.
_Avoid_: "міркування" as a separate node

**ToolCall**:
One invocation of one tool by the agent; launching a sub-agent is a ToolCall of whichever tool the platform uses for it (`task`, `Agent`, `oh_my_pi_delegate_task`).
_Avoid_: "запуск інструментів" as a single aggregate step

**ToolResult**:
The output returned by a ToolCall.

**Answer**:
The final message shown to the human at the end of a unit of work.
_Avoid_: "результат", "звіт про результат"

## Structure

**Session**:
A conversation between the human and the agent, made up of several Units of Work.

**Subtask**:
The internal work of a sub-agent, revealed as a nested flow of Units of Work beneath its launch node.

**Sub-agent summary**:
Sub-agent work shown as a summary instead of a tree. Two reasons produce it: more sub-agents ran than are expanded individually, or the platform records none of a sub-agent's steps and only reports a summary of the run.
_Avoid_: filing it as Orchestration — that is the harness's own work, not the sub-agent's

**Orchestration**:
Work the agent's harness did around the model, kept as a dimmed node so the trace stays complete. What counts as orchestration is platform-specific:
- **oh-my-pi**: a turn that produced no model text/reasoning and no tool calls — worktree setup, queue poll.
- **Claude Code**: a `system` record that changed the run — context compaction, an API error and its retry, a model fallback, a local command.
_Avoid_: hiding it as if nothing happened
_Avoid_: showing every harness record — bookkeeping with no outcome is clutter, not trace

**Unit of Work**:
One human request together with the full tree of steps the agent performs to satisfy it.

**Plan**:
The agent's declared upcoming steps — its todo list — previewed in the panel as pending nodes before they execute.

**State**:
The execution state of a step node: pending (from the plan), running, completed, or failed.

**Panel**:
The live flowchart of a session's steps, shown to the user while they work.
