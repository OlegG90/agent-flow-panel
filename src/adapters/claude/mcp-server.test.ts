import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { createFlowMcpServer } from "./mcp-server.ts"
import { encodeProjectDir } from "./session-source.ts"

const CWD = "C:\\Workspace\\Sandbox\\Projects\\Opencode_Plg"

function sandbox(withTranscript: boolean): { home: string; cleanup: () => void } {
  const home = mkdtempSync(join(tmpdir(), "flow-mcp-"))
  const dir = join(home, ".claude", "projects", encodeProjectDir(CWD))
  mkdirSync(dir, { recursive: true })
  if (withTranscript) {
    writeFileSync(
      join(dir, "s1.jsonl"),
      [
        JSON.stringify({
          type: "user",
          uuid: "u1",
          timestamp: "2026-01-01T00:00:00.000Z",
          message: { role: "user", content: "list the files" },
        }),
        JSON.stringify({
          type: "assistant",
          uuid: "a1",
          requestId: "r1",
          timestamp: "2026-01-01T00:00:02.000Z",
          message: {
            role: "assistant",
            content: [
              { type: "text", text: "Listing them." },
              { type: "tool_use", id: "tu1", name: "Bash", input: { command: "ls -la" } },
            ],
          },
        }),
      ].join("\n"),
    )
  }
  return { home, cleanup: () => rmSync(home, { recursive: true, force: true }) }
}

async function connect(home: string): Promise<{ client: Client; close: () => Promise<void> }> {
  const { server, close } = createFlowMcpServer({ cwd: CWD, home })
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: "test", version: "0" })
  await Promise.all([client.connect(clientSide), server.connect(serverSide)])
  return {
    client,
    close: async () => {
      await client.close()
      await close()
    },
  }
}

describe("flow MCP server", () => {
  it("advertises the same three flow tools as the other adapters", async (t) => {
    const box = sandbox(true)
    t.after(box.cleanup)
    const { client, close } = await connect(box.home)
    t.after(close)

    const { tools } = await client.listTools()
    assert.deepEqual(
      tools.map((tool) => tool.name).sort(),
      ["flow_open", "flow_panel", "flow_tree"],
    )
  })

  it("renders the session transcript through flow_tree", async (t) => {
    const box = sandbox(true)
    t.after(box.cleanup)
    const { client, close } = await connect(box.home)
    t.after(close)

    const result = (await client.callTool({ name: "flow_tree" })) as {
      content: Array<{ type: string; text: string }>
    }
    const text = result.content[0]!.text
    assert.match(text, /Unit of Work #1/)
    assert.match(text, /list the files/)
    assert.match(text, /Tool: Bash · ls -la/)
  })

  it("reports an empty session instead of failing", async (t) => {
    const box = sandbox(false)
    t.after(box.cleanup)
    const { client, close } = await connect(box.home)
    t.after(close)

    const result = (await client.callTool({ name: "flow_tree" })) as {
      content: Array<{ type: string; text: string }>
    }
    assert.equal(result.content[0]!.text, "No flow data recorded for this session.")
  })
})
