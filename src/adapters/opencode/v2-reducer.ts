import type { FlowTree, PlanItem, StepNode, StepState } from "../../flow/types.ts"
import { makeAnswer, makeNode } from "../../flow/nodes.ts"
import { planState, toTokenUsage } from "./reducer.ts"

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

/** One text or reasoning block of a step; both kinds share the ordinal sequence. */
interface BlockRef extends StepRef {
  ordinal: number
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

/** What the `subagent` tool reports about the child session it drives. */
interface ToolMetadata {
  sessionID?: string
  status?: string
}

export type V2Event =
  | Envelope<"session.created", SessionRef & { parentID?: string }>
  | Envelope<"session.inbox.enqueued", SessionRef & { inboxID: string; item: InboxItem }>
  | Envelope<"session.inbox.delivered", SessionRef & { inboxID: string }>
  | Envelope<"session.inbox.cancelled", SessionRef & { inboxID: string }>
  | Envelope<"session.execution.succeeded", SessionRef>
  | Envelope<"session.execution.failed", SessionRef>
  | Envelope<"session.execution.interrupted", SessionRef>
  | Envelope<"session.step.started", StepRef & { started: number }>
  | Envelope<"session.step.ended", StepRef & { cost: number; tokens: TokenUsageV2 }>
  | Envelope<"session.step.failed", StepRef & { error: unknown; cost?: number; tokens?: TokenUsageV2 }>
  | Envelope<"session.text.delta", BlockRef & { delta: string }>
  | Envelope<"session.text.ended", BlockRef & { text: string }>
  | Envelope<"session.reasoning.delta", BlockRef & { delta: string }>
  | Envelope<"session.reasoning.ended", BlockRef & { text: string }>
  | Envelope<"session.tool.input.started", ToolRef & { name: string }>
  | Envelope<"session.tool.called", ToolRef & { input: Record<string, unknown> }>
  | Envelope<"session.tool.progress", ToolRef & { metadata: ToolMetadata }>
  | Envelope<"session.tool.success", ToolRef & { content: ContentV2[]; metadata?: ToolMetadata }>
  | Envelope<"session.tool.failed", ToolRef & { error: unknown }>

export const V2_EVENT_TYPES = [
  "session.created",
  "session.inbox.enqueued",
  "session.inbox.delivered",
  "session.inbox.cancelled",
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
  "session.tool.progress",
  "session.tool.success",
  "session.tool.failed",
] as const satisfies readonly V2Event["type"][]

// Fails to compile when a `V2Event` member is missing from the subscription list.
const allSubscribed: Exclude<V2Event["type"], (typeof V2_EVENT_TYPES)[number]> extends never ? true : never = true
void allSubscribed

/** V2's built-in tool names for launching a sub-agent and keeping the plan. */
const SUBAGENT_TOOL = "subagent"
const TODO_TOOL = "todowrite"

interface TurnState {
  messageID: string
  modelCall: StepNode
  modelReply: StepNode
  /** Indexed by the event `ordinal`, so each array has holes for the other kind. */
  text: string[]
  reasoning: string[]
}

interface UnitState {
  id: string
  request: StepNode
  steps: StepNode[]
  plan: PlanItem[]
  turns: TurnState[]
}

interface ToolState {
  name: string
  node: StepNode
}

type Settled = Extract<StepState, "completed" | "failed">

function errorMessage(error: unknown): string {
  if (typeof error === "object" && error !== null && "message" in error) {
    return String(error.message)
  }
  return typeof error === "string" ? error : JSON.stringify(error)
}

function contentText(content: ContentV2[]): string {
  return content.map((item) => item.text ?? "").join("\n")
}

function joinBlocks(blocks: string[]): string {
  return blocks.filter((block) => block !== undefined).join("\n")
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined
}

/** Steps left running when an execution fails or is interrupted never get their own end event. */
function failUnsettled(nodes: StepNode[]): void {
  for (const node of nodes) {
    if (node.state === "running" || node.state === "pending") {
      node.state = "failed"
    }
    failUnsettled(node.children)
  }
}

export class V2FlowStore {
  private readonly sessionID: string
  private readonly units: UnitState[] = []
  private openUnit: UnitState | null = null
  /**
   * Inbox items are announced on enqueue but start work on delivery: a user
   * prompt's text, or `null` for a synthetic item.
   */
  private readonly queued = new Map<string, string | null>()
  private readonly tools = new Map<string, ToolState>()
  /** Child session id → the `subagent` call driving it, for background runs. */
  private readonly childCalls = new Map<string, string>()
  private pendingPlan: PlanItem[] | undefined

  constructor(sessionID: string) {
    this.sessionID = sessionID
  }

  dispatch(event: V2Event): void {
    switch (event.type) {
      case "session.inbox.enqueued":
        this.onEnqueued(event.data.inboxID, event.data.item)
        break
      case "session.inbox.delivered":
        this.onDelivered(event.data.inboxID)
        break
      case "session.inbox.cancelled":
        this.queued.delete(event.data.inboxID)
        break
      case "session.execution.succeeded":
        this.closeOpenUnit(false)
        break
      case "session.execution.failed":
      case "session.execution.interrupted":
        this.closeOpenUnit(true)
        break
      case "session.step.started":
        this.onStepStarted(event.data.assistantMessageID, event.data.started)
        break
      case "session.step.ended":
        this.onStepSettled(event.data, event.created, "completed")
        break
      case "session.step.failed":
        this.onStepSettled(event.data, event.created, "failed", errorMessage(event.data.error))
        break
      case "session.text.delta":
        this.onBlock("text", event.data, event.data.delta, true)
        break
      case "session.text.ended":
        this.onBlock("text", event.data, event.data.text, false)
        break
      case "session.reasoning.delta":
        this.onBlock("reasoning", event.data, event.data.delta, true)
        break
      case "session.reasoning.ended":
        this.onBlock("reasoning", event.data, event.data.text, false)
        break
      case "session.tool.input.started":
        this.onToolStarted(event.data, event.data.name)
        break
      case "session.tool.called":
        this.onToolCalled(event)
        break
      case "session.tool.progress":
        this.trackChild(event.data.id, event.data.metadata)
        break
      case "session.tool.success":
        this.onToolSuccess(event)
        break
      case "session.tool.failed":
        this.settleTool(event.data.id, event.created, "failed", errorMessage(event.data.error))
        break
    }
  }

  /** A background sub-agent's own execution ended: settle the launch node waiting on it. */
  childFinished(childSessionID: string, at: number, state: Settled): void {
    const callID = this.childCalls.get(childSessionID)
    const node = callID ? this.tools.get(callID)?.node : undefined
    if (node?.state === "running") {
      node.state = state
      node.endedAt = at
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

  private onEnqueued(inboxID: string, item: InboxItem): void {
    if (item.type === "user") {
      this.queued.set(inboxID, item.payload?.text ?? "")
    } else if (item.type === "synthetic") {
      this.queued.set(inboxID, null)
    }
  }

  private onDelivered(inboxID: string): void {
    const text = this.queued.get(inboxID)
    if (text === undefined) {
      return
    }
    this.queued.delete(inboxID)
    if (text === null) {
      // A synthetic item (e.g. a background sub-agent's completion notice) wakes the
      // agent to continue the last request rather than starting a new one.
      this.reopenLastUnit()
      return
    }
    this.closeOpenUnit(false)
    const unit: UnitState = {
      id: inboxID,
      request: makeNode(`ur-${inboxID}`, "user-request", "User request", "completed", text),
      steps: [],
      plan: this.pendingPlan ?? [],
      turns: [],
    }
    this.pendingPlan = undefined
    this.units.push(unit)
    this.openUnit = unit
  }

  private reopenLastUnit(): void {
    const unit = this.units.at(-1)
    if (this.openUnit || !unit) {
      return
    }
    if (unit.steps.at(-1)?.type === "answer") {
      unit.steps.pop()
    }
    this.openUnit = unit
  }

  private closeOpenUnit(failed: boolean): void {
    const unit = this.openUnit
    if (!unit) {
      return
    }
    this.openUnit = null
    if (failed) {
      failUnsettled(unit.steps)
    }
    const last = unit.turns.at(-1)
    if (!last) {
      return
    }
    this.settleTurn(last, "completed")
    const answer = makeAnswer(unit.id, joinBlocks(last.text))
    if (answer) {
      unit.steps.push(answer)
    }
  }

  private onStepStarted(messageID: string, started: number): void {
    const turn = this.ensureTurn(messageID)
    if (turn) {
      turn.modelCall.startedAt = started
      turn.modelReply.startedAt = started
    }
  }

  private onStepSettled(
    data: StepRef & { cost?: number; tokens?: TokenUsageV2 },
    at: number,
    state: Settled,
    error?: string,
  ): void {
    const turn = this.findTurn(data.assistantMessageID)
    if (!turn) {
      return
    }
    if (data.cost !== undefined) {
      turn.modelCall.cost = data.cost
    }
    if (data.tokens) {
      turn.modelCall.tokens = toTokenUsage(data.tokens)
    }
    turn.modelCall.endedAt = at
    turn.modelReply.endedAt = at
    if (state === "failed") {
      turn.modelCall.content = error ?? ""
    }
    this.settleTurn(turn, state)
  }

  /** Deltas stream a block; its `ended` event carries the authoritative full text. */
  private onBlock(kind: "text" | "reasoning", ref: BlockRef, chunk: string, append: boolean): void {
    const turn = this.ensureTurn(ref.assistantMessageID)
    if (!turn) {
      return
    }
    const blocks = turn[kind]
    const field = kind === "text" ? "content" : "reasoning"
    const extendsLast = append && ref.ordinal === blocks.length - 1
    blocks[ref.ordinal] = append ? (blocks[ref.ordinal] ?? "") + chunk : chunk
    // Deltas almost always extend the newest block: append instead of re-joining every block.
    turn.modelReply[field] = extendsLast ? (turn.modelReply[field] ?? "") + chunk : joinBlocks(blocks)
  }

  /** A failed turn stays failed; closing its unit later must not complete it. */
  private settleTurn(turn: TurnState, state: Settled): void {
    if (turn.modelCall.state === "failed") {
      return
    }
    turn.modelCall.state = state
    turn.modelReply.state = state
  }

  private findTurn(messageID: string): TurnState | undefined {
    const turns = this.openUnit?.turns
    const last = turns?.at(-1)
    return last?.messageID === messageID ? last : turns?.find((turn) => turn.messageID === messageID)
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
    let node: StepNode
    if (name === SUBAGENT_TOOL) {
      node = makeNode(`launch-${ref.id}`, "tool-call", "Sub-agent", "pending")
      node.subtask = true
    } else {
      node = makeNode(`tc-${ref.id}`, "tool-call", `Tool: ${name}`, "pending")
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
      const agent = nonEmptyString(input.agent) ?? "agent"
      tool.node.content = nonEmptyString(input.description) ?? ""
      if (nonEmptyString(input.sessionID)) {
        // A follow-up drives a child already grafted under its original launch,
        // so it is a plain node: grafting it again would duplicate that subtree.
        tool.node.subtask = false
        tool.node.label = `Sub-agent follow-up: ${agent}`
      } else {
        tool.node.label = `Sub-agent: ${agent}`
      }
    } else if (tool.name === TODO_TOOL && Array.isArray(input.todos)) {
      this.onTodos(input.todos)
    }
  }

  private trackChild(callID: string, metadata: ToolMetadata | undefined): void {
    const child = nonEmptyString(metadata?.sessionID)
    const tool = this.tools.get(callID)
    if (child && tool?.name === SUBAGENT_TOOL) {
      this.childCalls.set(child, callID)
      tool.node.childSessionID = child
    }
  }

  private onToolSuccess(event: Extract<V2Event, { type: "session.tool.success" }>): void {
    const { id, metadata } = event.data
    this.trackChild(id, metadata)
    // A background sub-agent returns at once; its node settles when the child does.
    if (this.tools.get(id)?.name === SUBAGENT_TOOL && metadata?.status === "running") {
      return
    }
    this.settleTool(id, event.created, "completed", contentText(event.data.content))
  }

  private settleTool(callID: string, at: number, state: Settled, text: string): void {
    const tool = this.tools.get(callID)
    if (!tool) {
      return
    }
    const node = tool.node
    node.state = state
    node.endedAt = at
    if (state === "failed") {
      node.content = node.subtask ? [node.content, text].filter(Boolean).join("\n") : text
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
      return [{ id: `todo-${index}`, title: String(content ?? ""), state: planState(String(status)) }]
    })
    if (this.openUnit) {
      this.openUnit.plan = plan
    } else {
      this.pendingPlan = plan
    }
  }
}
