import { describe, it } from "node:test"
import assert from "node:assert/strict"
import type { FlowTree } from "./types.ts"
import { renderFlowHtml, renderPanelHtml, renderTree } from "./render.ts"

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
        content: "List the files",
        children: [],
      },
      steps: [
        {
          id: "mc-m2",
          type: "model-call",
          label: "Model call",
          state: "completed",
          content: "",
          children: [
            {
              id: "mr-m2",
              type: "model-reply",
              label: "Model reply",
              state: "completed",
              content: "Here are the files",
              reasoning: "User asked for a listing",
              children: [
                {
                  id: "tc-c1",
                  type: "tool-call",
                  label: "Tool: bash",
                  state: "completed",
                  content: "",
                  children: [
                    {
                      id: "tr-c1",
                      type: "tool-result",
                      label: "Result: bash",
                      state: "completed",
                      content: "a.txt b.txt",
                      children: [],
                    },
                  ],
                },
              ],
            },
          ],
        },
        {
          id: "tc-c2",
          type: "tool-call",
          label: "Tool: read",
          state: "failed",
          content: "boom <script>alert(1)</script>",
          children: [],
        },
      ],
      plan: [{ id: "t1", title: "List files", state: "completed" }],
    },
  ],
}

describe("renderPanelHtml", () => {
  it("renders the page with node types, states and content as labels", () => {
    const html = renderPanelHtml(tree)
    assert.match(html, /<li class="step step--user-request step--done"/)
    assert.match(html, /<li class="step step--model-call step--done"/)
    assert.match(html, /<li class="step step--tool-call step--done"/)
    assert.match(html, /<li class="step step--tool-result step--done"/)
    assert.match(html, /<li class="step step--tool-call step--failed"/)
    assert.ok(html.includes("User request"))
    assert.ok(html.includes("Tool: bash"))
    assert.ok(html.includes("List the files"))
    assert.ok(html.includes("a.txt b.txt"))
  })

  it("marks each node with a data-state attribute for live styling", () => {
    const html = renderPanelHtml(tree)
    assert.ok(html.includes('data-state="completed"'))
    assert.ok(html.includes('data-state="failed"'))
  })

  it("shows a visible state label per node", () => {
    const html = renderPanelHtml(tree)
    assert.ok(html.includes('<span class="step-state">done</span>'))
    assert.ok(html.includes('<span class="step-state">failed</span>'))
  })

  it("escapes node content and reasoning", () => {
    const html = renderPanelHtml(tree)
    assert.ok(html.includes("boom &lt;script&gt;alert(1)&lt;/script&gt;"))
    assert.ok(html.includes("User asked for a listing"))
  })

  it("renders the plan items and the unit heading", () => {
    const html = renderPanelHtml(tree)
    assert.ok(html.includes("Unit of Work #1"))
    assert.ok(html.includes("List files"))
  })

  it("renders an empty-state message when there are no units", () => {
    const html = renderPanelHtml({ sessionID: "s1", units: [] })
    assert.ok(html.includes("No flow recorded yet"))
  })

  it("embeds an SSE client script and a flow container id", () => {
    const html = renderPanelHtml(tree)
    assert.ok(html.includes('id="flow"'))
    assert.ok(html.includes('new EventSource("/events")'))
  })

  it("renders the flow html as a single line for SSE transport", () => {
    const flowHtml = renderFlowHtml(tree)
    assert.ok(!flowHtml.includes("\n"))
    assert.ok(flowHtml.includes("Tool: bash"))
  })

  it("renders the plan above the steps it previews", () => {
    const html = renderPanelHtml(tree)
    const planAt = html.indexOf('<ul class="plan">')
    const stepsAt = html.indexOf('<ol class="steps">')
    assert.ok(planAt !== -1)
    assert.ok(stepsAt !== -1)
    assert.ok(planAt < stepsAt)
  })
})

describe("renderTree", () => {
  it("renders nodes as a text tree with states and labels", () => {
    const text = renderTree(tree)
    assert.ok(text.includes("[done] User request: List the files"))
    assert.ok(text.includes("[done] Model call"))
    assert.ok(text.includes("[done] Tool: bash"))
    assert.ok(text.includes("[failed] Tool: read"))
    assert.ok(text.includes("↳ reasoning: User asked for a listing"))
  })

  it("renders the plan in text", () => {
    const text = renderTree(tree)
    assert.ok(text.includes("Plan:"))
    assert.ok(text.includes("[completed] List files"))
  })

  it("returns an empty-state message for an empty tree", () => {
    assert.equal(renderTree({ sessionID: "s1", units: [] }), "(no flow recorded)")
  })
})
