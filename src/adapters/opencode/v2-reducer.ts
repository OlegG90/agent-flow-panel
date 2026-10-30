import type { FlowTree, PlanItem, StepNode } from "../../flow/types.ts"
import { makeAnswer, makeNode } from "../../flow/nodes.ts"

/**
 * The slice of OpenCode's V2 public event stream (`ctx.event.subscribe`) the
 * flow reads. V2 replaced V1's message/part snapshots with fine-grained
 * session events whose payload lives under `data`; field names mirror
 * `@opencode/schema/session-event` (verified against OpenCode 2.2.3).
 */
interface Envelope<Type extends string, Data> {
  type: Type
  created: number
  data: Data
}

interface SessionRef {
  sessionID: string
}

interface StepRef extends SessionRef {
  assistantMessageID: string
}

interface ToolRef extends StepRef {
  id: string
}

interface TokenUsageV2 {
  input: number
  output: number
  reasoning: number
  cache: { read: number; write: number }
}

interface InboxItem {
  type: string
  payload?: { text?: string }
}

interface ContentV2 {
  type: string
  text?: string
}

export type V2Event =
  | Envelope<"session.created", SessionRef & { parentID?: string }>
  | Envelope<"session.inbox.enqueued", SessionRef & { inboxID: string; item: InboxItem }>
  | Envelope<"session.inbox.delivered", SessionRef & { inboxID: string }>
  | Envelope<"session.execution.succeeded", SessionRef>
  | Envelope<"session.execution.failed", SessionRef>
  | Envelope<"session.execution.interrupted", SessionRef>
  | Envelope<"session.step.started", StepRef & { started: number }>
  | Envelope<"session.step.ended", StepRef & { cost: number; tokens: TokenUsageV2 }>
  | Envelope<"session.step.failed", StepRef & { error: unknown; cost?: number; tokens?: TokenUsageV2 }>
  | Envelope<"session.text.delta", StepRef & { ordinal: number; delta: string }>
  | Envelope<"session.text.ended", StepRef & { ordinal: number; text: string }>
  | Envelope<"session.reasoning.delta", StepRef & { ordinal: number; delta: string }>
  | Envelope<"session.reasoning.ended", StepRef & { ordinal: number; text: string }>
  | Envelope<"session.tool.input.started", ToolRef & { name: string }>
  | Envelope<"session.tool.called", ToolRef & { input: Record<string, unknown> }>
  | Envelope<"session.tool.success", ToolRef & { content: ContentV2[] }>
  | Envelope<"session.tool.failed", ToolRef & { error: unknown }>

export const V2_EVENT_TYPES = [
  "session.created",
  "session.inbox.enqueued",
  "session.inbox.delivered",
  "session.execution.succeeded",
  "session.execution.failed",
  "session.execution.interrupted",
  "session.step.started",
  "session.step.ended",
  "session.step.failed",
  "session.text.delta",
  "session.text.ended",
  "session.reasoning.delta",
  "session.reasoning.ended",
  "session.tool.input.started",
  "session.tool.called",
  "session.tool.success",
  "session.tool.failed",
] as const satisfies readonly V2Event["type"][]

/** V2's built-in tool names for launching a sub-agent and keeping the plan. */
const SUBAGENT_TOOL = "subagent"
const TODO_TOOL = "todowrite"

interface TurnState {
  messageID: string
  modelCall: StepNode
  modelReply: StepNode
  /** Indexed by the event `ordinal`: one entry per text or reasoning block. */
  text: string[]
  reasoning: string[]
}

interface UnitState {
  id: string
  request: StepNode
  steps: StepNode[]
  plan: PlanItem[]
  closed: boolean
  turns: TurnState[]
}

interface ToolState {
  name: string
  node: StepNode
}

function planState(status: unknown): PlanItem["state"] {
  switch (status) {
    case "in_progress":
      return "in-progress"
    case "completed":
      return "completed"
    default:
      return "pending"
  }
}

function errorMessage(error: unknown): string {
  if (typeof error === "object" && error !== null && "message" in error) {
    return String(error.message)
  }
  return typeof error === "string" ? error : JSON.stringify(error)
}

function contentText(content: ContentV2[]): string {
  return content.map((item) => item.text ?? "").join("\n")
}

/** Text and reasoning blocks share one ordinal sequence, so each array has holes. */
function joinBlocks(blocks: string[]): string {
  return blocks.filter((block) => block !== undefined).join("\n")
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined
}

export class FlowStoreV2 {
  private readonly sessionID: string
  private readonly units: UnitState[] = []
  private openUnit: UnitState | null = null
  /** User prompts are announced on enqueue but start work on delivery. */
  private readonly queuedPrompts = new Map<string, string>()
  private readonly tools = new Map<string, ToolState>()
  private pendingPlan: PlanItem[] | undefined

  constructor(sessionID: string) {
    this.sessionID = sessionID
  }

  dispatch(event: V2Event): void {
    switch (event.type) {
      case "session.inbox.enqueued":
        if (event.data.item.type === "user") {
          this.queuedPrompts.set(event.data.inboxID, event.data.item.payload?.text ?? "")
        }
        break
      case "session.inbox.delivered":
        this.onDelivered(event.data.inboxID)
        break
      case "session.execution.succeeded":
      case "session.execution.failed":
      case "session.execution.interrupted":
        this.closeOpenUnit()
        break
      case "session.step.started":
        this.onStepStarted(event.data.assistantMessageID, event.data.started)
        break
      case "session.step.ended":
        this.onStepEnded(event)
        break
      case "session.step.failed":
        this.onStepFailed(event)
        break
      case "session.text.delta":
        this.onText(event.data, event.data.delta, true)
        break
      case "session.text.ended":
        this.onText(event.data, event.data.text, false)
        break
      case "session.reasoning.delta":
        this.onReasoning(event.data, event.data.delta, true)
        break
      case "session.reasoning.ended":
        this.onReasoning(event.data, event.data.text, false)
        break
      case "session.tool.input.started":
        this.onToolStarted(event.data, event.data.name)
        break
      case "session.tool.called":
        this.onToolCalled(event)
        break
      case "session.tool.success":
        this.onToolSettled(event.data.id, event.created, "completed", contentText(event.data.content))
        break
      case "session.tool.failed":
        this.onToolSettled(event.data.id, event.created, "failed", errorMessage(event.data.error))
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

  private onDelivered(inboxID: string): void {
    const text = this.queuedPrompts.get(inboxID)
    if (text === undefined) {
      return
    }
    this.queuedPrompts.delete(inboxID)
    this.closeOpenUnit()
    const unit: UnitState = {
      id: inboxID,
      request: makeNode(`ur-${inboxID}`, "user-request", "User request", "completed", text),
      steps: [],
      plan: this.pendingPlan ?? [],
      closed: false,
      turns: [],
    }
    this.pendingPlan = undefined
    this.units.push(unit)
    this.openUnit = unit
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
      const answer = makeAnswer(unit.id, joinBlocks(last.text))
      if (answer) {
        unit.steps.push(answer)
      }
    }
    this.openUnit = null
  }

  private onStepStarted(messageID: string, started: number): void {
    const turn = this.ensureTurn(messageID)
    if (turn) {
      turn.modelCall.startedAt = started
      turn.modelReply.startedAt = started
    }
  }

  private onStepEnded(event: Extract<V2Event, { type: "session.step.ended" }>): void {
    const turn = this.findTurn(event.data.assistantMessageID)
    if (!turn) {
      return
    }
    this.applyUsage(turn, event.data.cost, event.data.tokens)
    turn.modelCall.endedAt = event.created
    turn.modelReply.endedAt = event.created
    this.completeTurn(turn)
  }

  private onStepFailed(event: Extract<V2Event, { type: "session.step.failed" }>): void {
    const turn = this.findTurn(event.data.assistantMessageID)
    if (!turn) {
      return
    }
    this.applyUsage(turn, event.data.cost, event.data.tokens)
    turn.modelCall.endedAt = event.created
    turn.modelReply.endedAt = event.created
    turn.modelCall.state = "failed"
    turn.modelReply.state = "failed"
    turn.modelCall.content = errorMessage(event.data.error)
  }

  private applyUsage(turn: TurnState, cost: number | undefined, tokens: TokenUsageV2 | undefined): void {
    if (cost !== undefined) {
      turn.modelCall.cost = cost
    }
    if (tokens) {
      turn.modelCall.tokens = {
        input: tokens.input,
        output: tokens.output,
        reasoning: tokens.reasoning,
        cacheRead: tokens.cache.read,
        cacheWrite: tokens.cache.write,
      }
    }
  }

  /** Deltas stream a block; its `ended` event carries the authoritative full text. */
  private onText(ref: StepRef & { ordinal: number }, chunk: string, append: boolean): void {
    const turn = this.ensureTurn(ref.assistantMessageID)
    if (!turn) {
      return
    }
    turn.text[ref.ordinal] = append ? (turn.text[ref.ordinal] ?? "") + chunk : chunk
    turn.modelReply.content = joinBlocks(turn.text)
  }

  private onReasoning(ref: StepRef & { ordinal: number }, chunk: string, append: boolean): void {
    const turn = this.ensureTurn(ref.assistantMessageID)
    if (!turn) {
      return
    }
    turn.reasoning[ref.ordinal] = append ? (turn.reasoning[ref.ordinal] ?? "") + chunk : chunk
    turn.modelReply.reasoning = joinBlocks(turn.reasoning)
  }

  private completeTurn(turn: TurnState): void {
    if (turn.modelCall.state === "failed") {
      return
    }
    turn.modelCall.state = "completed"
    turn.modelReply.state = "completed"
  }

  private findTurn(messageID: string): TurnState | undefined {
    return this.openUnit?.turns.find((turn) => turn.messageID === messageID)
  }

  private ensureTurn(messageID: string): TurnState | undefined {
    const unit = this.openUnit
    if (!unit) {
      return undefined
    }
    const existing = this.findTurn(messageID)
    if (existing) {
      return existing
    }
    const modelCall = makeNode(`mc-${messageID}`, "model-call", "Model call", "running")
    const modelReply = makeNode(`mr-${messageID}`, "model-reply", "Model reply", "running")
    modelCall.children.push(modelReply)
    unit.steps.push(modelCall)
    const turn: TurnState = { messageID, modelCall, modelReply, text: [], reasoning: [] }
    unit.turns.push(turn)
    return turn
  }

  private onToolStarted(ref: ToolRef, name: string): void {
    if (this.tools.has(ref.id)) {
      return
    }
    const turn = this.ensureTurn(ref.assistantMessageID)
    if (!turn) {
      return
    }
    const node =
      name === SUBAGENT_TOOL
        ? makeNode(`launch-${ref.id}`, "tool-call", "Sub-agent", "pending")
        : makeNode(`tc-${ref.id}`, "tool-call", `Tool: ${name}`, "pending")
    if (name === SUBAGENT_TOOL) {
      node.subtask = true
    }
    this.tools.set(ref.id, { name, node })
    turn.modelReply.children.push(node)
  }

  private onToolCalled(event: Extract<V2Event, { type: "session.tool.called" }>): void {
    const { input } = event.data
    // A late-joined stream can deliver `called` without its `input.started`, which carries the name.
    this.onToolStarted(event.data, this.tools.get(event.data.id)?.name ?? "tool")
    const tool = this.tools.get(event.data.id)
    if (!tool) {
      return
    }
    tool.node.state = "running"
    tool.node.startedAt = event.created
    if (tool.name === SUBAGENT_TOOL) {
      tool.node.label = `Sub-agent: ${str(input.agent) ?? "agent"}`
      tool.node.content = str(input.description) ?? ""
    } else if (tool.name === TODO_TOOL && Array.isArray(input.todos)) {
      this.onTodos(input.todos)
    }
  }

  private onToolSettled(callID: string, at: number, state: "completed" | "failed", text: string): void {
    const tool = this.tools.get(callID)
    if (!tool) {
      return
    }
    const node = tool.node
    node.state = state
    node.endedAt = at
    if (state === "failed") {
      node.content = node.subtask ? `${node.content}\n${text}` : text
      return
    }
    if (node.subtask) {
      return
    }
    node.content = text
    if (!node.children.some((child) => child.type === "tool-result")) {
      node.children.push(
        makeNode(`tr-${node.id}`, "tool-result", `Result: ${tool.name}`, "completed", text),
      )
    }
  }

  private onTodos(todos: unknown[]): void {
    const plan = todos.flatMap((todo, index): PlanItem[] => {
      if (typeof todo !== "object" || todo === null) {
        return []
      }
      const { content, status } = todo as { content?: unknown; status?: unknown }
      if (status === "cancelled") {
        return []
      }
      return [{ id: `todo-${index}`, title: String(content ?? ""), state: planState(status) }]
    })
    if (this.openUnit) {
      this.openUnit.plan = plan
    } else {
      this.pendingPlan = plan
    }
  }
}
