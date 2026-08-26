import type { FlowTree, PlanItem, StepNode, StepState, StepType } from "../../flow/types.ts"

function makeNode(
  id: string,
  type: StepType,
  label: string,
  state: StepState,
  content = "",
): StepNode {
  return { id, type, label, state, content, children: [] }
}

// Oh-my-pi delegation tools — treated as subtask launches (analog of OpenCode `task`)
const SUBTASK_TOOLS: Record<string, true> = {
  oh_my_pi_delegate_task: true,
  oh_my_pi_subagent: true,
}

interface TurnState {
  id: string
  modelCall: StepNode
  modelReply: StepNode
  text: string
  reasoning: string
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

  constructor(sessionID: string) {
    this.sessionID = sessionID
  }

  tree(): FlowTree {
    return {
      sessionID: this.sessionID,
      units: this.units.map((unit) => {
        const steps = structuredClone(unit.steps).map((step) => {
          if (step.type === "model-call" && step.children[0]) {
            const reply = step.children[0]!
            if (reply.content.trimStart().startsWith('{"i":') && reply.children.length > 0) {
              reply.content = ""
            }
          }
          return step
        })
        return {
          id: unit.id,
          request: structuredClone(unit.request),
          steps,
          plan: unit.plan.map((item) => ({ ...item })),
        }
      }),
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
    unit.steps.push(modelCall)
    unit.turns.push({ id: turnId, modelCall, modelReply, text: "", reasoning: "" })
  }

  appendAssistantText(turnId: string, delta: string, reasoningDelta?: string): void {
    // oh-my-pi streams delegate_task payload as text_delta with JSON like
    // {"i":"...","path":"..."} — must not be shown as Model reply.
    const isTaskPayload = (s: string): boolean => s.trimStart().startsWith('{"i":')
    if (delta && isTaskPayload(delta)) return
    if (reasoningDelta && isTaskPayload(reasoningDelta)) return
    const unit = this.openUnit
    if (!unit) return
    let turn = unit.turns.find((t) => t.id === turnId)
    if (!turn) {
      this.startTurn(turnId)
      turn = unit.turns.find((t) => t.id === turnId)
      if (!turn) return
    }
    if (delta) {
      turn.text += delta
      turn.modelReply.content = turn.text
    }
    if (reasoningDelta) {
      turn.reasoning += reasoningDelta
      turn.modelReply.reasoning = turn.reasoning
    }
  }

  finishTurn(turnId: string): void {
    const unit = this.openUnit
    if (!unit) return
    const turn = unit.turns.find((t) => t.id === turnId)
    if (!turn) return
    turn.modelCall.state = "completed"
    turn.modelReply.state = "completed"
    // Empty turn (no text/reasoning/tools) is oh-my-pi bookkeeping
    // (worktree setup, queue poll). Keep it but as distinct "orchestration"
    // type — user requested not to hide even empty steps.
    const hasContent = turn.text.trim().length > 0 || turn.reasoning.trim().length > 0
    const hasTools = turn.modelReply.children.length > 0
    if (!hasContent && !hasTools) {
      turn.modelCall.type = "orchestration"
      turn.modelCall.label = "Orchestration"
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
    if (node && (node.state === "pending" || node.state === "running")) node.state = "running"
    else if (node && node.state !== "completed" && node.state !== "failed") node.state = "running"
  }

  closeOpenUnit(): void {
    const unit = this.openUnit
    if (!unit || unit.closed) return
    unit.closed = true
    const last = unit.turns.at(-1)
    if (last) {
      this.finishTurn(last.id)
      const text = last.text.trim()
      if (text.length > 0) {
        unit.steps.push(makeNode(`ans-${unit.id}`, "answer", "Answer", "completed", text))
      }
    }
    this.openUnit = null
  }
}
