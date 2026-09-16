import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { reducePiSession } from "./session-file.ts"

const T = (seconds: number): string => new Date(Date.UTC(2026, 0, 1, 0, 0, seconds)).toISOString()

const lines = [
  JSON.stringify({ type: "title", v: 1, title: "" }),
  JSON.stringify({ type: "session", version: 3, id: "sess-1", timestamp: T(0) }),
  JSON.stringify({ type: "model_change", id: "m1", timestamp: T(0), model: "x" }),
  JSON.stringify({ type: "thinking_level_change", id: "t1", timestamp: T(0), thinkingLevel: "medium" }),
  JSON.stringify({
    type: "message",
    id: "u1",
    timestamp: T(1),
    message: { role: "user", content: [{ type: "text", text: "list files" }] },
  }),
  JSON.stringify({
    type: "message",
    id: "a1",
    timestamp: T(3),
    message: {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "check workspace" },
        {
          type: "toolCall",
          id: "call_1",
          name: "bash",
          arguments: { i: "Checking git state", command: "git status" },
        },
      ],
    },
  }),
  JSON.stringify({
    type: "custom",
    customType: "tool_execution_start",
    id: "e1",
    timestamp: T(3),
    data: { toolCallId: "call_1", toolName: "bash" },
  }),
  JSON.stringify({
    type: "message",
    id: "r1",
    timestamp: T(4),
    message: {
      role: "toolResult",
      toolCallId: "call_1",
      toolName: "bash",
      content: [{ type: "text", text: "main\n" }],
      isError: false,
    },
  }),
  JSON.stringify({
    type: "message",
    id: "a2",
    timestamp: T(6),
    message: { role: "assistant", content: [{ type: "text", text: "Done." }] },
  }),
  JSON.stringify({
    type: "custom",
    customType: "session_exit",
    id: "x1",
    timestamp: T(6),
    data: { reason: "dispose", kind: "normal" },
  }),
]

describe("reducePiSession", () => {
  it("maps persistence records to a unit with turns, tools, and an answer", () => {
    const tree = reducePiSession(lines, "fallback")
    assert.equal(tree.sessionID, "sess-1")
    assert.equal(tree.units.length, 1)
    const unit = tree.units[0] as (typeof tree.units)[number]
    assert.equal(unit.request.content, "list files")

    const calls = unit.steps.filter((s) => s.type === "model-call")
    assert.equal(calls.length, 2)
    const tool = calls[0]?.children[0]?.children[0]
    assert.ok(tool)
    assert.equal(tool.type, "tool-call")
    assert.equal(tool.label, "Tool: bash · Checking git state")
    assert.equal(tool.state, "completed")
    assert.equal(tool.content, "main\n".slice(0, 2000))
    assert.equal(tool.children[0]?.type, "tool-result")

    const answer = unit.steps.at(-1)
    assert.equal(answer?.type, "answer")
    assert.equal(answer?.content, "Done.")
  })

  it("leaves nothing running in a finished file", () => {
    const tree = reducePiSession(lines)
    const states = JSON.stringify(tree)
    assert.ok(!states.includes('"running"'))
  })
})
