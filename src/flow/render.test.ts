import { describe, it } from "node:test"
import assert from "node:assert/strict"
import type { FlowTree } from "./types.ts"
import {
  formatCost,
  formatDuration,
  formatTokens,
  renderFlowHtml,
  renderPanelHtml,
  renderTree,
} from "./render.ts"

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
    assert.match(html, /<li class="step step--model-call step--done[ "]/)
    assert.match(html, /<li class="step step--tool-call step--done[ "]/)
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
    assert.ok(html.includes('new EventSource("/events" + window.location.search)'))
  })

  it("renders a two-zone layout with a 60/40 split and a details pane", () => {
    const html = renderPanelHtml(tree)
    assert.ok(html.includes('<main class="layout" id="layout">'))
    assert.ok(html.includes('<div class="flow" id="flow"'))
    assert.ok(html.includes('<aside class="details" id="details"'))
    assert.ok(html.includes(".flow { flex: 3;"))
    assert.ok(html.includes(".details {"))
    assert.ok(html.includes("Select a step to see its details."))
  })

  it("renders an always-present details toggle button", () => {
    const html = renderPanelHtml(tree)
    assert.ok(html.includes('<button id="details-toggle" type="button">Hide details</button>'))
    assert.ok(html.includes("detailsToggle.addEventListener"))
    assert.ok(html.includes(".layout.details-hidden .details { display: none; }"))
  })

  it("keeps full content out of the frame and flags nodes that have detail", () => {
    const html = renderFlowHtml(tree)
    assert.ok(!html.includes("data-content="), "content is fetched per node instead")
    assert.ok(!html.includes("data-reasoning="))
    assert.ok(html.includes('data-detail="1"'), "nodes with detail are marked for fetching")
    // The scannable preview stays inline.
    assert.ok(html.includes('<span class="step-content">Here are the files</span>'))
  })

  it("marks a node without content or reasoning as having no detail", () => {
    const bare: FlowTree = {
      sessionID: "s1",
      units: [
        {
          id: "m1",
          request: {
            id: "ur-m1",
            type: "user-request",
            label: "User request",
            state: "completed",
            content: "",
            children: [],
          },
          steps: [],
          plan: [],
        },
      ],
    }
    assert.ok(!renderFlowHtml(bare).includes("data-detail"))
  })

  it("fetches details from the node endpoint carrying the token", () => {
    const html = renderPanelHtml(tree)
    assert.ok(html.includes('fetch("/node" + window.location.search + "&id=" + encodeURIComponent(id))'))
  })

  it("keeps data attributes on a single line for SSE transport", () => {
    const flowHtml = renderFlowHtml(tree)
    assert.ok(!flowHtml.includes("\n"))
  })

  it("marks the selected step styling for highlight", () => {
    const html = renderPanelHtml(tree)
    assert.ok(html.includes(".step--selected {"))
    assert.ok(html.includes('step.classList.add("step--selected")'))
  })

  it("renders the flow html as a single line for SSE transport", () => {
    const flowHtml = renderFlowHtml(tree)
    assert.ok(!flowHtml.includes("\n"))
    assert.ok(flowHtml.includes("Tool: bash"))
  })

  it("keeps a multi-line plan title on a single line for SSE transport", () => {
    const multiline: FlowTree = {
      sessionID: "s1",
      units: [
        {
          id: "m1",
          request: tree.units[0]!.request,
          steps: [],
          plan: [{ id: "t1", title: "First line\nSecond line", state: "pending" }],
        },
      ],
    }
    const flowHtml = renderFlowHtml(multiline)
    assert.ok(!flowHtml.includes("\n"))
    assert.ok(flowHtml.includes("First line Second line"))
  })

  it("keeps a multi-line node label on a single line for SSE transport", () => {
    const noisy: FlowTree = {
      sessionID: "s1",
      units: [
        {
          id: "m1",
          request: {
            id: "ur-m1",
            type: "user-request",
            label: "Tool: bash · first line\nsecond line",
            state: "completed",
            content: "",
            children: [],
          },
          steps: [],
          plan: [],
        },
      ],
    }
    const flowHtml = renderFlowHtml(noisy)
    assert.ok(!flowHtml.includes("\n"))
    assert.ok(flowHtml.includes("Tool: bash · first line second line"))
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

describe("turn collapsing", () => {
  it("renders a ModelCall and its single ModelReply as one row", () => {
    const html = renderFlowHtml(tree)
    assert.ok(!html.includes("step--model-reply"), "the reply gets no row of its own")
    // The reply's text and reasoning move onto the call's row.
    assert.match(html, /step--model-call[^>]*>.*?<span class="step-content">Here are the files</)
    assert.match(html, /step--model-call[^>]*>.*?User asked for a listing/)
    // The reply's tool call becomes a direct child of the collapsed row.
    assert.match(html, /step--model-call[^>]*>.*?<ol class="steps steps--nested"><li class="step step--tool-call/)
  })

  it("keeps the ModelCall id so collapse and selection survive", () => {
    const html = renderFlowHtml(tree)
    assert.ok(html.includes('data-id="mc-m2"'))
    assert.ok(!html.includes('data-id="mr-m2"'))
  })

  it("drops one level of indentation from the text tree", () => {
    const text = renderTree(tree)
    assert.ok(text.includes("  [done] Model call: Here are the files"))
    assert.ok(text.includes("    [done] Tool: bash"))
    assert.ok(!text.includes("Model reply"))
  })

  it("leaves a ModelCall alone when it does not wrap exactly one reply", () => {
    const orchestration: FlowTree = {
      sessionID: "s1",
      units: [
        {
          id: "m1",
          request: tree.units[0]!.request,
          steps: [
            {
              id: "orc-1",
              type: "orchestration",
              label: "Orchestration",
              state: "completed",
              content: "",
              children: [],
            },
            {
              id: "mc-two",
              type: "model-call",
              label: "Model call",
              state: "completed",
              content: "",
              children: [
                {
                  id: "mr-a",
                  type: "model-reply",
                  label: "Model reply",
                  state: "completed",
                  content: "first",
                  children: [],
                },
                {
                  id: "mr-b",
                  type: "model-reply",
                  label: "Model reply",
                  state: "completed",
                  content: "second",
                  children: [],
                },
              ],
            },
          ],
          plan: [],
        },
      ],
    }
    const html = renderFlowHtml(orchestration)
    assert.ok(html.includes('data-id="mr-a"'))
    assert.ok(html.includes('data-id="mr-b"'))
    assert.ok(html.includes("step--orchestration"))
  })
})

describe("metrics", () => {
  const metered: FlowTree = {
    sessionID: "s1",
    units: [
      {
        id: "m1",
        request: tree.units[0]!.request,
        steps: [
          {
            id: "mc-m2",
            type: "model-call",
            label: "Model call",
            state: "completed",
            content: "",
            startedAt: 1_000,
            endedAt: 5_200,
            cost: 0.0042,
            tokens: { input: 1200, output: 380, reasoning: 0, cacheRead: 900, cacheWrite: 0 },
            children: [
              {
                id: "tc-c1",
                type: "tool-call",
                label: "Tool: bash · npm test",
                state: "completed",
                content: "",
                startedAt: 1_500,
                endedAt: 3_600,
                children: [],
              },
            ],
          },
        ],
        plan: [],
      },
    ],
  }

  it("formats durations by magnitude", () => {
    assert.equal(formatDuration(340), "340ms")
    assert.equal(formatDuration(2_100), "2.1s")
    assert.equal(formatDuration(64_000), "1m 04s")
  })

  it("formats token usage and cost compactly", () => {
    assert.equal(
      formatTokens({ input: 1200, output: 380, reasoning: 0, cacheRead: 900, cacheWrite: 0 }),
      "1.2k→380 tok (900 cached)",
    )
    assert.equal(formatCost(0.0042), "$0.0042")
    assert.equal(formatCost(1.5), "$1.50")
  })

  it("renders duration, tokens and cost badges on the node", () => {
    const html = renderFlowHtml(metered)
    assert.ok(html.includes('<span class="step-metric">4.2s</span>'))
    assert.ok(html.includes('<span class="step-metric">1.2k→380 tok (900 cached)</span>'))
    assert.ok(html.includes('<span class="step-metric">$0.0042</span>'))
    assert.ok(html.includes('<span class="step-metric">2.1s</span>'))
  })

  it("totals the unit in its heading", () => {
    const html = renderFlowHtml(metered)
    assert.ok(html.includes('<span class="unit-metric">4.2s</span>'))
    assert.ok(html.includes('<span class="unit-metric">1.6k tok</span>'))
    assert.ok(html.includes('<span class="unit-metric">$0.0042</span>'))
  })

  it("carries the same numbers into the text tree", () => {
    const text = renderTree(metered)
    assert.ok(text.includes("Unit of Work #1 [4.2s · 1.6k tok · $0.0042]"))
    assert.ok(text.includes("Tool: bash · npm test (2.1s)"))
  })

  it("omits badges when the platform reported no metrics", () => {
    const html = renderFlowHtml(tree)
    assert.ok(!html.includes("step-metric"))
    assert.ok(!html.includes("unit-metric"))
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

  it("renders a sub-agent summary node in both formats", () => {
    const summaryTree: FlowTree = {
      sessionID: "s1",
      units: [
        {
          id: "u1",
          request: {
            id: "ur",
            type: "user-request",
            label: "User request",
            state: "completed",
            content: "go",
            children: [],
          },
          steps: [
            {
              id: "sm",
              type: "subtask-summary",
              label: "2 more sub-agents",
              state: "completed",
              content: "agent4, agent5",
              children: [],
            },
          ],
          plan: [],
        },
      ],
    }
    assert.ok(renderPanelHtml(summaryTree).includes("2 more sub-agents"))
    assert.ok(renderTree(summaryTree).includes("2 more sub-agents"))
    assert.ok(renderTree(summaryTree).includes("agent4, agent5"))
  })

  it("renders expand/collapse toggles on nodes with children", () => {
    const html = renderPanelHtml(tree)
    assert.ok(html.includes("step-toggle"))
    assert.ok(html.includes("has-children"))
  })

  it("keeps the collapse toggle handler alongside the selection handler", () => {
    const html = renderPanelHtml(tree)
    assert.ok(html.includes('event.target.closest(".step-toggle")'))
    assert.ok(html.includes('step.classList.toggle("collapsed")'))
    assert.ok(html.includes('event.target.closest(".step-label")'))
  })

  it("emits a stable data-id on each step for collapse persistence", () => {
    const html = renderPanelHtml(tree)
    assert.ok(html.includes('data-id="mc-m2"'))
    assert.ok(html.includes('data-id="tr-c1"'))
  })

  it("marks sub-agent launch nodes visually", () => {
    const subTree: FlowTree = {
      sessionID: "s1",
      units: [
        {
          id: "u1",
          request: {
            id: "ur",
            type: "user-request",
            label: "User request",
            state: "completed",
            content: "go",
            children: [],
          },
          steps: [
            {
              id: "launch",
              type: "tool-call",
              label: "Sub-agent: explore",
              state: "completed",
              content: "Desc",
              subtask: true,
              children: [
                {
                  id: "child-req",
                  type: "user-request",
                  label: "User request",
                  state: "completed",
                  content: "probe",
                  children: [],
                },
              ],
            },
          ],
          plan: [],
        },
      ],
    }
    const html = renderPanelHtml(subTree)
    assert.ok(html.includes("step--subtask"))
    assert.ok(html.includes("sub-agent"))
    assert.ok(html.includes("step-toggle"))
  })
})
