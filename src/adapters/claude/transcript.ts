import type { FlowTree, PlanItem, StepNode, StepState, StepType, UnitOfWork } from "../../flow/types.ts"

/**
 * Claude Code keeps a session as an append-only JSONL transcript under
 * `~/.claude/projects/<encoded-cwd>/<session-id>.jsonl`. There is no live
 * event API, so the adapter reduces the file instead of a stream — which also
 * means a finished session can be opened after the fact.
 *
 * Every field used here was read off real transcripts, not documentation.
 */

/** One line of the transcript. Only the fields this reducer reads. */
export interface TranscriptRecord {
  type?: string
  uuid?: string
  parentUuid?: string | null
  isSidechain?: boolean
  requestId?: string
  timestamp?: string
  message?: {
    role?: string
    model?: string
    content?: unknown
    usage?: Record<string, unknown>
  }
  toolUseResult?: unknown
  subtype?: string
  content?: unknown
  error?: unknown
  retryAttempt?: number
  maxRetries?: number
  compactMetadata?: Record<string, unknown>
  originalModel?: string
  fallbackModel?: string
  apiRefusalCategory?: string
}

interface ContentBlock {
  type?: string
  text?: string
  thinking?: string
  name?: string
  id?: string
  input?: Record<string, unknown>
  tool_use_id?: string
  content?: unknown
  is_error?: boolean
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

/**
 * Claude Code has no `ToolState.title`, so the label is built from the tool's
 * own input — the argument, not the tool name, is what tells two steps apart.
 */
function titleOf(name: string, input: Record<string, unknown> | undefined): string {
  if (!input) {
    return ""
  }
  const pick = (key: string): string => (typeof input[key] === "string" ? (input[key] as string) : "")
  switch (name) {
    case "Bash":
      return pick("command")
    case "Read":
    case "Write":
    case "Edit":
    case "NotebookEdit":
      return pick("file_path")
    case "Grep":
    case "Glob":
      return pick("pattern")
    case "Agent":
    case "Task":
      return pick("subagent_type") || pick("description")
    case "WebFetch":
      return pick("url")
    default:
      return pick("description") || pick("command") || pick("file_path") || pick("pattern")
  }
}

const MAX_RESULT_CHARS = 2000

/**
 * Launching a sub-agent. `Agent` is what Claude Code 2.x calls it; `Task` is
 * kept because older transcripts use that name.
 */
const SUBAGENT_TOOLS = new Set(["Agent", "Task"])

function resultTextOf(record: TranscriptRecord, block: ContentBlock): string {
  if (typeof block.content === "string") {
    return block.content
  }
  if (Array.isArray(block.content)) {
    return (block.content as ContentBlock[])
      .filter((b) => b.type === "text" && typeof b.text === "string")
      .map((b) => b.text as string)
      .join("\n")
  }
  const raw = record.toolUseResult
  if (typeof raw === "string") {
    return raw
  }
  if (raw !== null && typeof raw === "object") {
    const obj = raw as Record<string, unknown>
    const streams = [obj["stdout"], obj["stderr"]]
      .filter((value): value is string => typeof value === "string" && value.length > 0)
      .join("\n")
    return streams || JSON.stringify(raw)
  }
  return ""
}

function planFrom(input: Record<string, unknown> | undefined): PlanItem[] {
  const todos = input?.["todos"]
  if (!Array.isArray(todos)) {
    return []
  }
  return todos.map((entry, index) => {
    const todo = entry as Record<string, unknown>
    const status = typeof todo["status"] === "string" ? todo["status"] : "pending"
    return {
      // Claude Code todos carry no id of their own, so it is index-derived:
      // reordering the list renames the items.
      id: `todo-${index}`,
      title: typeof todo["content"] === "string" ? (todo["content"] as string) : "",
      state: status === "in_progress" ? "in-progress" : status === "completed" ? "completed" : "pending",
    }
  })
}

function tokensFrom(usage: Record<string, unknown>): StepNode["tokens"] {
  const num = (key: string): number => (typeof usage[key] === "number" ? (usage[key] as number) : 0)
  return {
    input: num("input_tokens"),
    output: num("output_tokens"),
    // Thinking tokens are nested under output_tokens_details.
    reasoning: (() => {
      const details = usage["output_tokens_details"]
      if (details !== null && typeof details === "object") {
        const value = (details as Record<string, unknown>)["thinking_tokens"]
        return typeof value === "number" ? value : 0
      }
      return 0
    })(),
    cacheRead: num("cache_read_input_tokens"),
    cacheWrite: num("cache_creation_input_tokens"),
  }
}

/**
 * A sub-agent's own steps are NOT written to the transcript — verified by
 * running one: the file gains the launch and its result, nothing between.
 * What the result does carry is a summary of the run, so the launch node shows
 * that instead of an empty branch.
 */
function applyAgentSummary(node: StepNode, result: unknown): void {
  if (result === null || typeof result !== "object") {
    return
  }
  const summary = result as Record<string, unknown>
  const agentType = typeof summary["agentType"] === "string" ? summary["agentType"] : ""
  if (agentType) {
    node.label = `Sub-agent: ${agentType}`
  }
  const usage = summary["usage"]
  if (usage !== null && typeof usage === "object") {
    node.tokens = tokensFrom(usage as Record<string, unknown>)
  }
  const duration = summary["totalDurationMs"]
  if (typeof duration === "number" && node.endedAt !== undefined) {
    // The sub-agent reports its own wall clock, which is truer than the gap
    // between the launch line and the result line.
    node.startedAt = node.endedAt - duration
  }
  const tools = summary["totalToolUseCount"]
  const model = typeof summary["resolvedModel"] === "string" ? summary["resolvedModel"] : ""
  const parts = [model, typeof tools === "number" ? `${tools} tool calls` : ""].filter(Boolean)
  if (parts.length > 0) {
    node.children.push(
      makeNode(`sub-${node.id}`, "orchestration", parts.join(" · "), "completed"),
    )
  }
}

const COMPACT_MAX_CHARS = 400

function compactNumber(value: number): string {
  if (value >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(1)}M`
  }
  return value >= 1000 ? `${(value / 1000).toFixed(1)}k` : String(value)
}

function str(value: unknown): string {
  return typeof value === "string" ? value : ""
}

/**
 * Orchestration on Claude Code means something different than on Pi.
 *
 * Pi's rule — a turn that produced no text, no reasoning and no tool calls —
 * never fires here: of 458 turns in the transcript this was verified against,
 * zero were empty. Claude Code records its bookkeeping as `system` records
 * instead, and only a few of those carry any signal.
 *
 * Deliberately excluded: `stop_hook_summary`. Across all 58 transcripts
 * checked there were 1918 of them, every one with an empty `hookErrors`, no
 * `stopReason` and `preventedContinuation` never set — roughly 24 identical
 * dimmed nodes per session, which is the clutter the node type exists to
 * avoid. Also excluded: `attachment`, `last-prompt`, `ai-title`,
 * `custom-title`, `mode`, `queue-operation`, `pr-link`, `atis-latch`,
 * `bridge-session` — UI and persistence bookkeeping, not agent work.
 */
function systemNodeOf(record: TranscriptRecord, at: number | undefined): StepNode | undefined {
  const id = `sys-${record.uuid ?? String(at ?? "")}`
  switch (record.subtype) {
    case "compact_boundary": {
      const meta = record.compactMetadata ?? {}
      const pre = typeof meta["preTokens"] === "number" ? meta["preTokens"] : undefined
      const post = typeof meta["postTokens"] === "number" ? meta["postTokens"] : undefined
      const trigger = str(meta["trigger"])
      const node = makeNode(
        id,
        "orchestration",
        trigger ? `Context compacted (${trigger})` : "Context compacted",
        "completed",
        pre !== undefined && post !== undefined
          ? `${compactNumber(pre)} → ${compactNumber(post)} tokens`
          : str(record.content),
      )
      const duration = meta["durationMs"]
      if (typeof duration === "number" && at !== undefined) {
        node.startedAt = at - duration
        node.endedAt = at
      }
      return node
    }
    case "api_error": {
      const error = (record.error ?? {}) as Record<string, unknown>
      const status = typeof error["status"] === "number" ? error["status"] : undefined
      const attempt =
        record.retryAttempt !== undefined && record.maxRetries !== undefined
          ? `retry ${record.retryAttempt}/${record.maxRetries}`
          : ""
      // Transport failures carry no status but do carry a readable summary;
      // most api_error records in practice are of that kind.
      const detail = str(error["formatted"]) || str(error["message"]) || str(error["type"])
      return makeNode(
        id,
        "orchestration",
        status !== undefined ? `API error ${status}` : "API error",
        // A retried request is why a step stalled, so it reads as a failure.
        "failed",
        [detail, attempt].filter(Boolean).join(" · "),
      )
    }
    case "model_refusal_fallback": {
      const from = record.originalModel ?? ""
      const to = record.fallbackModel ?? ""
      return makeNode(
        id,
        "orchestration",
        from && to ? `Model fallback: ${from} → ${to}` : "Model fallback",
        "failed",
        [record.apiRefusalCategory, str(record.content)].filter(Boolean).join(" · ").slice(0, COMPACT_MAX_CHARS),
      )
    }
    case "local_command":
      return makeNode(
        id,
        "orchestration",
        "Local command",
        "completed",
        str(record.content).replace(/<\/?local-command-[a-z]+>/g, "").trim().slice(0, COMPACT_MAX_CHARS),
      )
    default:
      return undefined
  }
}

interface Turn {
  call: StepNode
  reply: StepNode
  text: string
}

interface Scope {
  unit: UnitOfWork
  turns: Map<string, Turn>
  lastTurn: Turn | undefined
}

export function parseTranscript(lines: readonly string[]): TranscriptRecord[] {
  const records: TranscriptRecord[] = []
  for (const line of lines) {
    if (!line) {
      continue
    }
    try {
      records.push(JSON.parse(line) as TranscriptRecord)
    } catch {
      // A transcript also carries control records that are not conversation.
    }
  }
  return records
}

/**
 * A human prompt, as opposed to a tool result: Claude Code writes real prompts
 * with a plain-string content and tool results as a `tool_result` array.
 */
function isHumanPrompt(record: TranscriptRecord): boolean {
  return (
    record.type === "user" &&
    typeof record.message?.content === "string" &&
    record.toolUseResult === undefined
  )
}

export function reduceTranscript(lines: readonly string[], sessionID = ""): FlowTree {
  const records = parseTranscript(lines)
  const units: UnitOfWork[] = []
  const toolNodes = new Map<string, StepNode>()

  let main: Scope | undefined
  let previousAt: number | undefined

  const closeScope = (scope: Scope | undefined): void => {
    if (!scope) {
      return
    }
    const text = scope.lastTurn?.text.trim() ?? ""
    if (text.length > 0) {
      scope.unit.steps.push(
        makeNode(`ans-${scope.unit.id}`, "answer", "Answer", "completed", text),
      )
    }
  }

  for (const record of records) {
    const at = record.timestamp ? Date.parse(record.timestamp) : undefined
    const startedBefore = previousAt
    if (at !== undefined && (record.type === "user" || record.type === "assistant")) {
      previousAt = at
    }

    if (record.type === "system") {
      const node = systemNodeOf(record, at)
      if (node && main) {
        main.unit.steps.push(node)
      }
      continue
    }

    if (isHumanPrompt(record)) {
      closeScope(main)
      const id = record.uuid ?? `unit-${units.length}`
      const unit: UnitOfWork = {
        id,
        request: makeNode(
          `ur-${id}`,
          "user-request",
          "User request",
          "completed",
          record.message?.content as string,
        ),
        steps: [],
        plan: [],
      }
      units.push(unit)
      main = { unit, turns: new Map(), lastTurn: undefined }
      continue
    }

    applyToScope(main, record, at, startedBefore)
  }
  closeScope(main)

  return { sessionID, units }

  function applyToScope(
    scope: Scope | undefined,
    record: TranscriptRecord,
    at: number | undefined,
    startedBefore: number | undefined,
  ): void {
    const content = record.message?.content
    if (!scope || !Array.isArray(content)) {
      return
    }

    if (record.type === "user") {
      for (const block of content as ContentBlock[]) {
        if (block.type !== "tool_result" || !block.tool_use_id) {
          continue
        }
        const node = toolNodes.get(block.tool_use_id)
        if (!node) {
          continue
        }
        node.endedAt = at
        const text = resultTextOf(record, block)
        if (block.is_error) {
          node.state = "failed"
          node.content = text.slice(0, MAX_RESULT_CHARS)
          continue
        }
        node.state = "completed"
        node.content = text.slice(0, MAX_RESULT_CHARS)
        if (node.subtask) {
          applyAgentSummary(node, record.toolUseResult)
          continue
        }
        if (!node.children.some((child) => child.type === "tool-result")) {
          node.children.push(
            makeNode(`tr-${node.id}`, "tool-result", "Result", "completed", node.content),
          )
        }
      }
      return
    }

    if (record.type !== "assistant") {
      return
    }

    const key = record.requestId ?? record.uuid ?? ""
    let turn = scope.turns.get(key)
    if (!turn) {
      const call = makeNode(`mc-${key}`, "model-call", "Model call", "completed")
      const reply = makeNode(`mr-${key}`, "model-reply", "Model reply", "completed")
      call.children.push(reply)
      // A transcript timestamp records when the line was written, and most
      // calls occupy a single line — so their own span would be 0ms. The call
      // began when the previous record landed; that gap is the real latency.
      call.startedAt = startedBefore ?? at
      scope.unit.steps.push(call)
      turn = { call, reply, text: "" }
      scope.turns.set(key, turn)
    }
    turn.call.endedAt = at
    scope.lastTurn = turn

    const usage = record.message?.usage
    if (usage) {
      turn.call.tokens = tokensFrom(usage)
    }

    for (const block of content as ContentBlock[]) {
      if (block.type === "text" && block.text) {
        turn.text += block.text
        turn.reply.content = turn.text
      } else if (block.type === "thinking" && block.thinking) {
        turn.reply.reasoning = (turn.reply.reasoning ?? "") + block.thinking
      } else if (block.type === "tool_use" && block.id && block.name) {
        if (block.name === "TodoWrite") {
          scope.unit.plan = planFrom(block.input)
        }
        const title = titleOf(block.name, block.input)
        const node = makeNode(
          `tc-${block.id}`,
          "tool-call",
          title ? `Tool: ${block.name} · ${title}` : `Tool: ${block.name}`,
          "running",
        )
        node.startedAt = at
        if (SUBAGENT_TOOLS.has(block.name)) {
          node.subtask = true
          node.label = `Sub-agent: ${title || block.name}`
          const brief = typeof block.input?.["prompt"] === "string" ? block.input["prompt"] : ""
          node.content = brief || title
        }
        toolNodes.set(block.id, node)
        turn.reply.children.push(node)
      }
    }
  }
}
