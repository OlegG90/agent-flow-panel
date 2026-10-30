import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import type { StepNode } from "../../flow/types.ts"
import type { V2Event } from "./v2-reducer.ts"
import { SessionTrackerV2 } from "./v2-session-tracker.ts"

const PARENT = "ses_e7364762bffeeGglkQc3NKwqaT"

/** A real OpenCode 2.2.3 run: read a file, launch one `general` sub-agent, answer. */
function recordedRun(): V2Event[] {
  const url = new URL("./fixtures/v2-subagent-run.json", import.meta.url)
  return JSON.parse(readFileSync(url, "utf8")) as V2Event[]
}

function trackerWith(events: V2Event[]): SessionTrackerV2 {
  const tracker = new SessionTrackerV2()
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

describe("SessionTrackerV2 on a recorded OpenCode 2.2.3 run", () => {
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

describe("SessionTrackerV2", () => {
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
