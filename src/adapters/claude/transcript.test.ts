import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { reduceTranscript } from "./transcript.ts"
import type { StepNode } from "../../flow/types.ts"

/**
 * Records are hand-built to the shapes read off real Claude Code transcripts.
 * The real files are private session logs and are never committed.
 */
const T = (seconds: number): string => new Date(Date.UTC(2026, 0, 1, 0, 0, seconds)).toISOString()

function prompt(uuid: string, text: string, at: string): string {
  return JSON.stringify({ type: "user", uuid, timestamp: at, message: { role: "user", content: text } })
}

function assistant(
  uuid: string,
  requestId: string,
  at: string,
  content: unknown[],
  usage?: Record<string, unknown>,
): string {
  return JSON.stringify({
    type: "assistant",
    uuid,
    requestId,
    timestamp: at,
    message: { role: "assistant", model: "claude-opus-5", content, ...(usage ? { usage } : {}) },
  })
}

function toolResult(uuid: string, at: string, id: string, text: string, isError = false): string {
  return JSON.stringify({
    type: "user",
    uuid,
    timestamp: at,
    toolUseResult: { stdout: text, stderr: "" },
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: text, is_error: isError }] },
  })
}

const USAGE = {
  input_tokens: 12,
  output_tokens: 340,
  cache_read_input_tokens: 41133,
  cache_creation_input_tokens: 14277,
  output_tokens_details: { thinking_tokens: 64 },
}

function flat(nodes: StepNode[]): StepNode[] {
  return nodes.flatMap((n) => [n, ...flat(n.children)])
}

describe("reduceTranscript", () => {
  const lines = [
    prompt("u1", "list the files", T(0)),
    assistant(
      "a1",
      "req-1",
      T(3),
      [
        { type: "thinking", thinking: "The user wants a listing." },
        { type: "text", text: "Listing them now." },
        { type: "tool_use", id: "tu-1", name: "Bash", input: { command: "ls -la" } },
      ],
      USAGE,
    ),
    toolResult("r1", T(5), "tu-1", "a.txt b.txt"),
    assistant("a2", "req-2", T(8), [{ type: "text", text: "Two files: a.txt and b.txt." }], USAGE),
  ]

  it("opens a unit per human prompt and closes it with an answer", () => {
    const tree = reduceTranscript(lines)
    assert.equal(tree.units.length, 1)
    const unit = tree.units[0]!
    assert.equal(unit.request.content, "list the files")
    const answer = unit.steps.find((s) => s.type === "answer")
    assert.equal(answer?.content, "Two files: a.txt and b.txt.")
  })

  it("groups assistant records into one model call per requestId", () => {
    const tree = reduceTranscript([
      ...lines,
      // A second record continuing the same request must not open a new call.
      assistant("a3", "req-2", T(9), [{ type: "text", text: " Done." }], USAGE),
    ])
    const calls = tree.units[0]!.steps.filter((s) => s.type === "model-call")
    assert.equal(calls.length, 2)
    assert.equal(calls[1]!.children[0]!.content, "Two files: a.txt and b.txt. Done.")
  })

  it("splits thinking from text", () => {
    const reply = reduceTranscript(lines).units[0]!.steps[0]!.children[0]!
    assert.equal(reply.content, "Listing them now.")
    assert.equal(reply.reasoning, "The user wants a listing.")
  })

  it("builds the tool label from the tool's own input", () => {
    const tool = flat(reduceTranscript(lines).units[0]!.steps).find((n) => n.type === "tool-call")
    assert.equal(tool?.label, "Tool: Bash · ls -la")
  })

  it("resolves a tool result and nests it under the call", () => {
    const tool = flat(reduceTranscript(lines).units[0]!.steps).find((n) => n.type === "tool-call")!
    assert.equal(tool.state, "completed")
    assert.equal(tool.content, "a.txt b.txt")
    assert.equal(tool.children[0]?.type, "tool-result")
  })

  it("marks a failed tool without adding a result node", () => {
    const failing = [
      prompt("u1", "break it", T(0)),
      assistant("a1", "req-1", T(1), [
        { type: "tool_use", id: "tu-x", name: "Bash", input: { command: "false" } },
      ]),
      toolResult("r1", T(2), "tu-x", "command failed", true),
    ]
    const tool = flat(reduceTranscript(failing).units[0]!.steps).find((n) => n.type === "tool-call")!
    assert.equal(tool.state, "failed")
    assert.equal(tool.content, "command failed")
    assert.equal(tool.children.length, 0)
  })

  it("carries token usage including nested thinking tokens", () => {
    const call = reduceTranscript(lines).units[0]!.steps[0]!
    assert.deepEqual(call.tokens, {
      input: 12,
      output: 340,
      reasoning: 64,
      cacheRead: 41133,
      cacheWrite: 14277,
    })
    assert.equal(call.cost, undefined, "Claude Code reports tokens but not cost")
  })

  it("times a model call from the previous record, not from its own line", () => {
    const call = reduceTranscript(lines).units[0]!.steps[0]!
    // Prompt at 0s, assistant line written at 3s → the call took 3s, not 0.
    assert.equal(call.endedAt! - call.startedAt!, 3000)
  })

  it("reads the plan from a TodoWrite call", () => {
    const withPlan = [
      prompt("u1", "do the thing", T(0)),
      assistant("a1", "req-1", T(1), [
        {
          type: "tool_use",
          id: "tu-t",
          name: "TodoWrite",
          input: {
            todos: [
              { content: "First", status: "completed" },
              { content: "Second", status: "in_progress" },
              { content: "Third", status: "pending" },
            ],
          },
        },
      ]),
    ]
    const plan = reduceTranscript(withPlan).units[0]!.plan
    assert.deepEqual(
      plan.map((p) => [p.title, p.state]),
      [
        ["First", "completed"],
        ["Second", "in-progress"],
        ["Third", "pending"],
      ],
    )
  })

  it("treats a tool result as continuation, never as a new unit", () => {
    assert.equal(reduceTranscript(lines).units.length, 1)
  })

  it("ignores control records and malformed lines", () => {
    const noisy = [
      "",
      "{not json",
      JSON.stringify({ type: "ai-title", aiTitle: "whatever" }),
      ...lines,
      JSON.stringify({ type: "queue-operation", operation: "x" }),
    ]
    const tree = reduceTranscript(noisy)
    assert.equal(tree.units.length, 1)
    assert.equal(tree.units[0]!.steps.filter((s) => s.type === "model-call").length, 2)
  })

  it("keeps the session id it was given", () => {
    assert.equal(reduceTranscript(lines, "sess-7").sessionID, "sess-7")
  })
})

describe("reduceTranscript sub-agents", () => {
  // NOTE: this path is modelled on the transcript's own fields but was never
  // seen in a real sample — no available transcript contained a sidechain.
  const lines = [
    prompt("u1", "research it", T(0)),
    assistant("a1", "req-1", T(2), [
      { type: "tool_use", id: "tu-task", name: "Task", input: { description: "dig into pricing" } },
    ]),
    JSON.stringify({
      type: "user",
      uuid: "s1",
      parentUuid: "a1",
      isSidechain: true,
      timestamp: T(3),
      message: { role: "user", content: "Research pricing, facts only" },
    }),
    JSON.stringify({
      type: "assistant",
      uuid: "s2",
      parentUuid: "s1",
      isSidechain: true,
      requestId: "req-sub",
      timestamp: T(6),
      message: { role: "assistant", content: [{ type: "text", text: "Found the rates." }] },
    }),
    toolResult("r1", T(9), "tu-task", "sub-agent finished"),
  ]

  it("marks the Task call as a sub-agent launch", () => {
    const launch = flat(reduceTranscript(lines).units[0]!.steps).find((n) => n.subtask)
    assert.ok(launch, "a Task tool_use becomes a subtask node")
    assert.equal(launch!.label, "Tool: Task · dig into pricing")
  })

  it("grafts the sub-agent's own work under the launch node", () => {
    const launch = flat(reduceTranscript(lines).units[0]!.steps).find((n) => n.subtask)!
    const nested = flat(launch.children)
    assert.ok(
      nested.some((n) => n.type === "user-request" && n.content === "Research pricing, facts only"),
      "the sub-agent brief hangs under its launch node",
    )
    assert.ok(
      nested.some((n) => n.content === "Found the rates."),
      "so does the sub-agent's reply",
    )
  })

  it("keeps sub-agent steps out of the parent unit's top level", () => {
    const unit = reduceTranscript(lines).units[0]!
    const topLevelReplies = unit.steps
      .filter((s) => s.type === "model-call")
      .flatMap((s) => s.children)
      .map((c) => c.content)
    assert.ok(!topLevelReplies.includes("Found the rates."))
  })
})
