import type { Plugin, PluginModule } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"
import { SessionTracker } from "./adapters/opencode/session-tracker.ts"
import { renderTree } from "./flow/render.ts"
import { createPanelServer } from "./server/panel-server.ts"
import { openInBrowser } from "./server/open-browser.ts"
import { VERSION } from "./version.ts"

// State lives per plugin instance, not per module: two OpenCode instances
// loading this plugin must not share a tracker or an HTTP port.
const server: Plugin = async () => {
  const tracker = new SessionTracker()
  const panelServer = createPanelServer({ getTree: () => tracker.tree() })
  tracker.onUpdate(() => panelServer.publish())

  async function openPanelInBrowser(context: { sessionID: string }): Promise<string> {
    tracker.setActiveSession(context.sessionID)
    await panelServer.start()
    const url = panelServer.url()
    await openInBrowser(url)
    return url
  }

  const openPanel = tool({
    description:
      "Open the Agent Flow panel in the default browser, starting fresh from this moment.",
    args: {},
    execute: async (_args, context) => {
      tracker.reset()
      const url = await openPanelInBrowser(context)
      return { title: "Agent Flow panel opened", output: `Opened ${url}` }
    },
  })

  const openPanelKeepHistory = tool({
    description: "Open the Agent Flow panel in the default browser, keeping the current view.",
    args: {},
    execute: async (_args, context) => {
      const url = await openPanelInBrowser(context)
      return { title: "Agent Flow panel opened", output: `Opened ${url}` }
    },
  })

  const showTree = tool({
    description: "Show the Agent Flow step tree for this session as text.",
    args: {},
    execute: async (_args, context) => {
      const tree = tracker.tree(context.sessionID)
      return tree.units.length > 0 ? renderTree(tree) : "No flow data recorded for this session."
    },
  })

  return {
    event: async ({ event }) => {
      if (event.type === "server.instance.disposed") {
        await panelServer.close()
        return
      }
      tracker.dispatch(event)
    },
    tool: {
      flow_panel: openPanel,
      flow_open: openPanelKeepHistory,
      flow_tree: showTree,
    },
  }
}

const module: PluginModule = {
  id: "flow-panel",
  server,
} as PluginModule & { version: string }

// Expose version for tooling and panel
;(module as unknown as Record<string, unknown>).version = VERSION

export default module
export { VERSION }
