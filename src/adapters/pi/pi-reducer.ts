import type { FlowTree, PlanItem, StepNode } from "../../flow/types.ts"
import { makeAnswer, makeNode } from "../../flow/nodes.ts"

// oh-my-pi streams the `delegate_task` payload through the assistant text
// channel as JSON like {"i":"explore","path":"…"}. It is bookkeeping, not a
// reply, so it must never surface as Model reply text or as an Answer.
const TASK_PAYLOAD_PREFIX = '{"i":'

/**
 * True while `text` is — or is still only a prefix of — a delegate_task
 * payload. Streaming splits the JSON across deltas, so a partial head such as
 * `{"i` must be recognised too; the verdict flips back to false as soon as the
 * accumulated text diverges from the payload shape.
 */
function isTaskPayload(text: string): boolean {
  const head = text.trimStart()
  if (head.length === 0) {
    return false
  }
  return head.startsWith(TASK_PAYLOAD_PREFIX) || TASK_PAYLOAD_PREFIX.startsWith(head)
}

// Oh-my-pi delegation tools — treated as subtask launches (analog of OpenCode `task`)
// Generic `task` is what the omp harness emits for delegates; map it too.
const SUBTASK_TOOLS: Record<string, true> = {
  oh_my_pi_delegate_task: true,
  oh_my_pi_subagent: true,
  task: true,
}

interface TurnState {
  id: string
  modelCall: StepNode
  modelReply: StepNode
  text: string
  reasoning: string
}

/** The accumulated assistant text minus any delegate_task payload. */
function visibleText(turn: TurnState): string {
  return isTaskPayload(turn.text) ? "" : turn.text
}

function visibleReasoning(turn: TurnState): string {
  return isTaskPayload(turn.reasoning) ? "" : turn.reasoning
}

interface UnitState {
  id: string
  request: StepNode
  steps: StepNode[]
  plan: PlanItem[]
  turns: TurnState[]
  closed: boolean
}

export class PiFlowStore {
  private readonly sessionID: string
  private readonly units: UnitState[] = []
  private openUnit: UnitState | null = null
  private readonly toolNodes = new Map<string, StepNode>()
  private pendingRequest = ""
  private readonly now: () => number

  /**
   * Pi's events carry no timestamps, so durations are the wall clock observed
   * by the extension. The clock is injectable to keep tests deterministic.
   */
  constructor(sessionID: string, now: () => number = Date.now) {
    this.sessionID = sessionID
    this.now = now
  }

  tree(): FlowTree {
    return {
      sessionID: this.sessionID,
      units: this.units.map((unit) => ({
        id: unit.id,
        request: structuredClone(unit.request),
        steps: structuredClone(unit.steps),
        plan: unit.plan.map((item) => ({ ...item })),
      })),
    }
  }

  // Called from before_agent_start — user prompt becomes Unit
  startUnit(id: string, prompt: string): void {
    this.closeOpenUnit()
    const unit: UnitState = {
      id,
      request: makeNode(`ur-${id}`, "user-request", "User request", "completed", prompt),
      steps: [],
      plan: [],
      turns: [],
      closed: false,
    }
    this.units.push(unit)
    this.openUnit = unit
    this.toolNodes.clear()
    this.pendingRequest = ""
  }

  private ensureOpenUnit(id: string): UnitState {
    if (!this.openUnit) {
      this.startUnit(id, this.pendingRequest || "(unknown request)")
      this.pendingRequest = ""
    }
    return this.openUnit as UnitState
  }

  setPendingRequest(text: string): void {
    if (!this.openUnit) {
      this.pendingRequest = text
    }
  }

  startTurn(turnId: string): void {
    const unit = this.ensureOpenUnit(turnId)
    if (unit.turns.find((t) => t.id === turnId)) return
    const modelCall = makeNode(`mc-${turnId}`, "model-call", "Model call", "running")
    const modelReply = makeNode(`mr-${turnId}`, "model-reply", "Model reply", "running")
    modelCall.children.push(modelReply)
    modelCall.startedAt = this.now()
    modelReply.startedAt = modelCall.startedAt
    unit.steps.push(modelCall)
    unit.turns.push({ id: turnId, modelCall, modelReply, text: "", reasoning: "" })
  }

  appendAssistantText(turnId: string, delta: string, reasoningDelta?: string): void {
    const unit = this.openUnit
    if (!unit) return
    let turn = unit.turns.find((t) => t.id === turnId)
    if (!turn) {
      this.startTurn(turnId)
      turn = unit.turns.find((t) => t.id === turnId)
      if (!turn) return
    }
    // Filter on the accumulated text, not on the individual delta: streaming
    // splits the payload JSON across deltas, so no single delta is decisive.
    if (delta) {
      turn.text += delta
      turn.modelReply.content = visibleText(turn)
    }
    if (reasoningDelta) {
      turn.reasoning += reasoningDelta
      turn.modelReply.reasoning = visibleReasoning(turn)
    }
  }

  finishTurn(turnId: string): void {
    const unit = this.openUnit
    if (!unit) return
    const turn = unit.turns.find((t) => t.id === turnId)
    if (!turn) return
    turn.modelCall.state = "completed"
    turn.modelReply.state = "completed"
    turn.modelCall.endedAt = this.now()
    turn.modelReply.endedAt = turn.modelCall.endedAt
    // Empty turn (no text/reasoning/tools) is oh-my-pi bookkeeping
    // (worktree setup, queue poll). Keep it but as distinct "orchestration"
    // type — user requested not to hide even empty steps.
    // Variant A: give it a readable label + content so the dimmed node
    // explains itself instead of looking like a bug.
    const hasContent =
      visibleText(turn).trim().length > 0 || visibleReasoning(turn).trim().length > 0
    const hasTools = turn.modelReply.children.length > 0
    if (!hasContent && !hasTools) {
      turn.modelCall.type = "orchestration"
      turn.modelCall.label = `Harness · turn ${turnId}`
      turn.modelCall.content =
        "harness tick — no model output, no tools (worktree/queue housekeeping)"
      turn.modelCall.children = []
      // Drop the now-irrelevant empty reply from the turn's hierarchy;
      // keep modelReply object for state but not in tree.
    }
  }

  // Pi: tool_call event — before execution, can mutate input. We create ToolCall node.
  onToolCall(toolCallId: string, toolName: string, turnId: string, input?: Record<string, unknown>): StepNode {
    let node = this.toolNodes.get(toolCallId)
    if (node) return node
    const unit = this.ensureOpenUnit(turnId)
    let turn = unit.turns.find((t) => t.id === turnId)
    if (!turn) {
      this.startTurn(turnId)
      turn = unit.turns.find((t) => t.id === turnId)!
    }
    const isSubtask = SUBTASK_TOOLS[toolName] === true
    let label = isSubtask ? `Sub-agent: ${toolName}` : `Tool: ${toolName}`
    let content = ""
    if (isSubtask && input) {
      const task = typeof input["task"] === "string" ? (input["task"] as string) : ""
      const agent = typeof input["agent"] === "string" ? (input["agent"] as string) : ""
      const category = typeof input["category"] === "string" ? (input["category"] as string) : ""
      if (agent) label = `Sub-agent: ${agent}`
      else if (category) label = `Sub-agent: ${category}`
      content = task || category || ""
    }
    node = makeNode(`tc-${toolCallId}`, "tool-call", label, "running", content)
    node.startedAt = this.now()
    if (isSubtask) node.subtask = true
    this.toolNodes.set(toolCallId, node)
    turn.modelReply.children.push(node)
    return node
  }

  // Pi: tool_result / tool_execution_end
  onToolResult(toolCallId: string, toolName: string, result: unknown, isError: boolean): void {
    const node = this.toolNodes.get(toolCallId)
    if (!node) {
      // No prior tool_call — create synthetic node (e.g. if we missed turn_start)
      this.onToolCall(toolCallId, toolName, toolCallId)
      return this.onToolResult(toolCallId, toolName, result, isError)
    }
    node.endedAt = this.now()
    if (isError) {
      node.state = "failed"
      node.content = String(result ?? "error")
      return
    }
    node.state = "completed"
    if (!node.subtask) {
      const text = typeof result === "string" ? result : JSON.stringify(result ?? "")
      node.content = text.slice(0, 2000)
      const hasResult = node.children.some((c) => c.type === "tool-result")
      if (!hasResult) {
        node.children.push(
          makeNode(`tr-${node.id}`, "tool-result", `Result: ${toolName}`, "completed", node.content),
        )
      }
    } else {
      if (result !== null && typeof result === "object" && "task" in result && typeof result.task === "string") {
        node.content = result.task
      } else if (
        result !== null &&
        typeof result === "object" &&
        "content" in result &&
        typeof result.content === "string"
      ) {
        node.content = result.content
      } else if (typeof result === "string") {
        node.content = result.slice(0, 500)
      }
    }
  }

  // Update running state explicitly (tool_execution_start)
  markToolRunning(toolCallId: string): void {
    const node = this.toolNodes.get(toolCallId)
    if (!node) return
    // A tool that already reported an outcome must not fall back to running.
    if (node.state === "completed" || node.state === "failed") return
    node.state = "running"
  }

  closeOpenUnit(): void {
    const unit = this.openUnit
    if (!unit || unit.closed) return
    unit.closed = true
    const last = unit.turns.at(-1)
    if (last) {
      this.finishTurn(last.id)
      const answer = makeAnswer(unit.id, visibleText(last))
      if (answer) {
        unit.steps.push(answer)
      }
    }
    this.openUnit = null
  }
}
