import { describe, it } from "node:test"
import assert from "node:assert/strict"
import type { Event, Message, Part } from "@opencode-ai/sdk"
import module from "./server.ts"

describe("plugin module", () => {
  it("exports a server plugin with the flow-panel id", () => {
    assert.equal(module.id, "flow-panel")
    assert.equal(typeof module.server, "function")
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
