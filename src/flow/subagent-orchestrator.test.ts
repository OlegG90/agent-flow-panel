import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { JSDOM } from "jsdom"
import type { FlowTree } from "./types.ts"
import { renderFlowHtml, renderPanelHtml, renderTree } from "./render.ts"
import { STYLES } from "./panel-styles.ts"
import { PiFlowStore } from "../adapters/pi/pi-reducer.ts"
import { PiSessionTracker } from "../adapters/pi/pi-session-tracker.ts"
// ---------------------------------------------------------------------------
// Helpers — multi-site builders (allowed: shared domain fixtures)
// ---------------------------------------------------------------------------

function docOf(html: string): Document {
  const parsed = new JSDOM(html)
  return parsed.window.document
}

function simpleFlowTree(): FlowTree {
  return {
    sessionID: "s1",
    units: [
      {
        id: "u1",
        request: {
          id: "ur-u1",
          type: "user-request",
          label: "User request",
          state: "completed",
          content: "Build the feature",
          children: [],
        },
        steps: [],
        plan: [],
      },
    ],
  }
}

// Build a FlowTree with one sub-agent tool-call (collapsed turn) + nested child
function treeWithSubAgent(opts: {
  subAgentState?: "running" | "completed" | "failed"
  label?: string
  content?: string
  nestedContent?: string
} = {}): FlowTree {
  const t = simpleFlowTree()
  t.units[0]!.steps = [
    {
      id: "mc-0",
      type: "model-call",
      label: "Model call",
      state: "completed",
      content: "",
      children: [
        {
          id: "mr-0",
          type: "model-reply",
          label: "Model reply",
          state: "completed",
          content: "delegating work",
          children: [
            {
              id: "tc-c0",
              type: "tool-call",
              label: opts.label ?? "Sub-agent: explore",
              state: opts.subAgentState ?? "completed",
              content: opts.content ?? "explore codebase",
              subtask: true,
              children: opts.nestedContent
                ? [
                    {
                      id: "ur-nested",
                      type: "user-request",
                      label: "User request",
                      state: "completed",
                      content: opts.nestedContent,
                      children: [],
                    },
                  ]
                : [],
            },
          ],
        },
      ],
    },
  ]
  return t
}

function treeWithOrchestration(state: "completed" | "failed" | "running" = "completed"): FlowTree {
  const t = simpleFlowTree()
  t.units[0]!.steps = [
    {
      id: "mc-empty",
      type: "orchestration",
      label: "Harness · turn 1",
      state,
      content: "harness tick — no model output, no tools (worktree/queue housekeeping)",
      children: [],
    },
  ]
  return t
}

// ---------------------------------------------------------------------------
// 1. Sub-agent badge & classes
// ---------------------------------------------------------------------------

describe("sub-agent display — badge & classes", () => {
  it("renders the sub-agent badge and step--subtask class", () => {
    const html = renderFlowHtml(treeWithSubAgent())
    const doc = docOf(html)

    const node = doc.querySelector('[data-id="tc-c0"]')!
    assert.ok(node, "sub-agent node must exist")
    assert.ok(node.classList.contains("step--subtask"), "must carry step--subtask")
    assert.ok(node.classList.contains("step--tool-call"), "must keep tool-call type class")
    assert.ok(node.querySelector(".step-badge"), "badge element must exist")
    assert.equal(node.querySelector(".step-badge")!.textContent, "sub-agent")
    assert.equal(node.getAttribute("data-type"), "tool-call")
  })

  it("keeps the human label (Sub-agent: <agent>) and task as content preview", () => {
    const html = renderFlowHtml(treeWithSubAgent({ label: "Sub-agent: plan", content: "design the API" }))
    const doc = docOf(html)
    const node = doc.querySelector('[data-id="tc-c0"]')!
    assert.equal(node.querySelector(".step-label")!.textContent, "Sub-agent: plan")
    assert.equal(node.querySelector(".step-content")!.textContent, "design the API")
  })

  it("marks data-state correctly for running vs completed vs failed", () => {
    for (const state of ["running", "completed", "failed"] as const) {
      const html = renderFlowHtml(treeWithSubAgent({ subAgentState: state }))
      const doc = docOf(html)
      const node = doc.querySelector('[data-id="tc-c0"]')!
      assert.equal(node.getAttribute("data-state"), state, `state must be ${state}`)
      assert.ok(node.classList.contains(`step--${state === "completed" ? "done" : state}`))
    }
  })

  it("applies subtask background and nested border colour via stylesheet", () => {
    // Grounded in panel-styles: these rules are the visual contract
    assert.ok(STYLES.includes(".step--subtask { background: rgba(192, 132, 252, 0.08); }"))
    assert.ok(STYLES.includes(".step--subtask > .steps--nested { border-left-color: var(--subtask-summary); }"))
    assert.ok(STYLES.includes(".step-badge {"))
    assert.ok(STYLES.includes("var(--subtask-summary)"))
  })

  it("shows nested children (grafted child session) with indented border", () => {
    const html = renderFlowHtml(treeWithSubAgent({ nestedContent: "found 3 files" }))
    const doc = docOf(html)
    // After turn collapsing, sub-agent is direct child of model-call
    const nested = doc.querySelector('[data-id="tc-c0"] .steps--nested [data-id="ur-nested"]')
    assert.ok(nested, "grafted child request must be nested under sub-agent")
    assert.equal(nested!.querySelector(".step-content")!.textContent, "found 3 files")
  })

  it("text tree marks sub-agent with [done]/[running] and indents its children", () => {
    const text = renderTree(treeWithSubAgent({ nestedContent: "found 3 files" }))
    assert.match(text, /\[done\] Sub-agent: explore/)
    assert.match(text, /found 3 files/)
  })
})

// ---------------------------------------------------------------------------
// 2. Sub-agent via real PiFlowStore + PiSessionTracker grafting
// ---------------------------------------------------------------------------

describe("sub-agent display — tracker grafting (end-to-end)", () => {
  it("grafts a child session under its launch node (Pi harness)", () => {
    const tracker = new PiSessionTracker()
    // parent launches sub-agent
    tracker.dispatchBySession("parent", (s) => s.startUnit("u-parent", "delegate work"))
    tracker.dispatchBySession("parent", (s) => s.startTurn("0"))
    tracker.dispatchBySession("parent", (s) =>
      s.onToolCall("c0", "oh_my_pi_delegate_task", "0", { task: "explore codebase", agent: "explore" }),
    )
    tracker.dispatchBySession("parent", (s) => s.onToolResult("c0", "oh_my_pi_delegate_task", "done", false))
    tracker.dispatchBySession("parent", (s) => s.finishTurn("0"))
    tracker.dispatchBySession("parent", (s) => s.closeOpenUnit())

    // child does real work
    tracker.dispatchBySession("child", (s) => s.startUnit("u-child", "explore codebase"))
    tracker.dispatchBySession("child", (s) => s.startTurn("0"))
    tracker.dispatchBySession("child", (s) => s.appendAssistantText("0", "found 3 files"))
    tracker.dispatchBySession("child", (s) => s.finishTurn("0"))
    tracker.dispatchBySession("child", (s) => s.closeOpenUnit())

    tracker.registerChild("parent", "child", 1)
    tracker.setActiveSession("parent")

    const html = renderPanelHtml(tracker.tree())
    const doc = docOf(html)

    const subAgent = doc.querySelector('[data-id="tc-c0"]')!
    assert.ok(subAgent, "launch node must exist in panel")
    assert.ok(subAgent.classList.contains("step--subtask"))
    assert.equal(subAgent.querySelector(".step-label")!.textContent, "Sub-agent: explore")

    // Grafted child request appears nested
    const grafted = subAgent.querySelector('[data-id="ur-u-child"]')
    assert.ok(grafted, "child session request must be grafted under sub-agent")
    assert.ok(grafted!.textContent!.includes("explore codebase"))

    // Child model output also grafted
    const childModelOutput = subAgent.textContent ?? ""
    assert.ok(childModelOutput.includes("found 3 files"))
  })

  it("collapses >3 sub-agents into a summary node", () => {
    const tracker = new PiSessionTracker()
    tracker.dispatchBySession("p", (s) => s.startUnit("u-p", "big delegate"))
    tracker.dispatchBySession("p", (s) => s.startTurn("0"))
    for (let i = 0; i < 5; i++) {
      tracker.dispatchBySession("p", (s) =>
        s.onToolCall(`c${i}`, "oh_my_pi_delegate_task", "0", { task: `task ${i}`, category: `agent-${i}` }),
      )
    }
    tracker.dispatchBySession("p", (s) => s.finishTurn("0"))
    tracker.dispatchBySession("p", (s) => s.closeOpenUnit())

    for (let i = 0; i < 5; i++) {
      tracker.dispatchBySession(`child-${i}`, (s) => s.startUnit(`u-${i}`, `task ${i}`))
      tracker.dispatchBySession(`child-${i}`, (s) => s.startTurn("0"))
      tracker.dispatchBySession(`child-${i}`, (s) => s.appendAssistantText("0", `result ${i}`))
      tracker.dispatchBySession(`child-${i}`, (s) => s.finishTurn("0"))
      tracker.dispatchBySession(`child-${i}`, (s) => s.closeOpenUnit())
      tracker.registerChild("p", `child-${i}`, i)
    }

    tracker.setActiveSession("p")
    const tree = tracker.tree()
    const html = renderFlowHtml(tree)
    const doc = docOf(html)

    // First 3 stay detailed (have subtask class)
    const subtasks = doc.querySelectorAll(".step--subtask")
    assert.equal(subtasks.length, 3, "only 3 detailed sub-agent nodes")

    // The rest become a summary node
    const summary = doc.querySelector('[data-type="subtask-summary"]')!
    assert.ok(summary, "summary node must exist")
    assert.match(summary.textContent ?? "", /2 more sub-agents/)
    assert.ok(summary.classList.contains("step--subtask-summary"))
  })

  it("treats task / oh_my_pi_subagent as sub-agent too (generic delegate)", () => {
    const s = new PiFlowStore("s1")
    s.startUnit("u1", "delegate")
    s.startTurn("0")
    const n = s.onToolCall("c99", "task", "0", { task: "do research" })
    assert.equal(n.subtask, true)
    assert.match(n.label, /Sub-agent/)
  })
})

// ---------------------------------------------------------------------------
// 3. Orchestrator display
// ---------------------------------------------------------------------------

describe("orchestrator display", () => {
  it("renders dashed orchestration node with dimmed style when completed", () => {
    const html = renderPanelHtml(treeWithOrchestration("completed"))
    const doc = docOf(html)

    const node = doc.querySelector('[data-id="mc-empty"]')!
    assert.ok(node)
    assert.ok(node.classList.contains("step--orchestration"))
    assert.ok(node.classList.contains("step--done"), "completed -> done class")
    assert.equal(node.getAttribute("data-type"), "orchestration")
    assert.equal(node.getAttribute("data-state"), "completed")
    assert.equal(node.querySelector(".step-label")!.textContent, "Harness · turn 1")
    assert.equal(
      node.querySelector(".step-content")!.textContent,
      "harness tick — no model output, no tools (worktree/queue housekeeping)",
    )

    // Stylesheet contract: dimming must outrank .step--done
    assert.ok(STYLES.includes(".step--orchestration { border-color: var(--orchestration); border-style: dashed; }"))
    assert.ok(STYLES.includes(".step--orchestration.step--done { opacity: 0.6; }"))
  })

  it("does NOT dim a failed orchestration node", () => {
    const html = renderPanelHtml(treeWithOrchestration("failed"))
    const doc = docOf(html)

    const node = doc.querySelector('[data-id="mc-empty"]')!
    assert.ok(node.classList.contains("step--orchestration"))
    assert.ok(node.classList.contains("step--failed"))
    // Base orchestration rule must not carry opacity
    assert.ok(!/\.step--orchestration \{[^}]*opacity/.test(STYLES))
  })

  it("is produced by PiFlowStore for an empty turn", () => {
    const store = new PiFlowStore("s1", () => 1000)
    store.startUnit("u1", "hello")
    store.startTurn("t-empty")
    // no text, no tool calls -> empty
    store.finishTurn("t-empty")

    const tree = store.tree()
    const turn = tree.units[0]!.steps[0]!
    assert.equal(turn.type, "orchestration", "empty turn becomes orchestration")
    assert.equal(turn.label, "Harness · turn t-empty")
    assert.ok(turn.content.includes("harness tick"))
    assert.equal(turn.children.length, 0, "empty orchestration drops the reply child")
  })

  it("text tree shows orchestration with [done] and explains itself", () => {
    const text = renderTree(treeWithOrchestration("completed"))
    assert.match(text, /\[done\] Harness · turn 1/)
    assert.match(text, /harness tick/)
  })

  it("running orchestration is not dimmed (only done is dimmed)", () => {
    const html = renderPanelHtml(treeWithOrchestration("running"))
    const doc = docOf(html)
    const node = doc.querySelector('[data-id="mc-empty"]')!
    assert.ok(node.classList.contains("step--running"))
    assert.ok(!node.classList.contains("step--done"))
  })
})

// ---------------------------------------------------------------------------
// 4. Combined — sub-agent that itself contains orchestration
// ---------------------------------------------------------------------------

describe("combined — sub-agent + orchestrator", () => {
  it("renders a sub-agent whose grafted child contains an orchestration tick", () => {
    const tracker = new PiSessionTracker()
    // parent
    tracker.dispatchBySession("parent", (s) => s.startUnit("u-parent", "delegate"))
    tracker.dispatchBySession("parent", (s) => s.startTurn("0"))
    tracker.dispatchBySession("parent", (s) =>
      s.onToolCall("c0", "oh_my_pi_delegate_task", "0", { task: "explore", agent: "explore" }),
    )
    tracker.dispatchBySession("parent", (s) => s.finishTurn("0"))
    tracker.dispatchBySession("parent", (s) => s.closeOpenUnit())

    // child: one orchestration tick then real work
    tracker.dispatchBySession("child", (s) => s.startUnit("u-child", "explore"))
    tracker.dispatchBySession("child", (s) => s.startTurn("empty"))
    // leave empty -> orchestration
    tracker.dispatchBySession("child", (s) => s.finishTurn("empty"))
    tracker.dispatchBySession("child", (s) => s.startTurn("real"))
    tracker.dispatchBySession("child", (s) => s.appendAssistantText("real", "found files"))
    tracker.dispatchBySession("child", (s) => s.finishTurn("real"))
    tracker.dispatchBySession("child", (s) => s.closeOpenUnit())

    tracker.registerChild("parent", "child", 1)
    tracker.setActiveSession("parent")

    const html = renderPanelHtml(tracker.tree())
    const doc = docOf(html)

    const subAgent = doc.querySelector('[data-id="tc-c0"]')!
    assert.ok(subAgent.classList.contains("step--subtask"))

    // Orchestration tick is nested inside sub-agent
    const orch = subAgent.querySelector(".step--orchestration")!
    assert.ok(orch, "orchestration must be inside sub-agent")
    assert.ok(orch.classList.contains("step--done"))
    assert.match(orch.textContent ?? "", /Harness · turn empty/)

    // Real work also inside same sub-agent
    assert.match(subAgent.textContent ?? "", /found files/)
  })

  it("regular tool calls are NOT subtask — no badge, no subtask class", () => {
    const s = new PiFlowStore("s1")
    s.startUnit("u1", "hello")
    s.startTurn("0")
    s.onToolCall("c1", "read_file", "0")
    s.finishTurn("0")
    s.closeOpenUnit()

    const html = renderFlowHtml(s.tree())
    const doc = docOf(html)
    const tool = doc.querySelector('[data-id="tc-c1"]')!
    assert.ok(tool)
    assert.ok(!tool.classList.contains("step--subtask"), "regular tool must not be subtask")
    assert.equal(tool.querySelector(".step-badge"), null, "no badge for regular tool")
    assert.ok(tool.classList.contains("step--tool-call"))
  })
})
