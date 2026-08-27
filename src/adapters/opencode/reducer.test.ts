import { describe, it } from "node:test"
import assert from "node:assert/strict"
import type { Event, Message, Part } from "@opencode-ai/sdk"
import { FlowStore } from "./reducer.ts"

const SESSION = "s1"

function userMessage(id: string): Message {
  return {
    id,
    sessionID: SESSION,
    role: "user",
    time: { created: 1 },
    agent: "build",
    model: { providerID: "opencode", modelID: "x" },
  } as Message
}

function assistantMessage(id: string, completed = false): Message {
  return {
    id,
    sessionID: SESSION,
    role: "assistant",
    time: { created: 1, ...(completed ? { completed: 2 } : {}) },
    parentID: "p",
    modelID: "m",
    providerID: "opencode",
    mode: "primary",
    path: { cwd: "/c", root: "/r" },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  } as Message
}

function updated(message: Message): Event {
  return { type: "message.updated", properties: { info: message } } as Event
}

function part(id: string, messageID: string, body: object): Part {
  return { id, sessionID: SESSION, messageID, ...body } as Part
}

function partUpdated(value: Part): Event {
  return { type: "message.part.updated", properties: { part: value } } as Event
}

function partUpdatedDelta(value: Part, delta: string): Event {
  return { type: "message.part.updated", properties: { part: value, delta } } as Event
}

function idle(): Event {
  return { type: "session.idle", properties: { sessionID: SESSION } } as Event
}

function todos(list: Array<{ id: string; content: string; status: string }>): Event {
  return { type: "todo.updated", properties: { sessionID: SESSION, todos: list } } as Event
}

function store(events: Event[]): FlowStore {
  const flow = new FlowStore(SESSION)
  for (const event of events) {
    flow.dispatch(event)
  }
  return flow
}

const stepFinish = {
  type: "step-finish",
  reason: "done",
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
}

describe("FlowStore", () => {
  it("builds a simple request unit with reply and answer", () => {
    const flow = store([
      updated(userMessage("m1")),
      partUpdated(part("p1", "m1", { type: "text", text: "Hello agent" })),
      updated(assistantMessage("m2")),
      partUpdated(part("p2", "m2", { type: "step-start" })),
      partUpdated(part("p3", "m2", { type: "reasoning", text: "Let me think" })),
      partUpdated(part("p4", "m2", { type: "text", text: "Hi there!" })),
      partUpdated(part("p5", "m2", stepFinish)),
      idle(),
    ])

    const tree = flow.tree()
    assert.equal(tree.units.length, 1)
    const unit = tree.units[0]!
    assert.equal(unit.request.type, "user-request")
    assert.equal(unit.request.content, "Hello agent")
    assert.equal(unit.request.state, "completed")
    assert.equal(unit.steps.length, 2)
    const modelCall = unit.steps[0]!
    assert.equal(modelCall.type, "model-call")
    assert.equal(modelCall.state, "completed")
    const modelReply = modelCall.children[0]!
    assert.equal(modelReply.type, "model-reply")
    assert.equal(modelReply.reasoning, "Let me think")
    assert.equal(modelReply.content, "Hi there!")
    const answer = unit.steps[1]!
    assert.equal(answer.type, "answer")
    assert.equal(answer.content, "Hi there!")
  })

  it("tracks a tool call and its result", () => {
    const flow = store([
      updated(userMessage("m1")),
      partUpdated(part("p1", "m1", { type: "text", text: "run a tool" })),
      updated(assistantMessage("m2")),
      partUpdated(part("p2", "m2", { type: "step-start" })),
      partUpdated(
        part("p3", "m2", { type: "tool", callID: "c1", tool: "bash", state: { status: "pending", input: {}, raw: "" } }),
      ),
      partUpdated(
        part("p4", "m2", { type: "tool", callID: "c1", tool: "bash", state: { status: "running", input: {}, time: { start: 1 } } }),
      ),
      partUpdated(
        part("p5", "m2", {
          type: "tool",
          callID: "c1",
          tool: "bash",
          state: { status: "completed", input: {}, output: "hello from bash", title: "bash", metadata: {}, time: { start: 1, end: 2 } },
        }),
      ),
      updated(assistantMessage("m2", true)),
      idle(),
    ])

    const unit = flow.tree().units[0]!
    const modelReply = unit.steps[0]!.children[0]!
    const toolCall = modelReply.children[0]!
    assert.equal(toolCall.type, "tool-call")
    assert.equal(toolCall.label, "Tool: bash")
    assert.equal(toolCall.state, "completed")
    const toolResult = toolCall.children[0]!
    assert.equal(toolResult.type, "tool-result")
    assert.equal(toolResult.content, "hello from bash")
  })

  it("marks a failed tool call", () => {
    const flow = store([
      updated(userMessage("m1")),
      partUpdated(part("p1", "m1", { type: "text", text: "x" })),
      updated(assistantMessage("m2")),
      partUpdated(part("p2", "m2", { type: "step-start" })),
      partUpdated(
        part("p3", "m2", { type: "tool", callID: "c1", tool: "bash", state: { status: "error", input: {}, error: "boom", time: { start: 1, end: 2 } } }),
      ),
    ])

    const unit = flow.tree().units[0]!
    const toolCall = unit.steps[0]!.children[0]!.children[0]!
    assert.equal(toolCall.state, "failed")
    assert.equal(toolCall.content, "boom")
    assert.equal(toolCall.children.length, 0)
  })

  it("records a sub-agent launch as a single marked node", () => {
    const flow = store([
      updated(userMessage("m1")),
      partUpdated(part("p1", "m1", { type: "text", text: "delegate" })),
      updated(assistantMessage("m2")),
      partUpdated(part("p2", "m2", { type: "step-start" })),
      partUpdated(part("p3", "m2", { type: "subtask", prompt: "do it", description: "A research sub-agent", agent: "explore" })),
    ])

    const unit = flow.tree().units[0]!
    const modelReply = unit.steps[0]!.children[0]!
    const node = modelReply.children[0]!
    assert.equal(node.type, "tool-call")
    assert.equal(node.label, "Sub-agent: explore")
    assert.equal(node.subtask, true)
    assert.equal(node.state, "running")
    assert.equal(node.children.length, 0)
  })

  it("merges a task tool call and a subtask part into one node", () => {
    const flow = store([
      updated(userMessage("m1")),
      partUpdated(part("p1", "m1", { type: "text", text: "delegate" })),
      updated(assistantMessage("m2")),
      partUpdated(part("p2", "m2", { type: "step-start" })),
      partUpdated(
        part("p3", "m2", { type: "tool", callID: "c1", tool: "task", state: { status: "running", input: {}, time: { start: 1 } } }),
      ),
      partUpdated(part("p4", "m2", { type: "subtask", prompt: "do it", description: "A research sub-agent", agent: "explore" })),
      partUpdated(
        part("p5", "m2", {
          type: "tool",
          callID: "c1",
          tool: "task",
          state: { status: "completed", input: {}, output: "done", title: "task", metadata: {}, time: { start: 1, end: 2 } },
        }),
      ),
    ])

    const unit = flow.tree().units[0]!
    const modelReply = unit.steps[0]!.children[0]!
    assert.equal(modelReply.children.length, 1)
    const node = modelReply.children[0]!
    assert.equal(node.subtask, true)
    assert.equal(node.label, "Sub-agent: explore")
    assert.equal(node.content, "A research sub-agent")
    assert.equal(node.state, "completed")
    assert.equal(node.children.length, 0)
  })

  it("merges when the subtask part arrives before the task tool call", () => {
    const flow = store([
      updated(userMessage("m1")),
      partUpdated(part("p1", "m1", { type: "text", text: "delegate" })),
      updated(assistantMessage("m2")),
      partUpdated(part("p2", "m2", { type: "step-start" })),
      partUpdated(part("p3", "m2", { type: "subtask", prompt: "do it", description: "A research sub-agent", agent: "explore" })),
      partUpdated(
        part("p4", "m2", { type: "tool", callID: "c1", tool: "task", state: { status: "running", input: {}, time: { start: 1 } } }),
      ),
    ])

    const unit = flow.tree().units[0]!
    const modelReply = unit.steps[0]!.children[0]!
    assert.equal(modelReply.children.length, 1)
    const node = modelReply.children[0]!
    assert.equal(node.subtask, true)
    assert.equal(node.state, "running")
  })

  it("keeps the sub-agent description on a failed launch", () => {
    const flow = store([
      updated(userMessage("m1")),
      partUpdated(part("p1", "m1", { type: "text", text: "delegate" })),
      updated(assistantMessage("m2")),
      partUpdated(part("p2", "m2", { type: "step-start" })),
      partUpdated(part("p3", "m2", { type: "subtask", prompt: "do it", description: "A research sub-agent", agent: "explore" })),
      partUpdated(
        part("p4", "m2", { type: "tool", callID: "c1", tool: "task", state: { status: "error", input: {}, error: "boom", time: { start: 1, end: 2 } } }),
      ),
    ])

    const unit = flow.tree().units[0]!
    const node = unit.steps[0]!.children[0]!.children[0]!
    assert.equal(node.state, "failed")
    assert.ok(node.content.includes("A research sub-agent"))
    assert.ok(node.content.includes("boom"))
  })

  it("creates a separate node per sub-agent when a turn launches several", () => {
    const flow = store([
      updated(userMessage("m1")),
      partUpdated(part("p1", "m1", { type: "text", text: "delegate two" })),
      updated(assistantMessage("m2")),
      partUpdated(part("p2", "m2", { type: "step-start" })),
      partUpdated(part("p3", "m2", { type: "subtask", prompt: "p", description: "D1", agent: "agent1" })),
      partUpdated(part("p4", "m2", { type: "subtask", prompt: "p", description: "D2", agent: "agent2" })),
      partUpdated(
        part("p5", "m2", { type: "tool", callID: "c1", tool: "task", state: { status: "completed", input: {}, output: "o1", title: "task", metadata: {}, time: { start: 1, end: 2 } } }),
      ),
      partUpdated(
        part("p6", "m2", { type: "tool", callID: "c2", tool: "task", state: { status: "completed", input: {}, output: "o2", title: "task", metadata: {}, time: { start: 1, end: 2 } } }),
      ),
    ])

    const unit = flow.tree().units[0]!
    const reply = unit.steps[0]!.children[0]!
    assert.equal(reply.children.length, 2)
    const a = reply.children[0]!
    const b = reply.children[1]!
    assert.equal(a.subtask, true)
    assert.equal(b.subtask, true)
    assert.equal(a.label, "Sub-agent: agent1")
    assert.equal(b.label, "Sub-agent: agent2")
    assert.equal(a.state, "completed")
    assert.equal(b.state, "completed")
  })

  it("keeps separate nodes when task calls arrive before subtask parts in one turn", () => {
    const flow = store([
      updated(userMessage("m1")),
      partUpdated(part("p1", "m1", { type: "text", text: "delegate two" })),
      updated(assistantMessage("m2")),
      partUpdated(part("p2", "m2", { type: "step-start" })),
      partUpdated(
        part("p5", "m2", { type: "tool", callID: "c1", tool: "task", state: { status: "completed", input: {}, output: "o1", title: "task", metadata: {}, time: { start: 1, end: 2 } } }),
      ),
      partUpdated(
        part("p6", "m2", { type: "tool", callID: "c2", tool: "task", state: { status: "completed", input: {}, output: "o2", title: "task", metadata: {}, time: { start: 1, end: 2 } } }),
      ),
      partUpdated(part("p3", "m2", { type: "subtask", prompt: "p", description: "D1", agent: "agent1" })),
      partUpdated(part("p4", "m2", { type: "subtask", prompt: "p", description: "D2", agent: "agent2" })),
    ])

    const unit = flow.tree().units[0]!
    const reply = unit.steps[0]!.children[0]!
    assert.equal(reply.children.length, 2)
    assert.equal(reply.children[0]!.label, "Sub-agent: agent1")
    assert.equal(reply.children[1]!.label, "Sub-agent: agent2")
  })

  it("leaves regular tool calls unmarked", () => {
    const flow = store([
      updated(userMessage("m1")),
      partUpdated(part("p1", "m1", { type: "text", text: "x" })),
      updated(assistantMessage("m2")),
      partUpdated(part("p2", "m2", { type: "step-start" })),
      partUpdated(
        part("p3", "m2", { type: "tool", callID: "c1", tool: "bash", state: { status: "completed", input: {}, output: "out", title: "bash", metadata: {}, time: { start: 1, end: 2 } } }),
      ),
    ])

    const unit = flow.tree().units[0]!
    const toolCall = unit.steps[0]!.children[0]!.children[0]!
    assert.equal(toolCall.subtask, undefined)
    assert.equal(toolCall.children[0]!.type, "tool-result")
  })

  it("previews the plan from todo updates", () => {
    const flow = store([
      updated(userMessage("m1")),
      partUpdated(part("p1", "m1", { type: "text", text: "plan me" })),
      todos([
        { id: "t1", content: "Step one", status: "pending" },
        { id: "t2", content: "Step two", status: "in_progress" },
      ]),
      todos([
        { id: "t1", content: "Step one", status: "completed" },
        { id: "t2", content: "Step two", status: "completed" },
      ]),
    ])

    const unit = flow.tree().units[0]!
    assert.equal(unit.plan.length, 2)
    assert.equal(unit.plan[0]!.state, "completed")
    assert.equal(unit.plan[1]!.state, "completed")
  })

  it("closes a unit when the next user request arrives", () => {
    const flow = store([
      updated(userMessage("m1")),
      partUpdated(part("p1", "m1", { type: "text", text: "first" })),
      updated(assistantMessage("m2")),
      partUpdated(part("p2", "m2", { type: "step-start" })),
      partUpdated(part("p3", "m2", { type: "text", text: "answer one" })),
      updated(userMessage("m3")),
      partUpdated(part("p4", "m3", { type: "text", text: "second" })),
    ])

    const tree = flow.tree()
    assert.equal(tree.units.length, 2)
    const first = tree.units[0]!
    const answer = first.steps[1]!
    assert.equal(answer.type, "answer")
    assert.equal(answer.content, "answer one")
  })

  it("appends text deltas without duplicating content", () => {
    const flow = store([
      updated(userMessage("m1")),
      partUpdated(part("p1", "m1", { type: "text", text: "hi" })),
      updated(assistantMessage("m2")),
      partUpdated(part("p2", "m2", { type: "step-start" })),
      partUpdatedDelta(part("p3", "m2", { type: "text", text: "Hel" }), "Hel"),
      partUpdatedDelta(part("p4", "m2", { type: "text", text: "Hello" }), "lo"),
      idle(),
    ])

    const unit = flow.tree().units[0]!
    const reply = unit.steps[0]!.children[0]!
    assert.equal(reply.content, "Hello")
  })

  it("applies todo updates to the next unit when none is open", () => {
    const flow = store([
      todos([{ id: "t1", content: "Early plan", status: "pending" }]),
      updated(userMessage("m1")),
      partUpdated(part("p1", "m1", { type: "text", text: "hi" })),
    ])

    const unit = flow.tree().units[0]!
    assert.equal(unit.plan.length, 1)
    assert.equal(unit.plan[0]!.title, "Early plan")
    assert.equal(unit.plan[0]!.state, "pending")
  })

  it("does not create a unit without a real user request", () => {
    const flow = store([
      updated(assistantMessage("m2")),
      partUpdated(part("p2", "m2", { type: "step-start" })),
      partUpdated(part("p3", "m2", { type: "text", text: "hi" })),
      partUpdated(
        part("p4", "m2", {
          type: "tool",
          callID: "c1",
          tool: "bash",
          state: { status: "completed", input: {}, output: "out", title: "bash", metadata: {}, time: { start: 1, end: 2 } },
        }),
      ),
    ])

    assert.equal(flow.tree().units.length, 0)
  })

  it("records multiple turns in one unit", () => {
    const flow = store([
      updated(userMessage("m1")),
      partUpdated(part("p1", "m1", { type: "text", text: "do stuff" })),
      updated(assistantMessage("m2")),
      partUpdated(part("p2", "m2", { type: "step-start" })),
      partUpdated(
        part("p3", "m2", {
          type: "tool",
          callID: "c1",
          tool: "bash",
          state: { status: "completed", input: {}, output: "out", title: "bash", metadata: {}, time: { start: 1, end: 2 } },
        }),
      ),
      partUpdated(part("p4", "m2", stepFinish)),
      updated(assistantMessage("m3")),
      partUpdated(part("p5", "m3", { type: "step-start" })),
      partUpdated(part("p6", "m3", { type: "text", text: "all done" })),
      partUpdated(part("p7", "m3", stepFinish)),
      idle(),
    ])

    const unit = flow.tree().units[0]!
    assert.equal(unit.steps.length, 3)
    const answer = unit.steps[2]!
    assert.equal(answer.type, "answer")
    assert.equal(answer.content, "all done")
  })
})
