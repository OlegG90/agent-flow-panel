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
  // Shapes verified by actually running a sub-agent and reading the file back:
  // the transcript gains the launch and its result, and nothing in between.
  const AGENT_RESULT = {
    status: "completed",
    agentType: "general-purpose",
    resolvedModel: "claude-opus-5",
    totalDurationMs: 85466,
    totalToolUseCount: 9,
    usage: {
      input_tokens: 2,
      output_tokens: 816,
      cache_read_input_tokens: 44648,
      cache_creation_input_tokens: 344,
      output_tokens_details: { thinking_tokens: 0 },
    },
  }

  const lines = [
    prompt("u1", "merge the branch", T(0)),
    assistant("a1", "req-1", T(2), [
      {
        type: "tool_use",
        id: "tu-agent",
        name: "Agent",
        input: { subagent_type: "general-purpose", description: "Merge branch", prompt: "Merge it." },
      },
    ]),
    JSON.stringify({
      type: "user",
      uuid: "r1",
      timestamp: T(88),
      sourceToolAssistantUUID: "a1",
      toolUseResult: AGENT_RESULT,
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "tu-agent", content: "Merge complete." }],
      },
    }),
  ]

  it("marks an Agent call as a sub-agent launch", () => {
    // Claude Code 2.x names the tool `Agent`; matching only `Task` rendered it
    // as an ordinary tool with no sub-agent marker.
    const launch = flat(reduceTranscript(lines).units[0]!.steps).find((n) => n.subtask)
    assert.ok(launch, "the Agent tool becomes a subtask node")
    assert.equal(launch!.label, "Sub-agent: general-purpose")
  })

  it("still recognises the older Task name", () => {
    const older = [
      prompt("u1", "go", T(0)),
      assistant("a1", "req-1", T(1), [
        { type: "tool_use", id: "tu-t", name: "Task", input: { description: "dig" } },
      ]),
    ]
    const launch = flat(reduceTranscript(older).units[0]!.steps).find((n) => n.subtask)
    assert.equal(launch?.label, "Sub-agent: dig")
  })

  it("shows the sub-agent's own duration and tokens, not the gap between lines", () => {
    const launch = flat(reduceTranscript(lines).units[0]!.steps).find((n) => n.subtask)!
    assert.equal(launch.endedAt! - launch.startedAt!, 85466)
    assert.deepEqual(launch.tokens, {
      input: 2,
      output: 816,
      reasoning: 0,
      cacheRead: 44648,
      cacheWrite: 344,
    })
  })

  it("summarizes the run the transcript does not contain", () => {
    const launch = flat(reduceTranscript(lines).units[0]!.steps).find((n) => n.subtask)!
    assert.equal(launch.children.length, 1)
    assert.equal(launch.children[0]!.label, "claude-opus-5 · 9 tool calls")
    assert.equal(launch.content, "Merge complete.")
  })

  it("adds no tool-result child under a launch node", () => {
    const launch = flat(reduceTranscript(lines).units[0]!.steps).find((n) => n.subtask)!
    assert.ok(!launch.children.some((c) => c.type === "tool-result"))
  })
})
