import type { Event, Message, Part, Todo, ToolState } from "@opencode-ai/sdk"
import type { FlowTree, PlanItem, StepNode, StepState, StepType } from "../../flow/types.ts"

interface TurnState {
  messageID: string
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
  closed: boolean
  turns: TurnState[]
}

function makeNode(
  id: string,
  type: StepType,
  label: string,
  state: StepState,
  content = "",
): StepNode {
  return { id, type, label, state, content, children: [] }
}

function planState(status: string): PlanItem["state"] {
  switch (status) {
    case "in_progress":
      return "in-progress"
    case "completed":
      return "completed"
    default:
      return "pending"
  }
}

export class FlowStore {
  private readonly sessionID: string
  private readonly units: UnitState[] = []
  private openUnit: UnitState | null = null
  private readonly messageRoles = new Map<string, "user" | "assistant">()
  private readonly toolNodes = new Map<string, StepNode>()
  private readonly launchNodes = new Map<string, StepNode>()
  private readonly turnTaskCalls = new Map<string, string[]>()
  private readonly turnSubtaskCount = new Map<string, number>()
  private readonly turnUnmatched = new Map<string, StepNode[]>()
  private readonly seenSubtaskParts = new Set<string>()
  private pendingTodos: Todo[] | undefined

  constructor(sessionID: string) {
    this.sessionID = sessionID
  }

  dispatch(event: Event): void {
    switch (event.type) {
      case "message.updated":
        this.onMessage(event.properties.info)
        break
      case "message.part.updated":
        this.onPart(event.properties.part, event.properties.delta)
        break
      case "todo.updated":
        this.onTodos(event.properties.todos)
        break
      case "session.idle":
        this.closeOpenUnit()
        break
    }
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

  private onMessage(message: Message): void {
    this.messageRoles.set(message.id, message.role)
    if (message.role === "assistant" && message.time.completed !== undefined) {
      const turn = this.findTurn(message.id)
      if (turn) {
        this.completeTurn(turn)
      }
    }
  }

  private ensureOpenUnit(id: string): UnitState {
    if (!this.openUnit) {
      const unit: UnitState = {
        id,
        request: makeNode(`ur-${id}`, "user-request", "User request", "completed"),
        steps: [],
        plan: this.takePendingTodos(),
        closed: false,
        turns: [],
      }
      this.units.push(unit)
      this.openUnit = unit
    }
    return this.openUnit
  }

  private takePendingTodos(): PlanItem[] {
    const todos = this.pendingTodos
    this.pendingTodos = undefined
    return todos ? this.toPlan(todos) : []
  }

  private toPlan(todos: Todo[]): PlanItem[] {
    return todos
      .filter((todo) => todo.status !== "cancelled")
      .map((todo) => ({ id: todo.id, title: todo.content, state: planState(todo.status) }))
  }

  private startUnit(messageID: string): void {
    this.closeOpenUnit()
    this.ensureOpenUnit(messageID)
  }

  private closeOpenUnit(): void {
    const unit = this.openUnit
    if (!unit || unit.closed) {
      return
    }
    unit.closed = true
    const last = unit.turns.at(-1)
    if (last) {
      this.completeTurn(last)
      const text = last.text.trim()
      if (text.length > 0) {
        unit.steps.push(makeNode(`ans-${unit.id}`, "answer", "Answer", "completed", text))
      }
    }
    this.openUnit = null
  }

  private onPart(part: Part, delta?: string): void {
    switch (part.type) {
      case "text":
        this.onText(part, delta)
        break
      case "reasoning":
        this.onReasoning(part, delta)
        break
      case "step-start":
        this.startTurn(part.messageID)
        break
      case "step-finish":
        this.finishTurn(part.messageID)
        break
      case "tool":
        this.onTool(part)
        break
      case "subtask":
        this.onSubtask(part)
        break
    }
  }

  private onText(part: Extract<Part, { type: "text" }>, delta?: string): void {
    if (part.synthetic) {
      return
    }
    const chunk = delta ?? part.text
    const role = this.messageRoles.get(part.messageID)
    if (role === "user") {
      const unit = this.openUnit
      if (!unit || unit.id !== part.messageID) {
        this.startUnit(part.messageID)
      }
      const current = this.openUnit
      if (current) {
        current.request.content += chunk
      }
      return
    }
    if (role !== "assistant") {
      return
    }
    const turn = this.ensureTurn(part.messageID)
    if (turn) {
      turn.text += chunk
      turn.modelReply.content = turn.text
      turn.modelReply.reasoning = turn.reasoning
    }
  }

  private onReasoning(part: Extract<Part, { type: "reasoning" }>, delta?: string): void {
    const turn = this.ensureTurn(part.messageID)
    if (turn) {
      turn.reasoning += delta ?? part.text
      turn.modelReply.reasoning = turn.reasoning
    }
  }

  private startTurn(messageID: string): void {
    const unit = this.openUnit
    if (!unit || this.findTurn(messageID)) {
      return
    }
    const modelCall = makeNode(`mc-${messageID}`, "model-call", "Model call", "running")
    const modelReply = makeNode(`mr-${messageID}`, "model-reply", "Model reply", "running")
    modelCall.children.push(modelReply)
    unit.steps.push(modelCall)
    unit.turns.push({ messageID, modelCall, modelReply, text: "", reasoning: "" })
  }

  private finishTurn(messageID: string): void {
    const turn = this.findTurn(messageID)
    if (turn) {
      this.completeTurn(turn)
    }
  }

  private completeTurn(turn: TurnState): void {
    turn.modelCall.state = "completed"
    turn.modelReply.state = "completed"
  }

  private findTurn(messageID: string): TurnState | undefined {
    const unit = this.openUnit
    if (!unit) {
      return undefined
    }
    return unit.turns.find((turn) => turn.messageID === messageID)
  }

  private ensureTurn(messageID: string): TurnState | undefined {
    const existing = this.findTurn(messageID)
    if (existing) {
      return existing
    }
    this.startTurn(messageID)
    return this.findTurn(messageID)
  }

  private onTool(part: Extract<Part, { type: "tool" }>): void {
    if (part.tool === "task") {
      const turn = this.ensureTurn(part.messageID)
      if (!turn) {
        return
      }
      this.applyToolState(this.ensureLaunchNode(turn, part), part.state)
      return
    }
    let node = this.toolNodes.get(part.callID)
    if (!node) {
      const turn = this.ensureTurn(part.messageID)
      if (!turn) {
        return
      }
      node = makeNode(`tc-${part.callID}`, "tool-call", `Tool: ${part.tool}`, "pending")
      this.toolNodes.set(part.callID, node)
      turn.modelReply.children.push(node)
    }
    this.applyToolState(node, part.state)
  }

  private ensureLaunchNode(turn: TurnState, part: Extract<Part, { type: "tool" }>): StepNode {
    let node = this.launchNodes.get(part.callID)
    if (!node) {
      const unmatched = this.turnUnmatched.get(part.messageID) ?? []
      node = unmatched.shift()
      if (node) {
        this.launchNodes.set(part.callID, node)
      }
    }
    if (!node) {
      node = makeNode(`launch-${part.callID}`, "tool-call", "Tool: task", "pending")
      node.subtask = true
      this.launchNodes.set(part.callID, node)
      turn.modelReply.children.push(node)
    }
    const calls = this.turnTaskCalls.get(part.messageID) ?? []
    calls.push(part.callID)
    this.turnTaskCalls.set(part.messageID, calls)
    return node
  }

  private applyToolState(node: StepNode, state: ToolState): void {
    switch (state.status) {
      case "pending":
        node.state = "pending"
        break
      case "running":
        node.state = "running"
        break
      case "completed": {
        node.state = "completed"
        if (!node.subtask) {
          node.content = state.output
          const hasResult = node.children.some((child) => child.type === "tool-result")
          if (!hasResult) {
            node.children.push(
              makeNode(
                `tr-${node.id}`,
                "tool-result",
                `Result: ${state.title}`,
                "completed",
                state.output,
              ),
            )
          }
        }
        break
      }
      case "error":
        node.state = "failed"
        node.content = node.subtask ? `${node.content}\n${state.error}` : state.error
        break
    }
  }

  private onSubtask(part: Extract<Part, { type: "subtask" }>): void {
    if (this.seenSubtaskParts.has(part.id)) {
      return
    }
    this.seenSubtaskParts.add(part.id)
    const turn = this.ensureTurn(part.messageID)
    if (!turn) {
      return
    }
    const ordinal = this.turnSubtaskCount.get(part.messageID) ?? 0
    this.turnSubtaskCount.set(part.messageID, ordinal + 1)
    const callID = (this.turnTaskCalls.get(part.messageID) ?? [])[ordinal]
    let node = callID ? this.launchNodes.get(callID) : undefined
    if (!node) {
      node = makeNode(
        `subtask-${part.id}`,
        "tool-call",
        `Sub-agent: ${part.agent}`,
        "running",
        part.description,
      )
      node.subtask = true
      this.launchNodes.set(`subtask-${part.id}`, node)
      const unmatched = this.turnUnmatched.get(part.messageID) ?? []
      unmatched.push(node)
      this.turnUnmatched.set(part.messageID, unmatched)
      turn.modelReply.children.push(node)
    } else {
      node.label = `Sub-agent: ${part.agent}`
      node.content = part.description
      if (node.state === "pending") {
        node.state = "running"
      }
    }
  }

  private onTodos(todos: Todo[]): void {
    const unit = this.openUnit
    if (!unit) {
      this.pendingTodos = todos
      return
    }
    unit.plan = this.toPlan(todos)
  }
}
