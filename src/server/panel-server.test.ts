import { describe, it } from "node:test"
import assert from "node:assert/strict"
import type { FlowTree } from "../flow/types.ts"
import { createPanelServer } from "./panel-server.ts"

const tree: FlowTree = {
  sessionID: "s1",
  units: [
    {
      id: "m1",
      request: {
        id: "ur-m1",
        type: "user-request",
        label: "User request",
        state: "completed",
        content: "Hello",
        children: [],
      },
      steps: [],
      plan: [],
    },
  ],
}

async function readSseUntil(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  controller: AbortController,
  decoder: InstanceType<typeof TextDecoder>,
  marker: string,
): Promise<string> {
  let acc = ""
  while (!acc.includes(marker)) {
    const timeout = setTimeout(() => controller.abort(), 3000)
    let value: Uint8Array | undefined
    let done = false
    try {
      const result = await reader.read()
      value = result.value
      done = result.done
    } catch (err) {
      if ((err as Error).name === "AbortError") {
        break
      }
      throw err
    } finally {
      clearTimeout(timeout)
    }
    if (done) {
      break
    }
    if (value) {
      acc += decoder.decode(value, { stream: true })
    }
  }
  return acc
}

describe("panel server", () => {
  it("serves a rendered HTML page at /", async (t) => {
    const panel = createPanelServer({ getTree: () => tree })
    await panel.start()
    t.after(() => panel.close())

    const response = await fetch(panel.url())
    assert.equal(response.status, 200)
    assert.match(response.headers.get("content-type") ?? "", /text\/html/)
    const html = await response.text()
    assert.ok(html.includes("Agent Flow Panel"))
    assert.ok(html.includes("User request"))
    assert.ok(html.includes("Hello"))
  })

  it("re-renders from the latest snapshot on refresh", async (t) => {
    let current: FlowTree = { ...tree, units: [] }
    const panel = createPanelServer({ getTree: () => current })
    await panel.start()
    t.after(() => panel.close())

    const emptyHtml = await (await fetch(panel.url())).text()
    assert.ok(emptyHtml.includes("No flow recorded yet"))

    current = tree
    const html = await (await fetch(panel.url())).text()
    assert.ok(html.includes("Hello"))
  })

  it("returns 404 for unknown routes", async (t) => {
    const panel = createPanelServer({ getTree: () => tree })
    await panel.start()
    t.after(() => panel.close())

    const response = await fetch(`${panel.url()}nope`)
    assert.equal(response.status, 404)
  })

  it("streams tree updates over SSE after publish", async (t) => {
    let current: FlowTree = tree
    const panel = createPanelServer({ getTree: () => current })
    await panel.start()
    t.after(() => panel.close())

    const controller = new AbortController()
    const response = await fetch(`${panel.url()}events`, { signal: controller.signal })
    assert.equal(response.status, 200)
    assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/)
    const reader = response.body!.getReader()
    const decoder = new TextDecoder()

    panel.publish()
    const first = await readSseUntil(reader, controller, decoder, "Hello")
    assert.ok(first.includes("data: "))
    assert.ok(first.includes("Hello"))

    current = {
      ...tree,
      units: [
        { ...tree.units[0]!, request: { ...tree.units[0]!.request, content: "Updated request" } },
      ],
    }
    panel.publish()
    const second = await readSseUntil(reader, controller, decoder, "Updated request")
    assert.ok(second.includes("Updated request"))

    controller.abort()
  })

  it("publish is a no-op before start and with no clients", async () => {
    const panel = createPanelServer({ getTree: () => tree })
    panel.publish()
    await panel.start()
    panel.publish()
    await panel.close()
  })

  it("sends the current tree snapshot immediately on connect", async (t) => {
    const panel = createPanelServer({ getTree: () => tree })
    await panel.start()
    t.after(() => panel.close())

    const controller = new AbortController()
    const response = await fetch(`${panel.url()}events`, { signal: controller.signal })
    const reader = response.body!.getReader()
    const decoder = new TextDecoder()
    const acc = await readSseUntil(reader, controller, decoder, "Hello")
    assert.ok(acc.includes("data: "))
    assert.ok(acc.includes("Hello"))
    controller.abort()
  })
})
