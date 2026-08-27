import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  createTranscriptSource,
  encodeProjectDir,
  findActiveTranscript,
  listTranscripts,
} from "./session-source.ts"

const CWD = "C:\\Workspace\\Sandbox\\Projects\\Opencode_Plg"

function sandbox(): { home: string; dir: string; cleanup: () => void } {
  const home = mkdtempSync(join(tmpdir(), "flow-claude-"))
  const dir = join(home, ".claude", "projects", encodeProjectDir(CWD))
  mkdirSync(dir, { recursive: true })
  return { home, dir, cleanup: () => rmSync(home, { recursive: true, force: true }) }
}

function writeTranscript(dir: string, id: string, prompt: string, mtimeSeconds: number): void {
  const path = join(dir, `${id}.jsonl`)
  writeFileSync(
    path,
    [
      JSON.stringify({
        type: "user",
        uuid: "u1",
        timestamp: "2026-01-01T00:00:00.000Z",
        message: { role: "user", content: prompt },
      }),
      JSON.stringify({
        type: "assistant",
        uuid: "a1",
        requestId: "r1",
        timestamp: "2026-01-01T00:00:02.000Z",
        message: { role: "assistant", content: [{ type: "text", text: "done" }] },
      }),
    ].join("\n"),
  )
  utimesSync(path, mtimeSeconds, mtimeSeconds)
}

describe("encodeProjectDir", () => {
  it("replaces every character outside [a-zA-Z0-9-] with a dash", () => {
    // Verified against every project directory in a real ~/.claude/projects.
    assert.equal(encodeProjectDir(CWD), "C--Workspace-Sandbox-Projects-Opencode-Plg")
    assert.equal(encodeProjectDir("C:\\Users\\OlegG"), "C--Users-OlegG")
    assert.equal(encodeProjectDir("/home/me/proj_x"), "-home-me-proj-x")
  })
})

describe("transcript discovery", () => {
  it("lists this directory's transcripts newest first", (t) => {
    const box = sandbox()
    t.after(box.cleanup)
    writeTranscript(box.dir, "old", "first", 1_000)
    writeTranscript(box.dir, "new", "second", 2_000)

    const refs = listTranscripts({ cwd: CWD, home: box.home })
    assert.deepEqual(
      refs.map((r) => r.sessionID),
      ["new", "old"],
    )
  })

  it("picks the most recently written transcript as the active one", (t) => {
    const box = sandbox()
    t.after(box.cleanup)
    writeTranscript(box.dir, "old", "first", 1_000)
    writeTranscript(box.dir, "new", "second", 2_000)

    assert.equal(findActiveTranscript({ cwd: CWD, home: box.home })?.sessionID, "new")
  })

  it("ignores non-transcript files", (t) => {
    const box = sandbox()
    t.after(box.cleanup)
    writeTranscript(box.dir, "s1", "hello", 1_000)
    writeFileSync(join(box.dir, "notes.md"), "not a transcript")
    mkdirSync(join(box.dir, "memory"), { recursive: true })

    assert.equal(listTranscripts({ cwd: CWD, home: box.home }).length, 1)
  })

  it("returns nothing when the project has no transcript directory", () => {
    const refs = listTranscripts({ cwd: "C:\\nope\\missing", home: join(tmpdir(), "flow-absent") })
    assert.deepEqual(refs, [])
  })
})

describe("createTranscriptSource", () => {
  it("reduces the active transcript into a tree", (t) => {
    const box = sandbox()
    t.after(box.cleanup)
    writeTranscript(box.dir, "s1", "list the files", 1_000)

    const source = createTranscriptSource({ cwd: CWD, home: box.home })
    t.after(() => source.close())
    const tree = source.tree()
    assert.equal(tree.sessionID, "s1")
    assert.equal(tree.units[0]?.request.content, "list the files")
  })

  it("serves an empty flow when there is no transcript at all", (t) => {
    const box = sandbox()
    t.after(box.cleanup)

    const source = createTranscriptSource({ cwd: CWD, home: box.home })
    t.after(() => source.close())
    assert.deepEqual(source.tree(), { sessionID: "", units: [] })
  })

  it("re-reads after the transcript changes and caches until it does", (t) => {
    const box = sandbox()
    t.after(box.cleanup)
    writeTranscript(box.dir, "s1", "first prompt", 1_000)

    const source = createTranscriptSource({ cwd: CWD, home: box.home })
    t.after(() => source.close())
    assert.equal(source.tree().units[0]?.request.content, "first prompt")
    assert.equal(source.tree(), source.tree(), "unchanged file returns the cached tree")

    writeTranscript(box.dir, "s1", "second prompt", 3_000)
    assert.equal(source.tree().units[0]?.request.content, "second prompt")
  })

  it("follows a newer session started in the same directory", (t) => {
    const box = sandbox()
    t.after(box.cleanup)
    writeTranscript(box.dir, "s1", "old session", 1_000)

    const source = createTranscriptSource({ cwd: CWD, home: box.home })
    t.after(() => source.close())
    assert.equal(source.tree().sessionID, "s1")

    writeTranscript(box.dir, "s2", "new session", 5_000)
    source.refresh()
    assert.equal(source.tree().sessionID, "s2")
    assert.equal(source.tree().units[0]?.request.content, "new session")
  })
})
