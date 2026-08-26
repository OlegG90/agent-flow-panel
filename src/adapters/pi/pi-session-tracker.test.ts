import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { PiSessionTracker } from "./pi-session-tracker.ts"

function simpleSession(tracker: PiSessionTracker, sid: string, prompt = "Hello"): void {
  tracker.dispatchBySession(sid, (s) => s.startUnit(`u-${sid}`, prompt))
  tracker.dispatchBySession(sid, (s) => s.startTurn("0"))
  tracker.dispatchBySession(sid, (s) => s.appendAssistantText("0", "Hi there!"))
  tracker.dispatchBySession(sid, (s) => s.finishTurn("0"))
  tracker.dispatchBySession(sid, (s) => s.closeOpenUnit())
}

function parentWithLaunch(tracker: PiSessionTracker, sid: string, agent = "explore"): void {
  tracker.dispatchBySession(sid, (s) => s.startUnit(`u-${sid}`, "delegate"))
  tracker.dispatchBySession(sid, (s) => s.startTurn("0"))
  tracker.dispatchBySession(sid, (s) => s.onToolCall("c0", "oh_my_pi_delegate_task", "0", { task: "do it", category: agent }))
}

function childSession(tracker: PiSessionTracker, sid: string, request: string): void {
  tracker.dispatchBySession(sid, (s) => s.startUnit(`u-${sid}`, request))
  tracker.dispatchBySession(sid, (s) => s.startTurn("0"))
  tracker.dispatchBySession(sid, (s) => s.appendAssistantText("0", "found it"))
  tracker.dispatchBySession(sid, (s) => s.finishTurn("0"))
  tracker.dispatchBySession(sid, (s) => s.closeOpenUnit())
}

describe("PiSessionTracker", () => {
  it("builds a Unit of Work from Pi events", () => {
    const tracker = new PiSessionTracker()
    tracker.setActiveSession("s1")
    simpleSession(tracker, "s1")

    const tree = tracker.tree()
    assert.equal(tree.sessionID, "s1")
    assert.equal(tree.units.length, 1)
    assert.equal(tree.units[0]!.request.content, "Hello")
    assert.equal(tree.units[0]!.steps[1]!.type, "answer")
  })

  it("tracks sessions independently", () => {
    const tracker = new PiSessionTracker()
    simpleSession(tracker, "a")
    simpleSession(tracker, "b")
    assert.equal(tracker.tree("a").units[0]!.request.content, "Hello")
    assert.equal(tracker.tree("b").units[0]!.request.content, "Hello")
  })

  it("setActiveSession selects which tree() returns", () => {
    const tracker = new PiSessionTracker()
    simpleSession(tracker, "a")
    tracker.setActiveSession("a")
    assert.equal(tracker.tree().sessionID, "a")
    simpleSession(tracker, "b")
    assert.equal(tracker.tree().sessionID, "a")
    tracker.setActiveSession("b")
    assert.equal(tracker.tree().sessionID, "b")
  })

  it("returns empty tree for unknown session", () => {
    const tracker = new PiSessionTracker()
    assert.equal(tracker.tree().units.length, 0)
    assert.equal(tracker.tree("nope").units.length, 0)
  })

  it("reset clears state", () => {
    const tracker = new PiSessionTracker()
    simpleSession(tracker, "s1")
    assert.equal(tracker.tree("s1").units.length, 1)
    tracker.reset()
    assert.equal(tracker.tree("s1").units.length, 0)
  })

  it("grafts a child session under its launch node", () => {
    const tracker = new PiSessionTracker()
    parentWithLaunch(tracker, "a", "explore")
    tracker.registerChild("a", "b", 1)
    childSession(tracker, "b", "research this")
    const unit = tracker.tree("a").units[0]!
    const launch = unit.steps[0]!.children[0]!.children[0]!
    assert.equal(launch.subtask, true)
    assert.equal(launch.children[0]!.type, "user-request")
    assert.equal(launch.children[0]!.content, "research this")
    assert.equal(launch.children[1]!.type, "model-call")
  })

  it("matches two sub-agents to their children in creation order", () => {
    const tracker = new PiSessionTracker()
    parentWithLaunch(tracker, "a", "explore")
    tracker.dispatchBySession("a", (s) => s.startTurn("1"))
    tracker.dispatchBySession("a", (s) => s.onToolCall("c1", "oh_my_pi_subagent", "1", { agent: "plan", task: "plan that" }))
    tracker.registerChild("a", "b", 5)
    tracker.registerChild("a", "c", 2)
    // children creation order: c (2) before b (5)
    childSession(tracker, "c", "plan that")
    childSession(tracker, "b", "research this")
    const unit = tracker.tree("a").units[0]!
    const firstLaunch = unit.steps[0]!.children[0]!.children[0]!
    const secondLaunch = unit.steps[1]!.children[0]!.children[0]!
    // ordered by created: c first, b second → firstLaunch gets c, second gets b
    assert.equal(firstLaunch.children[0]!.content, "plan that")
    assert.equal(secondLaunch.children[0]!.content, "research this")
  })

  it("expands nested sub-agents recursively", () => {
    const tracker = new PiSessionTracker()
    parentWithLaunch(tracker, "a", "explore")
    tracker.registerChild("a", "b", 1)
    // b session: keep unit open for nested delegate (don't close before second turn)
    tracker.dispatchBySession("b", (s) => s.startUnit("u-b", "research this"))
    tracker.dispatchBySession("b", (s) => s.startTurn("0"))
    tracker.dispatchBySession("b", (s) => s.appendAssistantText("0", "found it"))
    tracker.dispatchBySession("b", (s) => s.finishTurn("0"))
    // second turn in same unit (no close yet)
    tracker.dispatchBySession("b", (s) => s.startTurn("1"))
    tracker.dispatchBySession("b", (s) => s.onToolCall("c-b1", "oh_my_pi_delegate_task", "1", { task: "dig deeper", category: "deep" }))
    tracker.dispatchBySession("b", (s) => s.finishTurn("1"))
    tracker.dispatchBySession("b", (s) => s.closeOpenUnit())
    tracker.registerChild("b", "c", 2)
    childSession(tracker, "c", "dig deeper")
    const unit = tracker.tree("a").units[0]!
    const launchB = unit.steps[0]!.children[0]!.children[0]!
    // launchB now contains: request, modelCall0, modelCall1 (with nested launch)
    const modelCallB = launchB.children[2]!
    const replyB = modelCallB.children[0]!
    const launchC = replyB.children[0]!
    assert.equal(launchC.subtask, true)
    assert.equal(launchC.children[0]!.content, "dig deeper")
  })

  it("summarizes sub-agents beyond the third", () => {
    const tracker = new PiSessionTracker()
    tracker.dispatchBySession("a", (s) => s.startUnit("u-a", "delegate a lot"))
    for (let i = 0; i < 5; i++) {
      tracker.dispatchBySession("a", (s) => s.startTurn(String(i)))
      tracker.dispatchBySession("a", (s) => s.onToolCall(`c${i}`, "oh_my_pi_delegate_task", String(i), { task: `t${i}`, category: `agent${i + 1}` }))
    }
    for (let i = 0; i < 5; i++) {
      tracker.registerChild("a", `c${i + 1}`, i + 1)
      childSession(tracker, `c${i + 1}`, `child ${i + 1}`)
    }
    const unit = tracker.tree("a").units[0]!
    assert.equal(unit.steps.length, 6)
    for (let i = 0; i < 3; i++) {
      const launch = unit.steps[i]!.children[0]!.children[0]!
      assert.equal(launch.children[0]!.content, `child ${i + 1}`)
    }
    const summary = unit.steps[5]!
    assert.equal(summary.type, "subtask-summary")
    assert.equal(summary.label, "2 more sub-agents")
    assert.ok(summary.content.includes("agent4"))
    assert.ok(summary.content.includes("agent5"))
  })

  it("graftChildIntoParent is alias for registerChild", () => {
    const tracker = new PiSessionTracker()
    parentWithLaunch(tracker, "a")
    tracker.graftChildIntoParent("a", "b")
    childSession(tracker, "b", "via alias")
    const launch = tracker.tree("a").units[0]!.steps[0]!.children[0]!.children[0]!
    assert.equal(launch.children[0]!.content, "via alias")
  })
})
