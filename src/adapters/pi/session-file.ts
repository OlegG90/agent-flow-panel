import type { FlowTree, StepNode, UnitOfWork } from "../../flow/types.ts"
import { makeAnswer, makeNode } from "../../flow/nodes.ts"

/**
 * Pi / oh-my-pi on-disk session persistence (`sessions/*.jsonl`).
 *
 * This is NOT the live extension event stream (`before_agent_start`,
 * `turn_start`, `message_update`, …): the file stores the conversation as
 * `message{role:user|assistant|toolResult}` records chained by `parentId`,
 * plus `custom{tool_execution_start|session_exit}` markers. Header records
 * (`title`, `session`, `model_change`, `thinking_level_change`) carry no agent
 * work and are ignored.
 *
 * One `user` message opens a Unit of Work; each `assistant` message becomes a
 * turn (`ModelCall` + `ModelReply`); `toolCall` blocks inside the assistant
 * content become `ToolCall` children resolved later by the matching
 * `toolResult` message (linked by `toolCallId`). `custom.tool_execution_start`
 * only marks the node running (Q13a: merged, not a node of its own).
 * `custom.session_exit` closes the open unit with an `Answer` built from the
 * last assistant text. A finished file has nothing running, so close-out also
 * completes any node still marked running.
 */

interface PiTextBlock {
  type?: string
  text?: string
  thinking?: string
}

interface PiToolCallBlock {
  type?: string
  id?: string
  name?: string
  arguments?: Record<string, unknown>
}

interface PiRecord {
  type?: string
  id?: string
  timestamp?: string
  customType?: string
  data?: {
    toolCallId?: string
    toolName?: string
    args?: Record<string, unknown>
  }
  message?: {
    role?: string
    content?: unknown
    isError?: boolean
  }
}

const MAX_RESULT_CHARS = 2000

function str(value: unknown): string {
  return typeof value === "string" ? value : ""
}

/** Human-readable discriminator for a tool call: intent first, then path/command. */
function toolTitle(name: string, args: Record<string, unknown> | undefined): string {
  if (!args) {
    return ""
  }
  for (const key of ["intent", "i", "path", "command", "pattern", "url"]) {
    const value = str(args[key])
    if (value) {
      return value
    }
  }
  return ""
}

function textOf(blocks: unknown): string {
  if (!Array.isArray(blocks)) {
    return ""
  }
  return (blocks as PiTextBlock[])
    .filter((b) => b?.type === "text")
    .map((b) => str(b.text))
    .join("\n")
}

interface Turn {
  call: StepNode
  reply: StepNode
  text: string
}

export function parsePiSession(lines: readonly string[]): PiRecord[] {
  const records: PiRecord[] = []
  for (const line of lines) {
    if (!line.trim()) {
      continue
    }
    try {
      records.push(JSON.parse(line) as PiRecord)
    } catch {
      // Persistence files may carry partial trailing writes; skip them.
    }
  }
  return records
}

/** The `session` header id, when the file carries one. */
export function piSessionID(records: readonly PiRecord[], fallback: string): string {
  for (const record of records) {
    if (record.type === "session" && record.id) {
      return record.id
    }
  }
  return fallback
}

export function reducePiSession(lines: readonly string[], sessionID = ""): FlowTree {
  const records = parsePiSession(lines)
  const sid = piSessionID(records, sessionID)
  const units: UnitOfWork[] = []
  const toolNodes = new Map<string, StepNode>()

  let unit: UnitOfWork | undefined
  let turn: Turn | undefined
  let previousAt: number | undefined

  const closeUnit = (): void => {
    if (!unit) {
      return
    }
    for (const node of allNodes(unit)) {
      if (node.state === "running") {
        node.state = "completed"
      }
    }
    const answer = makeAnswer(unit.id, turn?.text ?? "")
    if (answer) {
      unit.steps.push(answer)
    }
    unit = undefined
    turn = undefined
    toolNodes.clear()
  }

  for (const record of records) {
    const at = record.timestamp ? Date.parse(record.timestamp) : undefined

    if (record.type === "message" && record.message?.role === "user") {
      closeUnit()
      const id = record.id ?? `unit-${units.length}`
      const request = makeNode(
        `ur-${id}`,
        "user-request",
        "User request",
        "completed",
        textOf(record.message.content),
      )
      if (at !== undefined) {
        request.endedAt = at
        previousAt = at
      }
      unit = { id, request, steps: [], plan: [] }
      units.push(unit)
      continue
    }

    if (record.type === "message" && record.message?.role === "assistant") {
      if (!unit) {
        continue
      }
      const id = record.id ?? `turn-${unit.steps.length}`
      const call = makeNode(`mc-${id}`, "model-call", "Model call", "completed")
      const reply = makeNode(`mr-${id}`, "model-reply", "Model reply", "completed")
      call.children.push(reply)
      // Like the Claude transcript, a persistence timestamp records when the
      // record was written, so the call began when the previous one landed.
      call.startedAt = previousAt ?? at
      call.endedAt = at
      reply.startedAt = call.startedAt
      reply.endedAt = at
      if (at !== undefined) {
        previousAt = at
      }
      unit.steps.push(call)
      turn = { call, reply, text: "" }
      for (const block of (record.message.content ?? []) as Array<PiTextBlock & PiToolCallBlock>) {
        if (block?.type === "thinking") {
          reply.reasoning = ((reply.reasoning ?? "") + str(block.thinking)).trimStart()
        } else if (block?.type === "text") {
          turn.text += str(block.text)
          reply.content = turn.text
        } else if (block?.type === "toolCall" && block.id && block.name) {
          const title = toolTitle(block.name, block.arguments)
          const node = makeNode(
            `tc-${block.id}`,
            "tool-call",
            title ? `Tool: ${block.name} · ${title}` : `Tool: ${block.name}`,
            "completed",
            str(block.arguments?.["intent"]) || str(block.arguments?.["i"]),
          )
          node.startedAt = at
          toolNodes.set(block.id, node)
          reply.children.push(node)
        }
      }
      continue
    }

    if (record.type === "message" && record.message?.role === "toolResult") {
      const toolCallId = (record.message as { toolCallId?: string }).toolCallId
      const node = toolCallId ? toolNodes.get(toolCallId) : undefined
      if (!node) {
        continue
      }
      node.endedAt = at
      const text = textOf(record.message.content).slice(0, MAX_RESULT_CHARS)
      if (record.message.isError) {
        node.state = "failed"
        node.content = text
        continue
      }
      node.state = "completed"
      node.content = text
      if (!node.children.some((child) => child.type === "tool-result")) {
        const toolName = node.label.replace(/^Tool: ([^ ·]+).*$/, "$1")
        node.children.push(makeNode(`tr-${node.id}`, "tool-result", `Result: ${toolName}`, "completed", text))
      }
      continue
    }

    if (record.type === "custom" && record.customType === "tool_execution_start") {
      const node = record.data?.toolCallId ? toolNodes.get(record.data.toolCallId) : undefined
      if (node && node.state !== "completed" && node.state !== "failed") {
        node.state = "running"
      }
      continue
    }

    if (record.type === "custom" && record.customType === "session_exit") {
      closeUnit()
      continue
    }
    // title / session / model_change / thinking_level_change: ignored by design.
  }
  closeUnit()

  return { sessionID: sid, units }
}

function* allNodes(unit: UnitOfWork): Generator<StepNode> {
  const stack = [...unit.steps]
  while (stack.length > 0) {
    const node = stack.pop() as StepNode
    yield node
    stack.push(...node.children)
  }
}
