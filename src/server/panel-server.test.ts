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

describe("panel server", () => {
  it("serves the current tree snapshot as JSON at /data", async (t) => {
    const panel = createPanelServer({ getTree: () => tree })
    await panel.start()
    t.after(() => panel.close())

    const response = await fetch(`${panel.url()}data`)
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

    const response = await fetch(`${panel.url()}nope`)
    assert.equal(response.status, 404)
  })
})
