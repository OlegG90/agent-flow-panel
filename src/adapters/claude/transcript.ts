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
    case "Task":
      return pick("description")
    case "WebFetch":
      return pick("url")
    default:
      return pick("description") || pick("command") || pick("file_path") || pick("pattern")
  }
}

const MAX_RESULT_CHARS = 2000

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
  /** assistant record uuid → the tool nodes it launched, for sidechain grafting. */
  const launchedBy = new Map<string, StepNode[]>()
  const sidechainScopes = new Map<string, Scope>()

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

    if (record.isSidechain) {
      applySidechain(record, at, startedBefore)
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
  for (const scope of sidechainScopes.values()) {
    closeScope(scope)
  }

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
        if (!node.subtask && !node.children.some((child) => child.type === "tool-result")) {
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
        if (block.name === "Task") {
          node.subtask = true
          node.content = title
          if (record.uuid) {
            const launched = launchedBy.get(record.uuid) ?? []
            launched.push(node)
            launchedBy.set(record.uuid, launched)
          }
        }
        toolNodes.set(block.id, node)
        turn.reply.children.push(node)
      }
    }
  }

  /**
   * Sub-agent records live in the same file, marked `isSidechain` and threaded
   * by `parentUuid` back to the assistant record that ran the Task tool.
   *
   * UNVERIFIED against a real sample: no transcript available while building
   * this carried a single sidechain record. The shape follows the fields the
   * format already uses; treat it as the least-confident part of the adapter.
   */
  function applySidechain(
    record: TranscriptRecord,
    at: number | undefined,
    startedBefore: number | undefined,
  ): void {
    const parent = record.parentUuid ?? undefined
    let scope = parent ? sidechainScopes.get(parent) : undefined

    if (!scope && parent && isHumanPrompt(record)) {
      // The sub-agent's own brief: the first record of the sidechain.
      const host = (launchedBy.get(parent) ?? [])[0]
      const id = record.uuid ?? `sub-${sidechainScopes.size}`
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
      scope = { unit, turns: new Map(), lastTurn: undefined }
      sidechainScopes.set(parent, scope)
      if (record.uuid) {
        sidechainScopes.set(record.uuid, scope)
      }
      if (host) {
        host.children.push(unit.request)
      }
      return
    }

    if (!scope) {
      return
    }
    if (record.uuid) {
      sidechainScopes.set(record.uuid, scope)
    }
    const before = scope.unit.steps.length
    applyToScope(scope, record, at, startedBefore)
    // Newly created steps belong under the launch node, not at unit level.
    const host = findHostOf(scope)
    if (host) {
      for (const step of scope.unit.steps.slice(before)) {
        if (!host.children.includes(step)) {
          host.children.push(step)
        }
      }
    }
  }

  function findHostOf(scope: Scope): StepNode | undefined {
    for (const [parentUuid, candidate] of sidechainScopes) {
      if (candidate !== scope) {
        continue
      }
      const launched = launchedBy.get(parentUuid)
      if (launched && launched[0]) {
        return launched[0]
      }
    }
    return undefined
  }
}
