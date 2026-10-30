import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import type { StepNode } from "../../flow/types.ts"
import type { V2Event } from "./v2-reducer.ts"
import { V2SessionTracker } from "./v2-session-tracker.ts"

const PARENT = "ses_e7364762bffeeGglkQc3NKwqaT"

/** A real OpenCode 2.2.3 run: read a file, launch one `general` sub-agent, answer. */
function recordedRun(): V2Event[] {
  const url = new URL("./fixtures/v2-subagent-run.json", import.meta.url)
  return JSON.parse(readFileSync(url, "utf8")) as V2Event[]
}

function trackerWith(events: V2Event[]): V2SessionTracker {
  const tracker = new V2SessionTracker()
  for (const event of events) {
    tracker.dispatch(event)
  }
  return tracker
}

function ev<T extends V2Event["type"]>(
  type: T,
  data: Extract<V2Event, { type: T }>["data"],
  created = 1,
): V2Event {
  return { type, created, data } as V2Event
}

/** One prompt delivered to `sessionID`, opening a unit with id `inboxID`. */
function prompt(sessionID: string, inboxID: string, text: string): V2Event[] {
  return [
    ev("session.inbox.enqueued", { sessionID, inboxID, item: { type: "user", payload: { text } } }),
    ev("session.inbox.delivered", { sessionID, inboxID }),
  ]
}

const usage = { input: 10, output: 2, reasoning: 1, cache: { read: 4, write: 0 } }

function labels(nodes: StepNode[]): string[] {
  return nodes.map((node) => node.label)
}

describe("V2SessionTracker on a recorded OpenCode 2.2.3 run", () => {
  const tree = trackerWith(recordedRun()).tree(PARENT)

  it("opens one unit for the prompt and closes it with the final answer", () => {
    assert.equal(tree.units.length, 1)
    const unit = tree.units[0]!
    assert.match(unit.request.content, /First call todowrite/)
    const answer = unit.steps.at(-1)!
    assert.equal(answer.type, "answer")
    assert.match(answer.content, /^Done/)
  })

  it("records one completed model call per step, with usage", () => {
    const calls = tree.units[0]!.steps.filter((step) => step.type === "model-call")
    assert.equal(calls.length, 5)
    assert.ok(calls.every((call) => call.state === "completed"))
    assert.deepEqual(calls[0]!.tokens, {
      input: 4103,
      output: 34,
      reasoning: 42,
      cacheRead: 4096,
      cacheWrite: 0,
    })
    assert.ok(calls.every((call) => call.endedAt! >= call.startedAt!))
  })

  it("attaches tool calls and their results to the model reply", () => {
    const reply = tree.units[0]!.steps[2]!.children[0]!
    assert.deepEqual(labels(reply.children), ["Tool: read"])
    const read = reply.children[0]!
    assert.equal(read.state, "completed")
    assert.deepEqual(labels(read.children), ["Result: read"])
    assert.match(read.children[0]!.content, /1: hello/)
  })

  it("grafts the sub-agent session under its launch node", () => {
    const launch = tree.units[0]!.steps[3]!.children[0]!.children[0]!
    assert.equal(launch.label, "Sub-agent: general")
    assert.equal(launch.content, "count words")
    assert.equal(launch.state, "completed")
    assert.deepEqual(
      launch.children.map((child) => child.type),
      ["user-request", "model-call", "model-call", "answer"],
    )
    assert.match(launch.children.at(-1)!.content, /1 word/)
  })
})

describe("V2SessionTracker", () => {
  it("starts a unit only once a queued prompt is delivered", () => {
    const [enqueued, delivered] = prompt("s1", "in1", "do it")
    const tracker = trackerWith([enqueued!])
    assert.equal(tracker.tree("s1").units.length, 0)
    tracker.dispatch(delivered!)
    assert.equal(tracker.tree("s1").units[0]!.request.content, "do it")
  })

  it("streams text deltas and lets the ended event replace them", () => {
    const step = { sessionID: "s1", assistantMessageID: "a1" }
    const tracker = trackerWith([
      ...prompt("s1", "in1", "hi"),
      ev("session.step.started", { ...step, started: 5 }),
      ev("session.text.delta", { ...step, ordinal: 0, delta: "Hel" }),
      ev("session.text.delta", { ...step, ordinal: 0, delta: "lo" }),
    ])
    const reply = () => tracker.tree("s1").units[0]!.steps[0]!.children[0]!
    assert.equal(reply().content, "Hello")
    tracker.dispatch(ev("session.text.ended", { ...step, ordinal: 0, text: "Hello!" }))
    assert.equal(reply().content, "Hello!")
  })

  it("keeps reasoning separate from the reply text", () => {
    const step = { sessionID: "s1", assistantMessageID: "a1" }
    const tree = trackerWith([
      ...prompt("s1", "in1", "hi"),
      ev("session.reasoning.ended", { ...step, ordinal: 0, text: "thinking" }),
      ev("session.text.ended", { ...step, ordinal: 1, text: "answer" }),
    ]).tree("s1")
    const reply = tree.units[0]!.steps[0]!.children[0]!
    assert.equal(reply.reasoning, "thinking")
    assert.equal(reply.content, "answer")
  })

  it("marks a failed tool with its error message", () => {
    const tool = { sessionID: "s1", assistantMessageID: "a1", id: "c1" }
    const tree = trackerWith([
      ...prompt("s1", "in1", "hi"),
      ev("session.tool.input.started", { ...tool, name: "shell" }),
      ev("session.tool.called", { ...tool, input: { command: "false" } }),
      ev("session.tool.failed", { ...tool, error: { type: "unknown", message: "exit 1" } }),
    ]).tree("s1")
    const call = tree.units[0]!.steps[0]!.children[0]!.children[0]!
    assert.equal(call.label, "Tool: shell")
    assert.equal(call.state, "failed")
    assert.equal(call.content, "exit 1")
  })

  it("marks a failed step and keeps it failed when the unit closes", () => {
    const step = { sessionID: "s1", assistantMessageID: "a1" }
    const tree = trackerWith([
      ...prompt("s1", "in1", "hi"),
      ev("session.step.started", { ...step, started: 1 }),
      ev("session.step.failed", { ...step, error: { message: "rate limited" }, tokens: usage }),
      ev("session.execution.failed", { sessionID: "s1" }),
    ]).tree("s1")
    const call = tree.units[0]!.steps[0]!
    assert.equal(call.state, "failed")
    assert.equal(call.content, "rate limited")
    assert.equal(call.tokens?.input, 10)
  })

  it("turns todowrite input into the unit plan, dropping cancelled items", () => {
    const tool = { sessionID: "s1", assistantMessageID: "a1", id: "c1" }
    const tree = trackerWith([
      ...prompt("s1", "in1", "hi"),
      ev("session.tool.input.started", { ...tool, name: "todowrite" }),
      ev("session.tool.called", {
        ...tool,
        input: {
          todos: [
            { content: "read", status: "completed" },
            { content: "write", status: "in_progress" },
            { content: "skip", status: "cancelled" },
          ],
        },
      }),
    ]).tree("s1")
    assert.deepEqual(
      tree.units[0]!.plan.map((item) => [item.title, item.state]),
      [
        ["read", "completed"],
        ["write", "in-progress"],
      ],
    )
  })

  it("ignores synthetic inbox items and events before any prompt", () => {
    const tree = trackerWith([
      ev("session.inbox.enqueued", {
        sessionID: "s1",
        inboxID: "in0",
        item: { type: "synthetic", payload: { text: "note" } },
      }),
      ev("session.inbox.delivered", { sessionID: "s1", inboxID: "in0" }),
      ev("session.step.started", { sessionID: "s1", assistantMessageID: "a1", started: 1 }),
    ]).tree("s1")
    assert.equal(tree.units.length, 0)
  })
})

describe("V2SessionTracker failure and sub-agent edge cases", () => {
  const step = { sessionID: "s1", assistantMessageID: "a1" }
  const tool = { ...step, id: "c1" }

  it("fails the unsettled steps of an interrupted execution", () => {
    const tree = trackerWith([
      ...prompt("s1", "in1", "hi"),
      ev("session.step.started", { ...step, started: 1 }),
      ev("session.tool.input.started", { ...tool, name: "shell" }),
      ev("session.tool.called", { ...tool, input: {} }),
      ev("session.execution.interrupted", { sessionID: "s1" }),
    ]).tree("s1")
    const call = tree.units[0]!.steps[0]!
    assert.equal(call.state, "failed")
    assert.equal(call.children[0]!.children[0]!.state, "failed")
  })

  it("forgets a cancelled prompt", () => {
    const [enqueued, delivered] = prompt("s1", "in1", "hi")
    const tree = trackerWith([
      enqueued!,
      ev("session.inbox.cancelled", { sessionID: "s1", inboxID: "in1" }),
      delivered!,
    ]).tree("s1")
    assert.equal(tree.units.length, 0)
  })

  it("keeps a background sub-agent running until its child session finishes", () => {
    const launch = { ...tool, id: "sub1" }
    const tracker = trackerWith([
      ...prompt("s1", "in1", "hi"),
      ev("session.tool.input.started", { ...launch, name: "subagent" }),
      ev("session.tool.called", { ...launch, input: { agent: "general", description: "bg", background: true } }),
      ev("session.created", { sessionID: "child", parentID: "s1" }, 2),
      ev("session.tool.success", {
        ...launch,
        content: [{ type: "text", text: "started" }],
        metadata: { sessionID: "child", status: "running" },
      }),
      ev("session.execution.succeeded", { sessionID: "s1" }),
    ])
    const node = () => tracker.tree("s1").units[0]!.steps[0]!.children[0]!.children[0]!
    assert.equal(node().state, "running")
    tracker.dispatch(ev("session.execution.succeeded", { sessionID: "child" }, 9))
    assert.equal(node().state, "completed")
    assert.equal(node().endedAt, 9)
  })

  it("continues the last unit when a synthetic wake-up is delivered", () => {
    const wake = { sessionID: "s1", inboxID: "in2" }
    const tree = trackerWith([
      ...prompt("s1", "in1", "hi"),
      ev("session.text.ended", { ...step, ordinal: 0, text: "waiting" }),
      ev("session.execution.succeeded", { sessionID: "s1" }),
      ev("session.inbox.enqueued", { ...wake, item: { type: "synthetic", payload: { text: "done" } } }),
      ev("session.inbox.delivered", wake),
      ev("session.text.ended", { sessionID: "s1", assistantMessageID: "a2", ordinal: 0, text: "all done" }),
      ev("session.execution.succeeded", { sessionID: "s1" }),
    ]).tree("s1")
    assert.equal(tree.units.length, 1)
    assert.deepEqual(
      tree.units[0]!.steps.map((s) => s.type),
      ["model-call", "model-call", "answer"],
    )
    assert.equal(tree.units[0]!.steps.at(-1)!.content, "all done")
  })

  it("does not treat a sub-agent follow-up as a new launch", () => {
    const tree = trackerWith([
      ...prompt("s1", "in1", "hi"),
      ev("session.tool.input.started", { ...tool, name: "subagent" }),
      ev("session.tool.called", { ...tool, input: { agent: "general", description: "more", sessionID: "child" } }),
    ]).tree("s1")
    const node = tree.units[0]!.steps[0]!.children[0]!.children[0]!
    assert.equal(node.label, "Sub-agent follow-up: general")
    assert.notEqual(node.subtask, true)
  })
})

describe("V2SessionTracker grafting by child session id", () => {
  const step = { sessionID: "s1", assistantMessageID: "a1" }

  /** A `subagent` call in `s1`, optionally reporting the child it drives. */
  function launch(id: string, agent: string, childSessionID?: string): V2Event[] {
    const call = { ...step, id }
    const events = [
      ev("session.tool.input.started", { ...call, name: "subagent" }),
      ev("session.tool.called", { ...call, input: { agent, description: agent } }),
    ]
    if (childSessionID) {
      events.push(ev("session.tool.progress", { ...call, metadata: { sessionID: childSessionID } }))
    }
    return events
  }

  function grafted(tree: ReturnType<V2SessionTracker["tree"]>): [string, string | undefined][] {
    return tree.units[0]!.steps[0]!.children[0]!.children.map((node) => [
      node.label,
      node.children[0]?.content,
    ])
  }

  it("grafts under the launch that names the child, whatever the creation order", () => {
    const tree = trackerWith([
      ...prompt("s1", "in1", "hi"),
      ...launch("c1", "first", "childA"),
      ...launch("c2", "second", "childB"),
      // Created out of order: positionally childB would land under "first".
      ev("session.created", { sessionID: "childB", parentID: "s1" }, 2),
      ev("session.created", { sessionID: "childA", parentID: "s1" }, 3),
      ...prompt("childA", "inA", "task A"),
      ...prompt("childB", "inB", "task B"),
    ]).tree("s1")
    assert.deepEqual(grafted(tree), [
      ["Sub-agent: first", "task A"],
      ["Sub-agent: second", "task B"],
    ])
  })

  it("grafts by id when session.created never arrived", () => {
    const tree = trackerWith([
      ...prompt("s1", "in1", "hi"),
      ...launch("c1", "first", "childA"),
      ...prompt("childA", "inA", "task A"),
    ]).tree("s1")
    assert.deepEqual(grafted(tree), [["Sub-agent: first", "task A"]])
  })

  it("falls back to creation order for launches whose child is not yet reported", () => {
    const tree = trackerWith([
      ...prompt("s1", "in1", "hi"),
      ...launch("c1", "first"),
      ...launch("c2", "second", "childA"),
      // childA is older but claimed by "second"; "first" takes the unclaimed childB.
      ev("session.created", { sessionID: "childA", parentID: "s1" }, 2),
      ev("session.created", { sessionID: "childB", parentID: "s1" }, 3),
      ...prompt("childA", "inA", "task A"),
      ...prompt("childB", "inB", "task B"),
    ]).tree("s1")
    assert.deepEqual(grafted(tree), [
      ["Sub-agent: first", "task B"],
      ["Sub-agent: second", "task A"],
    ])
  })

  it("does not graft a follow-up's child a second time", () => {
    const followUp = { ...step, id: "c2" }
    const tree = trackerWith([
      ...prompt("s1", "in1", "hi"),
      ...launch("c1", "first", "childA"),
      ev("session.tool.input.started", { ...followUp, name: "subagent" }),
      ev("session.tool.called", { ...followUp, input: { agent: "first", description: "more", sessionID: "childA" } }),
      ev("session.tool.progress", { ...followUp, metadata: { sessionID: "childA" } }),
      ...prompt("childA", "inA", "task A"),
    ]).tree("s1")
    assert.deepEqual(grafted(tree), [
      ["Sub-agent: first", "task A"],
      ["Sub-agent follow-up: first", undefined],
    ])
  })

  it("collapses launches beyond the third without shifting positional grafts", () => {
    const tree = trackerWith([
      ...prompt("s1", "in1", "hi"),
      ...launch("c1", "a", "childA"),
      ...launch("c2", "b", "childB"),
      ...launch("c3", "c", "childC"),
      ...launch("c4", "d", "childD"),
      ...launch("c5", "e"),
      ev("session.created", { sessionID: "childE", parentID: "s1" }, 2),
      ...["A", "B", "C", "D", "E"].flatMap((name) => prompt(`child${name}`, `in${name}`, `task ${name}`)),
    ]).tree("s1")
    assert.deepEqual(grafted(tree), [
      ["Sub-agent: a", "task A"],
      ["Sub-agent: b", "task B"],
      ["Sub-agent: c", "task C"],
    ])
    const summary = tree.units[0]!.steps.at(-1)!
    assert.equal(summary.type, "subtask-summary")
    assert.equal(summary.content, "d, e")
  })

  it("does not recurse when a reported child id points back up the chain", () => {
    const tree = trackerWith([...prompt("s1", "in1", "hi"), ...launch("c1", "loop", "s1")]).tree("s1")
    assert.deepEqual(grafted(tree), [["Sub-agent: loop", undefined]])
  })
})
