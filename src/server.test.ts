import { describe, it } from "node:test"
import assert from "node:assert/strict"
import module from "./server.ts"

describe("plugin module", () => {
  it("exports a server plugin with the flow-panel id", () => {
    assert.equal(module.id, "flow-panel")
    assert.equal(typeof module.server, "function")
  })
})
