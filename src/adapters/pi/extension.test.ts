import { describe, it } from "node:test"
import assert from "node:assert/strict"
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"
import piExtension from "./extension.ts"

interface SentMessage {
  customType: string
  content: string
  display: boolean
}

interface Harness {
  fire(name: string, event: unknown): Promise<void>
  run(command: string): Promise<void>
  commands: string[]
  sent: SentMessage[]
}

function harness(): Harness {
  const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>()
  const commands = new Map<string, (args: string, ctx: ExtensionContext) => Promise<void>>()
  const sent: SentMessage[] = []

  const ctx = {
    sessionManager: { getSessionId: () => "s1", getBranch: () => [] },
    ui: { notify: () => {}, confirm: async () => true },
    hasUI: true,
    signal: new AbortController().signal,
  } as unknown as ExtensionContext

  const pi = {
    on: (name: string, fn: (event: unknown, ctx: ExtensionContext) => unknown) => handlers.set(name, fn),
    registerCommand: (name: string, spec: { handler: (args: string, ctx: ExtensionContext) => Promise<void> }) =>
      commands.set(name, spec.handler),
    registerTool: () => {},
    sendMessage: (message: SentMessage) => sent.push(message),
  } as unknown as ExtensionAPI

  piExtension(pi)

  return {
    async fire(name, event) {
      await handlers.get(name)?.(event, ctx)
    },
    async run(command) {
      const handler = commands.get(command)
      assert.ok(handler, `no /${command} command registered`)
      await handler("", ctx)
    },
    get commands() {
      return [...commands.keys()]
    },
    sent,
  }
}

describe("pi extension commands", () => {
  it("registers flow-tree so it shadows the Claude Code command file", () => {
    // Pi resolves a command file in .claude/commands/ when no extension
    // claims the name. That file tells the agent to call an MCP server Pi
    // does not have, and the agent invents a substitute instead of stopping.
    assert.ok(harness().commands.includes("flow-tree"))
  })

  it("puts the tree in the transcript without starting a turn", async () => {
    const pi = harness()
    await pi.fire("before_agent_start", { prompt: "Compare the pricing pages" })
    await pi.fire("turn_start", { turnIndex: 0 })
    await pi.fire("message_update", {
      turnIndex: 0,
      message: { role: "assistant" },
      assistantMessageEvent: { type: "text_delta", delta: "Fetching both pages." },
    })
    await pi.fire("turn_end", { turnIndex: 0 })

    await pi.run("flow-tree")

    assert.equal(pi.sent.length, 1)
    const [message] = pi.sent
    assert.equal(message?.display, true)
    assert.match(message?.content ?? "", /Compare the pricing pages/)
  })

  it("says so plainly when nothing has been recorded", async () => {
    const pi = harness()
    await pi.run("flow-tree")
    assert.match(pi.sent[0]?.content ?? "", /No flow data recorded/)
  })
})
