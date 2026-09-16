import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { detectAgent } from "./detect.ts"

describe("detectAgent", () => {
  it("detects Claude transcripts", () => {
    assert.equal(
      detectAgent([JSON.stringify({ type: "user", message: { role: "user", content: "hi" } })]),
      "claude",
    )
  })

  it("detects Pi persistence files", () => {
    assert.equal(
      detectAgent([
        JSON.stringify({ type: "session", id: "s1" }),
        JSON.stringify({ type: "message", message: { role: "user", content: [] } }),
      ]),
      "pi",
    )
    assert.equal(
      detectAgent([
        JSON.stringify({ type: "message", message: { role: "user", content: [] } }),
        JSON.stringify({ type: "custom", customType: "session_exit", data: {} }),
      ]),
      "pi",
    )
  })

  it("returns undefined for empty or unknown input", () => {
    assert.equal(detectAgent([]), undefined)
    assert.equal(detectAgent(["", "   "]), undefined)
    assert.equal(detectAgent([JSON.stringify({ type: "weird" })]), undefined)
  })
})
