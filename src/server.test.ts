import { describe, it } from "node:test"
import assert from "node:assert/strict"
import type { Event, Message, Part } from "@opencode-ai/sdk"
import type { V2Event } from "./adapters/opencode/v2-reducer.ts"
import module from "./server.ts"

describe("plugin module", () => {
  it("exports a server plugin with the flow-panel id", () => {
    assert.equal(module.id, "flow-panel")
    assert.equal(typeof module.server, "function")
  })

  it("exports a V2 setup for OpenCode 2.x from the same default export", () => {
    assert.equal(typeof module.setup, "function")
  })
})

type Hooks = Awaited<ReturnType<NonNullable<typeof module.server>>>

async function instance(): Promise<Hooks> {
  const factory = module.server
  assert.ok(factory)
  return await factory({} as Parameters<NonNullable<typeof module.server>>[0])
}

function userMessage(sessionID: string, id: string): Message {
  return {
    id,
    sessionID,
    role: "user",
    time: { created: 1 },
  } as Message
}

function textPart(sessionID: string, messageID: string, text: string): Part {
  return { id: `p-${messageID}`, sessionID, messageID, type: "text", text } as Part
}

function feed(hooks: Hooks, sessionID: string): Promise<void>[] {
  const events: Event[] = [
    {
      type: "message.updated",
      properties: { info: userMessage(sessionID, "m1") },
    } as Event,
    {
      type: "message.part.updated",
      properties: { part: textPart(sessionID, "m1", "hello") },
    } as Event,
  ]
  return events.map((event) => hooks.event!({ event }))
}

async function treeText(hooks: Hooks, sessionID: string): Promise<string> {
  const showTree = hooks.tool!["flow_tree"]!
  return (await showTree.execute({}, { sessionID } as never)) as string
}

describe("plugin instances", () => {
  it("keeps tracker state per instance instead of per module", async () => {
    const first = await instance()
    const second = await instance()
    await Promise.all(feed(first, "s1"))

    assert.match(await treeText(first, "s1"), /hello/)
    assert.equal(await treeText(second, "s1"), "No flow data recorded for this session.")
  })

  it("does not feed the disposal event into the tracker", async () => {
    const hooks = await instance()
    await Promise.all(feed(hooks, "s1"))
    await hooks.event!({
      event: { type: "server.instance.disposed", properties: { directory: "/tmp" } } as Event,
    })

    assert.match(await treeText(hooks, "s1"), /hello/)
  })
})

interface RegisteredTool {
  name: string
  options?: { codemode?: boolean }
  execute: (input: unknown, context: { sessionID: string }) => Promise<{ content: string }>
}

/** A stand-in for the V2 plugin context: a scripted event stream and a tool editor. */
function v2Context(events: V2Event[]) {
  const tools = new Map<string, RegisteredTool>()
  let subscription: { types?: string[]; signal?: AbortSignal } | undefined
  const ctx = {
    event: {
      subscribe(options: { types?: string[]; signal?: AbortSignal }) {
        subscription = options
        return (async function* () {
          yield* events
        })()
      },
    },
    tool: {
      transform: async (callback: (editor: { add: (tool: RegisteredTool) => void }) => void) => {
        callback({ add: (tool) => tools.set(tool.name, tool) })
        return { dispose: async () => {} }
      },
    },
  }
  return { ctx: ctx as unknown as Parameters<typeof module.setup>[0], tools, subscription: () => subscription }
}

describe("V2 plugin setup", () => {
  const events: V2Event[] = [
    {
      type: "session.inbox.enqueued",
      created: 1,
      data: { sessionID: "s1", inboxID: "in1", item: { type: "user", payload: { text: "hello" } } },
    },
    { type: "session.inbox.delivered", created: 2, data: { sessionID: "s1", inboxID: "in1" } },
  ]

  it("registers the flow tools as direct (non Code Mode) tools", async () => {
    const { ctx, tools } = v2Context([])
    const cleanup = await module.setup(ctx)
    assert.deepEqual([...tools.keys()], ["flow_panel", "flow_open", "flow_tree"])
    assert.ok([...tools.values()].every((tool) => tool.options?.codemode === false))
    await cleanup?.()
  })

  it("feeds the subscribed event stream into the tracker", async () => {
    const { ctx, tools, subscription } = v2Context(events)
    const cleanup = await module.setup(ctx)
    await new Promise((resolve) => setImmediate(resolve))

    assert.ok(subscription()?.types?.includes("session.tool.called"))
    const result = await tools.get("flow_tree")!.execute({}, { sessionID: "s1" })
    assert.match(result.content, /hello/)
    await cleanup?.()
    assert.equal(subscription()?.signal?.aborted, true)
  })
})
