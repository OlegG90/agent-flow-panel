import { describe, it, before } from "node:test"
import assert from "node:assert/strict"
import { JSDOM } from "jsdom"
import { renderExportHtml } from "./render.ts"
import type { FlowTree, StepNode, StepType } from "./types.ts"

/**
 * Behaviour tests for the panel's browser half.
 *
 * The static export is used deliberately: it carries the same client script
 * but no event stream and no /node fetch, so it runs in jsdom unmodified.
 * These assert what the page *does* — previously the only coverage was
 * matching substrings of the script, which cannot catch a cascade bug or a
 * filter that leaves empty boxes behind.
 */

function node(
  id: string,
  type: StepType,
  label: string,
  state: StepNode["state"],
  content = "",
  children: StepNode[] = [],
): StepNode {
  return { id, type, label, state, content, children }
}

const tree: FlowTree = {
  sessionID: "s1",
  units: [
    {
      id: "u1",
      request: node("ur-1", "user-request", "User request", "completed", "list the files"),
      steps: [
        node("mc-1", "model-call", "Model call", "completed", "Listing them.", [
          node("tc-1", "tool-call", "Tool: Bash · ls -la", "completed", "a.txt b.txt", [
            node("tr-1", "tool-result", "Result", "completed", "a.txt b.txt"),
          ]),
        ]),
        node("sys-1", "orchestration", "Context compacted (auto)", "completed", "168.3k → 10.7k"),
        node("sys-2", "orchestration", "API error 500", "failed", "retry 1/10"),
      ],
      plan: [],
    },
    {
      id: "u2",
      request: node("ur-2", "user-request", "User request", "completed", "run the tests"),
      steps: [
        node("mc-2", "model-call", "Model call", "completed", "Running them.", [
          node("tc-2", "tool-call", "Tool: Bash · npm test", "failed", "1 failing"),
        ]),
        node("ans-2", "answer", "Answer", "completed", "One test failed."),
      ],
      plan: [],
    },
  ],
}

let dom: JSDOM
let doc: Document
let win: Window & typeof globalThis

function q(selector: string): Element[] {
  return [...doc.querySelectorAll(selector)]
}

function visibleUnits(): Element[] {
  return q(".unit").filter((u) => win.getComputedStyle(u).display !== "none")
}

function filter(query: string): void {
  const input = doc.getElementById("filter-search") as HTMLInputElement
  input.value = query
  input.dispatchEvent(new win.Event("input"))
}

function click(id: string): void {
  doc.getElementById(id)!.dispatchEvent(new win.MouseEvent("click", { bubbles: true }))
}

before(() => {
  dom = new JSDOM(renderExportHtml(tree), { runScripts: "dangerously" })
  doc = dom.window.document
  win = dom.window as unknown as Window & typeof globalThis
})

describe("panel client — filtering", () => {
  it("matches on the label and hides units that have none", () => {
    filter("npm test")
    assert.equal(q(".step--hit").length, 1)
    assert.equal(visibleUnits().length, 1, "only the unit containing the hit stays")
    filter("")
  })

  it("matches on the node type, which appears in no label", () => {
    filter("orchestration")
    const hits = q(".step--hit").map((s) => s.querySelector(":scope > .step-label")!.textContent)
    assert.deepEqual(hits.sort(), ["API error 500", "Context compacted (auto)"])
    filter("")
  })

  it("never leaves a unit rendered with no visible steps", () => {
    filter("Answer")
    for (const unit of visibleUnits()) {
      const shown = [...unit.querySelectorAll(".step")].filter(
        (s) => !s.classList.contains("step--hidden"),
      )
      assert.ok(shown.length > 0, "a visible unit always shows at least one step")
    }
    filter("")
  })

  it("announces an empty result instead of blanking the page", () => {
    filter("zzz-nothing-matches")
    assert.equal(visibleUnits().length, 0)
    assert.equal((doc.getElementById("filter-empty") as HTMLElement).hidden, false)
    filter("")
    assert.equal((doc.getElementById("filter-empty") as HTMLElement).hidden, true)
  })

  it("restores every unit when the filter is cleared", () => {
    filter("npm test")
    filter("")
    assert.equal(visibleUnits().length, 2)
    assert.equal(q(".step--hidden").length, 0)
  })

  it("keeps an ancestor of a match visible so the hit keeps its context", () => {
    filter("npm test")
    const parent = doc.querySelector('[data-id="mc-2"]')!
    assert.ok(!parent.classList.contains("step--hidden"), "the model call around the hit stays")
    filter("")
  })
})

describe("panel client — failed-only toggle", () => {
  it("narrows to failed steps and back", () => {
    click("filter-failed")
    const labels = q(".step--hit").map((s) => s.querySelector(":scope > .step-label")!.textContent)
    assert.deepEqual(labels.sort(), ["API error 500", "Tool: Bash · npm test"])
    click("filter-failed")
    assert.equal(q(".step--hidden").length, 0)
  })
})

describe("panel client — unit order", () => {
  it("starts oldest-first, the order the work happened in", () => {
    assert.ok(!doc.getElementById("flow")!.classList.contains("newest-first"))
    assert.equal(win.getComputedStyle(doc.getElementById("flow")!).flexDirection, "column")
    // The first unit in the DOM is the first one that ran.
    const first = q(".unit")[0]!
    assert.match(first.textContent!, /list the files/)
  })

  it("flips to newest-first without reordering the DOM", () => {
    const before = q(".unit").map((u) => u.querySelector(".step-content")?.textContent)
    click("order-toggle")
    const flow = doc.getElementById("flow")!
    assert.ok(flow.classList.contains("newest-first"))
    assert.equal(win.getComputedStyle(flow).flexDirection, "column-reverse")
    // Reversal is presentational: ids, selection and the /node lookup all key
    // off the DOM, which must stay in causal order.
    assert.deepEqual(
      q(".unit").map((u) => u.querySelector(".step-content")?.textContent),
      before,
    )
    click("order-toggle")
    assert.ok(!flow.classList.contains("newest-first"))
  })

  it("relabels the button to name what the next press does", () => {
    const button = doc.getElementById("order-toggle")!
    assert.equal(button.textContent, "Newest first")
    click("order-toggle")
    assert.equal(button.textContent, "Oldest first")
    click("order-toggle")
    assert.equal(button.textContent, "Newest first")
  })

  it("never reverses the steps inside a unit", () => {
    // Steps are causally ordered — a tool result after its call. Only the
    // units flip; reversing inside one would be nonsense.
    click("order-toggle")
    const steps = q(".unit")[0]!.querySelector(".steps")!
    assert.notEqual(win.getComputedStyle(steps).flexDirection, "column-reverse")
    const labels = [...steps.querySelectorAll(":scope > .step > .step-label")].map((e) => e.textContent)
    assert.deepEqual(labels, [
      "User request",
      "Model call",
      "Context compacted (auto)",
      "API error 500",
    ])
    click("order-toggle")
  })
})

describe("panel client — collapse", () => {
  it("collapses and expands every node that has children", () => {
    click("collapse-all")
    const collapsed = q(".step.collapsed").length
    assert.ok(collapsed > 0, "something collapsed")
    assert.equal(collapsed, q(".step.has-children").length)
    click("expand-all")
    assert.equal(q(".step.collapsed").length, 0)
  })
})

describe("panel client — details pane", () => {
  it("shows the selected step's content", () => {
    const label = doc.querySelector('[data-id="tc-1"] > .step-label')!
    label.dispatchEvent(new win.MouseEvent("click", { bubbles: true }))
    const details = doc.getElementById("details")!
    assert.match(details.textContent!, /Tool: Bash · ls -la/)
    assert.match(details.textContent!, /a\.txt b\.txt/)
    assert.ok(doc.querySelector('[data-id="tc-1"]')!.classList.contains("step--selected"))
  })
})

describe("panel client — orchestration styling", () => {
  // The dimming was broken from the day the node type was introduced:
  // `.step--done { opacity: 1 }` sat after it in the sheet and won. Only a
  // test that resolves the cascade can catch that.
  it("dims a completed orchestration node", () => {
    const el = doc.querySelector('[data-id="sys-1"]')!
    assert.equal(win.getComputedStyle(el).opacity, "0.6")
  })

  it("leaves a failed orchestration node at full strength", () => {
    const el = doc.querySelector('[data-id="sys-2"]')!
    assert.equal(win.getComputedStyle(el).opacity, "1")
  })

  it("does not dim ordinary completed steps", () => {
    const el = doc.querySelector('[data-id="tc-1"]')!
    assert.equal(win.getComputedStyle(el).opacity, "1")
  })
})
