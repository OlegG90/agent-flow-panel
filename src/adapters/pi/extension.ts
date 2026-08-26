import { execFile } from "node:child_process"
import { promisify } from "node:util"
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { Type } from "typebox"
import { renderTree } from "../../flow/render.ts"
import { createPanelServer } from "../../server/panel-server.ts"
import { PiSessionTracker } from "./pi-session-tracker.ts"

const execFileAsync = promisify(execFile)

async function openInBrowser(url: string): Promise<void> {
  try {
    if (process.platform === "win32") {
      await execFileAsync("cmd", ["/c", "start", "", url])
      return
    }
    const opener = process.platform === "darwin" ? "open" : "xdg-open"
    await execFileAsync(opener, [url])
  } catch (err) {
    console.error(`[flow-panel] failed to open browser for ${url}:`, err)
    throw err
  }
}

function stringField(value: unknown, key: string): string | undefined {
  if (value !== null && typeof value === "object" && key in value) {
    const candidate = (value as Record<string, unknown>)[key]
    return typeof candidate === "string" ? candidate : undefined
  }
  return undefined
}

function numberField(value: unknown, key: string): number | undefined {
  if (value !== null && typeof value === "object" && key in value) {
    const candidate = (value as Record<string, unknown>)[key]
    return typeof candidate === "number" ? candidate : undefined
  }
  return undefined
}

function objectField(value: unknown, key: string): Record<string, unknown> | undefined {
  if (value !== null && typeof value === "object" && key in value) {
    const candidate = (value as Record<string, unknown>)[key]
    return candidate !== null && typeof candidate === "object" ? (candidate as Record<string, unknown>) : undefined
  }
  return undefined
}

export default function piExtension(pi: ExtensionAPI): void {
  const tracker = new PiSessionTracker()
  const panelServer = createPanelServer({
    getTree: () => tracker.tree(),
  })
  tracker.onUpdate(() => panelServer.publish())

  let lastActiveSessionID: string | undefined

  async function openPanel(sessionID: string, reset: boolean): Promise<string> {
    if (reset) tracker.reset()
    tracker.setActiveSession(sessionID)
    lastActiveSessionID = sessionID
    try {
      await panelServer.start()
    } catch (err) {
      console.error("[flow-panel] panelServer.start failed:", err)
      throw err
    }
    const url = panelServer.url()
    try {
      await openInBrowser(url)
    } catch (err) {
      console.error("[flow-panel] openInBrowser failed, panel still available at", url, err)
      // Don't throw — return url so caller can still notify user
    }
    return url
  }

  // Pi fork sessions: `session_start` with reason `fork` carries previousSessionFile.
  // We correlate via previousSessionFile basename or lastActiveSessionID fallback.
  pi.on("session_start", async (event: unknown, ctx) => {
    const reason = stringField(event, "reason")
    if (reason !== "fork") return
    const childID = ctx.sessionManager.getSessionId()
    if (!childID) return
    const prevFile = stringField(event, "previousSessionFile")
    let parentID: string | undefined
    if (prevFile) {
      const base = prevFile.split("/").pop() ?? prevFile.split("\\").pop() ?? prevFile
      parentID = base.replace(/\.json$/i, "")
    }
    parentID ??= lastActiveSessionID
    if (parentID && parentID !== childID) {
      tracker.registerChild(parentID, childID)
    }
  })

  pi.on("before_agent_start", async (event: unknown, ctx) => {
    const prompt = stringField(event, "prompt") ?? ""
    const sid = ctx.sessionManager.getSessionId() ?? prompt.slice(0, 32)
    tracker.setActiveSession(sid)
    lastActiveSessionID = sid
    tracker.dispatchBySession(sid, (store) => {
      const unitId = `pi-${Date.now()}`
      store.startUnit(unitId, prompt)
    })
  })

  pi.on("turn_start", async (event: unknown, ctx) => {
    const turnIndex = numberField(event, "turnIndex") ?? 0
    const sid = ctx.sessionManager.getSessionId() ?? "default"
    tracker.dispatchBySession(sid, (store) => store.startTurn(String(turnIndex)))
  })

  pi.on("message_update", async (event: unknown, ctx) => {
    const sid = ctx.sessionManager.getSessionId() ?? "default"
    lastActiveSessionID = sid
    const msg = objectField(event, "message")
    if (!msg || msg["role"] !== "assistant") return
    const turnIndex = numberField(event, "turnIndex")
    let turnId = "0"
    if (turnIndex !== undefined) turnId = String(turnIndex)
    else {
      const id = stringField(msg, "id")
      if (id) turnId = id
    }
    const assistantMessageEvent = objectField(event, "assistantMessageEvent")
    const eventType = assistantMessageEvent ? stringField(assistantMessageEvent, "type") : undefined
    const delta = assistantMessageEvent ? stringField(assistantMessageEvent, "delta") ?? "" : ""
    // Only handle real streaming deltas. Ignore fallback via msg.content —
    // under oh-my-pi it contains task JSON ({"i":...}) and creates phantom text.
    if (!delta) return
    // thinking_delta vs text_delta — route to reasoning vs text
    if (eventType === "thinking_delta" || eventType === "thinking_start" || eventType === "thinking_end") {
      tracker.dispatchBySession(sid, (store) => store.appendAssistantText(turnId, "", delta))
    } else if (eventType === "text_delta" || eventType === "text_start" || eventType === "text_end") {
      tracker.dispatchBySession(sid, (store) => store.appendAssistantText(turnId, delta, undefined))
    } else if (eventType === undefined) {
      // non-streaming fallback only when we have an explicit delta; msg.content is ignored
      tracker.dispatchBySession(sid, (store) => store.appendAssistantText(turnId, delta, undefined))
    }
  })

  pi.on("tool_call", async (event: unknown, ctx) => {
    const sid = ctx.sessionManager.getSessionId() ?? "default"
    lastActiveSessionID = sid
    const toolCallId = stringField(event, "toolCallId") ?? "unknown"
    const toolName = stringField(event, "toolName") ?? "unknown"
    const input = objectField(event, "input") as Record<string, unknown> | undefined
    const turnIndex = numberField(event, "turnIndex")
    const turnId = turnIndex !== undefined ? String(turnIndex) : "0"
    tracker.dispatchBySession(sid, (store) => {
      store.onToolCall(toolCallId, toolName, turnId, input)
    })
  })

  pi.on("tool_result", async (event: unknown, ctx) => {
    const sid = ctx.sessionManager.getSessionId() ?? "default"
    lastActiveSessionID = sid
    const toolCallId = stringField(event, "toolCallId") ?? "unknown"
    const toolName = stringField(event, "toolName") ?? "unknown"
    let content: unknown = objectField(event, "details") ?? ""
    if (event !== null && typeof event === "object" && "content" in event) {
      const candidate = (event as Record<string, unknown>)["content"]
      if (candidate !== undefined) content = candidate
      // Pi content is (TextContent|ImageContent)[] — extract text
      if (Array.isArray(candidate)) {
        const texts = (candidate as unknown[])
          .filter((c): c is Record<string, unknown> => typeof c === "object" && c !== null && "type" in c)
          .filter((c) => c["type"] === "text" && typeof c["text"] === "string")
          .map((c) => c["text"] as string)
        if (texts.length > 0) content = texts.join("\n")
      }
    }
    let isError = false
    if (event !== null && typeof event === "object" && "isError" in event) {
      const candidate = (event as Record<string, unknown>)["isError"]
      if (typeof candidate === "boolean") isError = candidate
    }
    tracker.dispatchBySession(sid, (store) => {
      store.onToolResult(toolCallId, toolName, content, isError)
    })
  })

  // Tool execution lifecycle mirrors tool_result but fires even for forked delegates
  pi.on("tool_execution_end", async (event: unknown, ctx) => {
    const sid = ctx.sessionManager.getSessionId() ?? "default"
    const toolCallId = stringField(event, "toolCallId")
    const toolName = stringField(event, "toolName")
    if (!toolCallId || !toolName) return
    const result = objectField(event, "result")
    const isError = (() => {
      if (event !== null && typeof event === "object" && "isError" in event) {
        const v = (event as Record<string, unknown>)["isError"]
        return typeof v === "boolean" ? v : false
      }
      return false
    })()
    // Only handle delegate tools via execution_end if not already completed via tool_result
    if (toolName === "oh_my_pi_delegate_task" || toolName === "oh_my_pi_subagent") {
      tracker.dispatchBySession(sid, (store) => {
        store.onToolResult(toolCallId, toolName, result ?? "", isError)
      })
    }
  })

  pi.on("tool_execution_start", async (event: unknown, ctx) => {
    const sid = ctx.sessionManager.getSessionId() ?? "default"
    lastActiveSessionID = sid
    const toolCallId = stringField(event, "toolCallId")
    if (!toolCallId) return
    tracker.dispatchBySession(sid, (store) => store.markToolRunning(toolCallId))
  })

  pi.on("tool_execution_update", async () => {
    // Reserved for streaming partialResult — currently no-op to avoid noisy updates.
  })

  pi.on("turn_end", async (event: unknown, ctx) => {
    const sid = ctx.sessionManager.getSessionId() ?? "default"
    lastActiveSessionID = sid
    const turnIndex = numberField(event, "turnIndex") ?? 0
    tracker.dispatchBySession(sid, (store) => store.finishTurn(String(turnIndex)))
  })

  pi.on("agent_end", async (_event: unknown, ctx) => {
    const sid = ctx.sessionManager.getSessionId() ?? "default"
    lastActiveSessionID = sid
    tracker.dispatchBySession(sid, (store) => store.closeOpenUnit())
  })

  pi.on("agent_settled", async (_event: unknown, ctx) => {
    const sid = ctx.sessionManager.getSessionId() ?? "default"
    lastActiveSessionID = sid
    tracker.dispatchBySession(sid, (store) => store.closeOpenUnit())
  })

  pi.on("session_shutdown", async () => {
    await panelServer.close()
  })

  pi.registerCommand("flow", {
    description: "Open the Agent Flow panel (keep history)",
    handler: async (_args: string, ctx) => {
      const sid = ctx.sessionManager.getSessionId() ?? "default"
      const url = await openPanel(sid, false)
      ctx.ui.notify(`Agent Flow panel: ${url}`, "info")
    },
  })

  // Alias for typo /flaw → same as /flow
  pi.registerCommand("flaw", {
    description: "Open the Agent Flow panel (keep history) — alias for /flow",
    handler: async (_args: string, ctx) => {
      const sid = ctx.sessionManager.getSessionId() ?? "default"
      const url = await openPanel(sid, false)
      ctx.ui.notify(`Agent Flow panel: ${url}`, "info")
    },
  })

  pi.registerCommand("flow-reset", {
    description: "Open the Agent Flow panel from scratch",
    handler: async (_args: string, ctx) => {
      const sid = ctx.sessionManager.getSessionId() ?? "default"
      const url = await openPanel(sid, true)
      ctx.ui.notify(`Agent Flow panel (reset): ${url}`, "info")
    },
  })

  pi.registerCommand("flaw-reset", {
    description: "Open the Agent Flow panel from scratch — alias for /flow-reset",
    handler: async (_args: string, ctx) => {
      const sid = ctx.sessionManager.getSessionId() ?? "default"
      const url = await openPanel(sid, true)
      ctx.ui.notify(`Agent Flow panel (reset): ${url}`, "info")
    },
  })

  pi.registerTool({
    name: "flow_panel",
    label: "Flow Panel",
    description: "Open the Agent Flow panel in the default browser, starting fresh from this moment.",
    parameters: Type.Object({}),
    async execute(_toolCallId: string, _params: unknown, _signal: AbortSignal, _onUpdate: unknown, ctx) {
      const sid = ctx.sessionManager.getSessionId() ?? "default"
      const url = await openPanel(sid, true)
      return { content: [{ type: "text", text: `Opened ${url}` }], details: { url } }
    },
  })

  pi.registerTool({
    name: "flow_open",
    label: "Flow Panel (keep)",
    description: "Open the Agent Flow panel in the default browser, keeping the current view.",
    parameters: Type.Object({}),
    async execute(_toolCallId: string, _params: unknown, _signal: AbortSignal, _onUpdate: unknown, ctx) {
      const sid = ctx.sessionManager.getSessionId() ?? "default"
      const url = await openPanel(sid, false)
      return { content: [{ type: "text", text: `Opened ${url}` }], details: { url } }
    },
  })

  pi.registerTool({
    name: "flow_tree",
    label: "Flow Tree",
    description: "Show the Agent Flow step tree for this session as text.",
    parameters: Type.Object({}),
    async execute(_toolCallId: string, _params: unknown, _signal: AbortSignal, _onUpdate: unknown, ctx) {
      const sid = ctx.sessionManager.getSessionId() ?? "default"
      const tree = tracker.tree(sid)
      const text = tree.units.length > 0 ? renderTree(tree) : "No flow data recorded for this session."
      return { content: [{ type: "text", text }], details: {} }
    },
  })
}
