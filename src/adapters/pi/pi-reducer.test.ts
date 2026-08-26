import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { PiFlowStore } from "./pi-reducer.ts"

const SID = "s1"

function store(): PiFlowStore {
  return new PiFlowStore(SID)
}

describe("PiFlowStore", () => {
  it("builds a simple unit with model call and answer", () => {
    const s = store()
    s.startUnit("u1", "Hello agent")
    s.startTurn("0")
    s.appendAssistantText("0", "Hi there!")
    s.finishTurn("0")
    s.closeOpenUnit()

    const tree = s.tree()
    assert.equal(tree.units.length, 1)
    const unit = tree.units[0]!
    assert.equal(unit.request.content, "Hello agent")
    assert.equal(unit.steps.length, 2)
    const modelCall = unit.steps[0]!
    assert.equal(modelCall.type, "model-call")
    assert.equal(modelCall.state, "completed")
    const reply = modelCall.children[0]!
    assert.equal(reply.content, "Hi there!")
    const ans = unit.steps[1]!
    assert.equal(ans.type, "answer")
    assert.equal(ans.content, "Hi there!")
  })

  it("tracks a regular tool call and its result", () => {
    const s = store()
    s.startUnit("u1", "run a tool")
    s.startTurn("0")
    s.onToolCall("c1", "bash", "0")
    s.onToolResult("c1", "bash", "hello from bash", false)
    s.closeOpenUnit()

    const unit = s.tree().units[0]!
    const reply = unit.steps[0]!.children[0]!
    const toolCall = reply.children[0]!
    assert.equal(toolCall.label, "Tool: bash")
    assert.equal(toolCall.state, "completed")
    assert.equal(toolCall.children[0]!.type, "tool-result")
    assert.equal(toolCall.children[0]!.content, "hello from bash")
  })

  it("marks a failed tool call", () => {
    const s = store()
    s.startUnit("u1", "x")
    s.startTurn("0")
    s.onToolCall("c1", "bash", "0")
    s.onToolResult("c1", "bash", "boom", true)
    const unit = s.tree().units[0]!
    const toolCall = unit.steps[0]!.children[0]!.children[0]!
    assert.equal(toolCall.state, "failed")
    assert.equal(toolCall.content, "boom")
  })

  it("treats oh_my_pi_delegate_task as subtask", () => {
    const s = store()
    s.startUnit("u1", "delegate")
    s.startTurn("0")
    const node = s.onToolCall("c1", "oh_my_pi_delegate_task", "0", { task: "do research", category: "deep" })
    assert.equal(node.subtask, true)
    assert.equal(node.label, "Sub-agent: deep")
    assert.equal(node.content, "do research")
    s.onToolResult("c1", "oh_my_pi_delegate_task", { task: "done task" }, false)
    assert.equal(node.state, "completed")
    assert.equal(node.content, "done task")
  })

  it("treats oh_my_pi_subagent as subtask with agent name", () => {
    const s = store()
    s.startUnit("u1", "delegate")
    s.startTurn("0")
    const node = s.onToolCall("c1", "oh_my_pi_subagent", "0", { agent: "explore", task: "find files" })
    assert.equal(node.label, "Sub-agent: explore")
    assert.equal(node.subtask, true)
    assert.equal(node.content, "find files")
  })

  it("appends reasoning via thinking_delta", () => {
    const s = store()
    s.startUnit("u1", "hi")
    s.startTurn("0")
    s.appendAssistantText("0", "", "Let me think")
    s.appendAssistantText("0", "Hello", undefined)
    const unit = s.tree().units[0]!
    const reply = unit.steps[0]!.children[0]!
    assert.equal(reply.reasoning, "Let me think")
    assert.equal(reply.content, "Hello")
  })

  it("creates synthetic node if tool_result arrives without tool_call", () => {
    const s = store()
    s.startUnit("u1", "x")
    s.onToolResult("c1", "bash", "out", false)
    const tree = s.tree()
    // synthetic tool_result with fallback turnId creates its own unit/turn
    assert.ok(tree.units.length >= 1)
    const allTools = tree.units.flatMap((u) => u.steps.flatMap((m) => m.children[0]?.children ?? []))
    assert.ok(allTools.some((t) => t.label === "Tool: bash" && t.state === "completed"))
  })

  it("handles multiple turns in one unit", () => {
    const s = store()
    s.startUnit("u1", "do stuff")
    s.startTurn("0")
    s.onToolCall("c1", "bash", "0")
    s.onToolResult("c1", "bash", "out", false)
    s.finishTurn("0")
    s.startTurn("1")
    s.appendAssistantText("1", "all done")
    s.finishTurn("1")
    s.closeOpenUnit()
    const unit = s.tree().units[0]!
    assert.equal(unit.steps.length, 3)
    assert.equal(unit.steps[2]!.type, "answer")
    assert.equal(unit.steps[2]!.content, "all done")
  })

  it("converts empty turn into orchestration node instead of hiding", () => {
    const s = store()
    s.startUnit("u1", "delegate a lot")
    s.startTurn("0")
    s.onToolCall("c0", "oh_my_pi_delegate_task", "0", { task: "t0", category: "deep" })
    s.finishTurn("0")
    s.startTurn("1")
    s.finishTurn("1")
    s.startTurn("2")
    s.finishTurn("2")
    const unit = s.tree().units[0]!
    assert.equal(unit.steps.length, 3)
    assert.equal(unit.steps[1]!.type, "orchestration")
    assert.equal(unit.steps[1]!.label, "Orchestration")
    assert.equal(unit.steps[1]!.children.length, 0)
    assert.equal(unit.steps[2]!.type, "orchestration")
  })

  it("ignores delegate_task JSON payload as model text", () => {
    const s = store()
    s.startUnit("u1", "x")
    s.startTurn("0")
    s.appendAssistantText("0", '{"i":"explore","path":"/a"}')
    s.finishTurn("0")
    const unit = s.tree().units[0]!
    // should be converted to orchestration because payload is filtered
    assert.equal(unit.steps[0]!.type, "orchestration")
  })
})
