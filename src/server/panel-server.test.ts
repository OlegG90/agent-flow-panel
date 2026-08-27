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
  it("serves the current tree snapshot as JSON at /data", async (t) => {
    const panel = createPanelServer({ getTree: () => tree })
    await panel.start()
    t.after(() => panel.close())

    const response = await fetch(panel.url("data"))
    assert.equal(response.status, 200)
    assert.match(response.headers.get("content-type") ?? "", /application\/json/)
    const body = (await response.json()) as FlowTree
    assert.equal(body.sessionID, "s1")
    assert.equal(body.units[0]?.request.content, "Hello")
  })

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

    const response = await fetch(panel.url("nope"))
    assert.equal(response.status, 404)
  })

  it("rejects requests without the access token", async (t) => {
    const panel = createPanelServer({ getTree: () => tree })
    await panel.start()
    t.after(() => panel.close())

    const base = new URL(panel.url())
    for (const path of ["/", "/data", "/events"]) {
      const noToken = await fetch(new URL(path, base.origin))
      assert.equal(noToken.status, 401)
      const wrongToken = await fetch(new URL(`${path}?t=deadbeef`, base.origin))
      assert.equal(wrongToken.status, 401)
    }
  })

  it("issues a distinct token per panel server", async (t) => {
    const first = createPanelServer({ getTree: () => tree })
    const second = createPanelServer({ getTree: () => tree })
    await first.start()
    await second.start()
    t.after(() => Promise.all([first.close(), second.close()]))

    const firstToken = new URL(first.url()).searchParams.get("t")
    const secondToken = new URL(second.url()).searchParams.get("t")
    assert.ok(firstToken)
    assert.notEqual(firstToken, secondToken)

    const crossed = new URL(second.url())
    crossed.searchParams.set("t", firstToken)
    assert.equal((await fetch(crossed)).status, 401)
  })

  it("streams tree updates over SSE after publish", async (t) => {
    let current: FlowTree = tree
    const panel = createPanelServer({ getTree: () => current })
    await panel.start()
    t.after(() => panel.close())

    const controller = new AbortController()
    const response = await fetch(panel.url("events"), { signal: controller.signal })
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

  it("coalesces a burst of publishes into a leading and a trailing frame", async (t) => {
    let renders = 0
    const panel = createPanelServer({
      getTree: () => {
        renders += 1
        return tree
      },
      coalesceMs: 40,
    })
    await panel.start()
    t.after(() => panel.close())

    const controller = new AbortController()
    const response = await fetch(panel.url("events"), { signal: controller.signal })
    const reader = response.body!.getReader()
    await readSseUntil(reader, controller, new TextDecoder(), "Hello")
    const afterConnect = renders

    // A streaming turn publishes on every token delta.
    for (let i = 0; i < 25; i++) {
      panel.publish()
    }
    assert.equal(renders - afterConnect, 1, "burst renders once on the leading edge")

    await new Promise((resolve) => setTimeout(resolve, 120))
    assert.equal(renders - afterConnect, 2, "and once more on the trailing edge")

    controller.abort()
  })

  it("renders on every publish when coalescing is disabled", async (t) => {
    let renders = 0
    const panel = createPanelServer({
      getTree: () => {
        renders += 1
        return tree
      },
      coalesceMs: 0,
    })
    await panel.start()
    t.after(() => panel.close())

    const controller = new AbortController()
    const response = await fetch(panel.url("events"), { signal: controller.signal })
    const reader = response.body!.getReader()
    await readSseUntil(reader, controller, new TextDecoder(), "Hello")
    const afterConnect = renders

    panel.publish()
    panel.publish()
    assert.equal(renders - afterConnect, 2)

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
    const response = await fetch(panel.url("events"), { signal: controller.signal })
    const reader = response.body!.getReader()
    const decoder = new TextDecoder()
    const acc = await readSseUntil(reader, controller, decoder, "Hello")
    assert.ok(acc.includes("data: "))
    assert.ok(acc.includes("Hello"))
    controller.abort()
  })
})
