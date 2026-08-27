import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { VERSION } from "./version.ts"

describe("VERSION", () => {
  it("matches the package version shown in the panel title", () => {
    const manifest = JSON.parse(
      readFileSync(join(import.meta.dirname, "..", "package.json"), "utf8"),
    ) as { version: string }
    assert.equal(VERSION, manifest.version)
  })
})
