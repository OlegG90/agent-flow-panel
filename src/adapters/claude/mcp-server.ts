import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { renderTree } from "../../flow/render.ts"
import { createPanelServer } from "../../server/panel-server.ts"
import { openInBrowser } from "../../server/open-browser.ts"
import { VERSION } from "../../version.ts"
import { createTranscriptSource, type DiscoveryOptions } from "./session-source.ts"

function textResult(text: string): { content: Array<{ type: "text"; text: string }> } {
  return { content: [{ type: "text", text }] }
}

/**
 * Claude Code has no plugin event API, so the panel is driven from the
 * session transcript and exposed as an MCP server: the three tools match the
 * OpenCode and Pi adapters, so the flow_* vocabulary is the same everywhere.
 */
export function createFlowMcpServer(options: DiscoveryOptions = {}): {
  server: McpServer
  close: () => Promise<void>
} {
  const source = createTranscriptSource(options)
  const panel = createPanelServer({ getTree: () => source.tree(), source: "Claude Code" })
  source.onChange(() => panel.publish())

  const server = new McpServer({ name: "flow-panel", version: VERSION })

  const open = async (reset: boolean): Promise<string> => {
    if (reset) {
      source.refresh()
    }
    await panel.start()
    const url = panel.url()
    try {
      await openInBrowser(url)
    } catch {
      // A headless box still gets a working URL back.
    }
    return url
  }

  server.registerTool(
    "flow_open",
    {
      title: "Flow Panel",
      description: "Open the Agent Flow panel in the default browser, keeping the current view.",
    },
    async () => textResult(`Opened ${await open(false)}`),
  )

  server.registerTool(
    "flow_panel",
    {
      title: "Flow Panel (reset)",
      description:
        "Open the Agent Flow panel in the default browser, re-reading the newest session transcript.",
    },
    async () => textResult(`Opened ${await open(true)}`),
  )

  server.registerTool(
    "flow_tree",
    {
      title: "Flow Tree",
      description: "Show the Agent Flow step tree for this session as text.",
    },
    async () => {
      const tree = source.tree()
      return textResult(
        tree.units.length > 0 ? renderTree(tree) : "No flow data recorded for this session.",
      )
    },
  )

  return {
    server,
    close: async (): Promise<void> => {
      source.close()
      await panel.close()
    },
  }
}

export async function runStdioServer(options: DiscoveryOptions = {}): Promise<void> {
  const { server, close } = createFlowMcpServer(options)
  const shutdown = (): void => {
    void close().finally(() => process.exit(0))
  }
  process.on("SIGINT", shutdown)
  process.on("SIGTERM", shutdown)
  await server.connect(new StdioServerTransport())
}
