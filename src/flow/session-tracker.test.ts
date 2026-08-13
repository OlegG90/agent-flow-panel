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
    assert.equal(tracker.tree().sessionID, "b")
    tracker.setActiveSession("a")
    assert.equal(tracker.tree().sessionID, "a")
  })

  it("returns an empty tree for unknown sessions", () => {
    const tracker = new SessionTracker()
    assert.equal(tracker.tree().units.length, 0)
    assert.equal(tracker.tree("nope").units.length, 0)
  })
})
