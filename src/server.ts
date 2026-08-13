import { execFile } from "node:child_process"
import { promisify } from "node:util"
import type { Plugin, PluginModule } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"
import { SessionTracker } from "./flow/session-tracker.ts"
import { renderTree } from "./flow/render.ts"
import { createPanelServer } from "./server/panel-server.ts"

const execFileAsync = promisify(execFile)
const tracker = new SessionTracker()

const panelServer = createPanelServer({
  getTree: () => tracker.tree(),
})
tracker.onUpdate(() => panelServer.publish())

async function openInBrowser(url: string): Promise<void> {
  if (process.platform === "win32") {
    await execFileAsync("cmd", ["/c", "start", "", url])
    return
  }
  const opener = process.platform === "darwin" ? "open" : "xdg-open"
  await execFileAsync(opener, [url])
}

const openPanel = tool({
  description: "Open the Agent Flow panel in the default browser.",
  args: {},
  execute: async (_args, context) => {
    tracker.setActiveSession(context.sessionID)
    await panelServer.start()
    const url = panelServer.url()
    await openInBrowser(url)
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

const server: Plugin = async () => {
  return {
    event: async ({ event }) => {
      tracker.dispatch(event)
    },
    tool: {
      flow_panel: openPanel,
      flow_tree: showTree,
    },
  }
}

const module: PluginModule = {
  id: "flow-panel",
  server,
}

export default module
