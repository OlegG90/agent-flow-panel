import { describe, it } from "node:test"
import assert from "node:assert/strict"
import type { Event, Message, Part } from "@opencode-ai/sdk"
import { SessionTracker } from "./session-tracker.ts"

function userMessage(sessionID: string, id: string): Message {
  return {
    id,
    sessionID,
    role: "user",
    time: { created: 1 },
    agent: "build",
    model: { providerID: "opencode", modelID: "x" },
  } as Message
}

function assistantMessage(sessionID: string, id: string): Message {
  return {
    id,
    sessionID,
    role: "assistant",
    time: { created: 1, completed: 2 },
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

function part(sessionID: string, id: string, messageID: string, body: object): Part {
  return { id, sessionID, messageID, ...body } as Part
}

function partUpdated(value: Part): Event {
  return { type: "message.part.updated", properties: { part: value } } as Event
}

function idle(sessionID: string): Event {
  return { type: "session.idle", properties: { sessionID } } as Event
}

function created(sessionID: string, parentID?: string, time = 1): Event {
  return {
    type: "session.created",
    properties: {
      info: {
        id: sessionID,
        parentID,
        projectID: "p",
        directory: "/d",
        title: "t",
        version: "1",
        time: { created: time, updated: time },
      },
    },
  } as Event
}

function subtask(sessionID: string, id: string, messageID: string, agent: string): Event {
  return partUpdated(
    part(sessionID, id, messageID, { type: "subtask", prompt: "do it", description: "Desc", agent }),
  )
}

function parentWithLaunch(sessionID: string, messageID: string, completeTool = true): Event[] {
  return [
    updated(userMessage(sessionID, "m1")),
    partUpdated(part(sessionID, "p1", "m1", { type: "text", text: "delegate" })),
    updated(assistantMessage(sessionID, messageID)),
    partUpdated(part(sessionID, "p2", messageID, { type: "step-start" })),
    subtask(sessionID, "p3", messageID, "explore"),
    partUpdated(
      part(sessionID, "p3t", messageID, {
        type: "tool",
        callID: `c-${messageID}`,
        tool: "task",
        state: completeTool
          ? { status: "completed", input: {}, output: "done", title: "task", metadata: {}, time: { start: 1, end: 2 } }
          : { status: "running", input: {}, time: { start: 1 } },
      }),
    ),
    partUpdated(
      part(sessionID, "p4", messageID, { type: "step-finish", reason: "done", cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } }),
    ),
  ]
}

function childSession(sessionID: string, request: string): Event[] {
  return [
    updated(userMessage(sessionID, "bm1")),
    partUpdated(part(sessionID, "bp1", "bm1", { type: "text", text: request })),
    updated(assistantMessage(sessionID, "bm2")),
    partUpdated(part(sessionID, "bp2", "bm2", { type: "step-start" })),
    partUpdated(part(sessionID, "bp3", "bm2", { type: "text", text: "found it" })),
    partUpdated(
      part(sessionID, "bp4", "bm2", { type: "step-finish", reason: "done", cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } }),
    ),
  ]
}

function parentWithManyLaunches(sessionID: string, count: number, completeTools = true): Event[] {
  const events: Event[] = [
    updated(userMessage(sessionID, "m1")),
    partUpdated(part(sessionID, "p1", "m1", { type: "text", text: "delegate a lot" })),
  ]
  for (let i = 0; i < count; i++) {
    const messageID = `m${i + 2}`
    events.push(updated(assistantMessage(sessionID, messageID)))
    events.push(partUpdated(part(sessionID, `ps${i}`, messageID, { type: "step-start" })))
    events.push(subtask(sessionID, `pt${i}`, messageID, `agent${i + 1}`))
    events.push(
      partUpdated(
        part(sessionID, `ptool${i}`, messageID, {
          type: "tool",
          callID: `c${i}`,
          tool: "task",
          state: completeTools
            ? { status: "completed", input: {}, output: "done", title: "task", metadata: {}, time: { start: 1, end: 2 } }
            : { status: "running", input: {}, time: { start: 1 } },
        }),
      ),
    )
    events.push(
      partUpdated(
        part(sessionID, `pf${i}`, messageID, { type: "step-finish", reason: "done", cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } }),
      ),
    )
  }
  return events
}

function simpleSession(sessionID: string): Event[] {
  return [
    updated(userMessage(sessionID, "m1")),
    partUpdated(part(sessionID, "p1", "m1", { type: "text", text: "Hello" })),
    updated(assistantMessage(sessionID, "m2")),
    partUpdated(part(sessionID, "p2", "m2", { type: "step-start" })),
    partUpdated(part(sessionID, "p3", "m2", { type: "text", text: "Hi there!" })),
    partUpdated(part(sessionID, "p4", "m2", { type: "step-finish", reason: "done", cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } })),
    idle(sessionID),
  ]
}

describe("SessionTracker", () => {
  it("builds a Unit of Work from events", () => {
    const tracker = new SessionTracker()
    tracker.setActiveSession("s1")
    for (const event of simpleSession("s1")) {
      tracker.dispatch(event)
    }

    const tree = tracker.tree()
    assert.equal(tree.sessionID, "s1")
    assert.equal(tree.units.length, 1)
    assert.equal(tree.units[0]!.request.content, "Hello")
    assert.equal(tree.units[0]!.steps[1]!.type, "answer")
  })

  it("fires onUpdate after each dispatched event", () => {
    const tracker = new SessionTracker()
    let calls = 0
    tracker.onUpdate(() => calls++)

    const events = simpleSession("s1")
    for (const event of events) {
      tracker.dispatch(event)
    }
    assert.equal(calls, events.length)
  })

  it("tracks sessions independently and routes per-session trees", () => {
    const tracker = new SessionTracker()
    for (const event of simpleSession("a")) {
      tracker.dispatch(event)
    }
    for (const event of simpleSession("b")) {
      tracker.dispatch(event)
    }

    assert.equal(tracker.tree("a").sessionID, "a")
    assert.equal(tracker.tree("a").units[0]!.request.content, "Hello")
    assert.equal(tracker.tree("b").sessionID, "b")
    assert.equal(tracker.tree("b").units[0]!.request.content, "Hello")
  })

  it("setActiveSession selects which session tree() returns", () => {
    const tracker = new SessionTracker()
    for (const event of simpleSession("a")) {
      tracker.dispatch(event)
    }
    tracker.setActiveSession("a")
    assert.equal(tracker.tree().sessionID, "a")

    for (const event of simpleSession("b")) {
      tracker.dispatch(event)
    }
    assert.equal(tracker.tree().sessionID, "a")
    tracker.setActiveSession("b")
    assert.equal(tracker.tree().sessionID, "b")
  })

  it("keeps the active session pinned when child-session events arrive", () => {
    const tracker = new SessionTracker()
    for (const event of parentWithLaunch("a", "m2")) {
      tracker.dispatch(event)
    }
    tracker.dispatch(created("b", "a"))
    tracker.setActiveSession("a")

    for (const event of childSession("b", "research this")) {
      tracker.dispatch(event)
    }
    tracker.dispatch(idle("b"))

    assert.equal(tracker.tree().sessionID, "a")
    const unit = tracker.tree().units[0]!
    const launch = unit.steps[0]!.children[0]!.children[0]!
    assert.equal(launch.children[0]!.content, "research this")
  })

  it("returns an empty tree for unknown sessions", () => {
    const tracker = new SessionTracker()
    assert.equal(tracker.tree().units.length, 0)
    assert.equal(tracker.tree("nope").units.length, 0)
  })

  it("reset clears accumulated state so the panel starts from now", () => {
    const tracker = new SessionTracker()
    for (const event of simpleSession("s1")) {
      tracker.dispatch(event)
    }
    assert.equal(tracker.tree("s1").units.length, 1)

    tracker.reset()

    assert.equal(tracker.tree().units.length, 0)
    assert.equal(tracker.tree("s1").units.length, 0)

    for (const event of simpleSession("s1")) {
      tracker.dispatch(event)
    }
    assert.equal(tracker.tree("s1").units.length, 1)
  })

  it("grafts a child session's tree under its launch node", () => {
    const tracker = new SessionTracker()
    for (const event of parentWithLaunch("a", "m2")) {
      tracker.dispatch(event)
    }
    tracker.dispatch(created("b", "a"))
    for (const event of childSession("b", "research this")) {
      tracker.dispatch(event)
    }
    tracker.dispatch(idle("b"))

    const unit = tracker.tree("a").units[0]!
    const modelReply = unit.steps[0]!.children[0]!
    const launch = modelReply.children[0]!
    assert.equal(launch.subtask, true)
    assert.equal(launch.label, "Sub-agent: explore")
    assert.equal(launch.state, "completed")
    assert.equal(launch.children[0]!.type, "user-request")
    assert.equal(launch.children[0]!.content, "research this")
    assert.equal(launch.children[1]!.type, "model-call")
  })

  it("matches two sub-agents to their children in creation order", () => {
    const tracker = new SessionTracker()
    for (const event of parentWithLaunch("a", "m2")) {
      tracker.dispatch(event)
    }
    // second launch in a new turn
    tracker.dispatch(updated(assistantMessage("a", "m3")))
    tracker.dispatch(partUpdated(part("a", "p5", "m3", { type: "step-start" })))
    tracker.dispatch(subtask("a", "p6", "m3", "plan"))
    tracker.dispatch(partUpdated(part("a", "p7", "m3", { type: "step-finish", reason: "done", cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } })))

    tracker.dispatch(created("b", "a"))
    tracker.dispatch(created("c", "a"))
    for (const event of childSession("b", "research this")) {
      tracker.dispatch(event)
    }
    for (const event of childSession("c", "plan that")) {
      tracker.dispatch(event)
    }

    const unit = tracker.tree("a").units[0]!
    const firstLaunch = unit.steps[0]!.children[0]!.children[0]!
    const secondLaunch = unit.steps[1]!.children[0]!.children[0]!
    assert.equal(firstLaunch.label, "Sub-agent: explore")
    assert.equal(firstLaunch.children[0]!.content, "research this")
    assert.equal(secondLaunch.label, "Sub-agent: plan")
    assert.equal(secondLaunch.children[0]!.content, "plan that")
  })

  it("does not complete a launch node on the child's transient idle", () => {
    const tracker = new SessionTracker()
    for (const event of parentWithLaunch("a", "m2", false)) {
      tracker.dispatch(event)
    }
    tracker.dispatch(created("b", "a"))
    for (const event of childSession("b", "research this")) {
      tracker.dispatch(event)
    }
    tracker.dispatch(idle("b"))

    const unit = tracker.tree("a").units[0]!
    const launch = unit.steps[0]!.children[0]!.children[0]!
    assert.equal(launch.state, "running")
  })

  it("expands nested sub-agents recursively", () => {
    const tracker = new SessionTracker()
    for (const event of parentWithLaunch("a", "m2")) {
      tracker.dispatch(event)
    }
    tracker.dispatch(created("b", "a"))
    for (const event of childSession("b", "research this")) {
      tracker.dispatch(event)
    }
    // b launches c
    tracker.dispatch(updated(assistantMessage("b", "bm3")))
    tracker.dispatch(partUpdated(part("b", "bp5", "bm3", { type: "step-start" })))
    tracker.dispatch(subtask("b", "bp6", "bm3", "deep"))
    tracker.dispatch(partUpdated(part("b", "bp7", "bm3", { type: "step-finish", reason: "done", cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } })))
    tracker.dispatch(created("c", "b"))
    for (const event of childSession("c", "dig deeper")) {
      tracker.dispatch(event)
    }

    const unit = tracker.tree("a").units[0]!
    const launchB = unit.steps[0]!.children[0]!.children[0]!
    // b's second model call carries its own launch node
    const modelCallB = launchB.children[2]!
    const replyB = modelCallB.children[0]!
    const launchC = replyB.children[0]!
    assert.equal(launchC.subtask, true)
    assert.equal(launchC.label, "Sub-agent: deep")
    assert.equal(launchC.children[0]!.content, "dig deeper")
  })

  it("drops the child's plan under the launch node (flat shape)", () => {
    const tracker = new SessionTracker()
    for (const event of parentWithLaunch("a", "m2")) {
      tracker.dispatch(event)
    }
    tracker.dispatch(created("b", "a"))
    for (const event of childSession("b", "research this")) {
      tracker.dispatch(event)
    }
    tracker.dispatch({ type: "todo.updated", properties: { sessionID: "b", todos: [{ id: "t1", content: "Step", status: "pending", priority: "low" }] } } as Event)

    const unit = tracker.tree("a").units[0]!
    const launch = unit.steps[0]!.children[0]!.children[0]!
    assert.equal(launch.children.length, 2)
    assert.equal(launch.children[0]!.type, "user-request")
    assert.equal(launch.children[1]!.type, "model-call")
  })

  it("orders children by creation time, not arrival order", () => {
    const tracker = new SessionTracker()
    for (const event of parentWithLaunch("a", "m2")) {
      tracker.dispatch(event)
    }
    tracker.dispatch(updated(assistantMessage("a", "m3")))
    tracker.dispatch(partUpdated(part("a", "p5", "m3", { type: "step-start" })))
    tracker.dispatch(subtask("a", "p6", "m3", "plan"))
    tracker.dispatch(partUpdated(part("a", "p7", "m3", { type: "step-finish", reason: "done", cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } })))

    tracker.dispatch(created("b", "a", 5))
    tracker.dispatch(created("c", "a", 2))
    for (const event of childSession("c", "first child")) {
      tracker.dispatch(event)
    }
    for (const event of childSession("b", "second child")) {
      tracker.dispatch(event)
    }

    const unit = tracker.tree("a").units[0]!
    const firstLaunch = unit.steps[0]!.children[0]!.children[0]!
    const secondLaunch = unit.steps[1]!.children[0]!.children[0]!
    assert.equal(firstLaunch.children[0]!.content, "first child")
    assert.equal(secondLaunch.children[0]!.content, "second child")
  })

  it("summarizes sub-agents beyond the third in one block", () => {
    const tracker = new SessionTracker()
    for (const event of parentWithManyLaunches("a", 5)) {
      tracker.dispatch(event)
    }
    for (let i = 0; i < 5; i++) {
      tracker.dispatch(created(`c${i + 1}`, "a", i + 1))
      for (const event of childSession(`c${i + 1}`, `child ${i + 1}`)) {
        tracker.dispatch(event)
      }
      tracker.dispatch(idle(`c${i + 1}`))
    }

    const unit = tracker.tree("a").units[0]!
    assert.equal(unit.steps.length, 6)
    for (let i = 0; i < 3; i++) {
      const launch = unit.steps[i]!.children[0]!.children[0]!
      assert.equal(launch.subtask, true)
      assert.equal(launch.children[0]!.content, `child ${i + 1}`)
    }
    const summary = unit.steps[5]!
    assert.equal(summary.type, "subtask-summary")
    assert.equal(summary.label, "2 more sub-agents")
    assert.ok(summary.content.includes("agent4"))
    assert.ok(summary.content.includes("agent5"))
    assert.equal(summary.state, "completed")
    assert.equal(unit.steps[3]!.children[0]!.children.length, 0)
    assert.equal(unit.steps[4]!.children[0]!.children.length, 0)
  })

  it("shows the summary running while a collapsed child's tool still runs", () => {
    const tracker = new SessionTracker()
    for (const event of parentWithManyLaunches("a", 4, false)) {
      tracker.dispatch(event)
    }
    for (let i = 0; i < 4; i++) {
      tracker.dispatch(created(`c${i + 1}`, "a", i + 1))
      for (const event of childSession(`c${i + 1}`, `child ${i + 1}`)) {
        tracker.dispatch(event)
      }
    }

    const unit = tracker.tree("a").units[0]!
    const summary = unit.steps[4]!
    assert.equal(summary.type, "subtask-summary")
    assert.equal(summary.label, "1 more sub-agent")
    assert.equal(summary.state, "running")

    tracker.dispatch(
      partUpdated(
        part("a", "px", "m5", {
          type: "tool",
          callID: "c3",
          tool: "task",
          state: { status: "completed", input: {}, output: "done", title: "task", metadata: {}, time: { start: 1, end: 2 } },
        }),
      ),
    )
    assert.equal(tracker.tree("a").units[0]!.steps[4]!.state, "completed")
  })
})
