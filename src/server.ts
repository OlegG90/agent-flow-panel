import { execFile } from "node:child_process"
import { promisify } from "node:util"
import type { Plugin, PluginModule } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"
import type { FlowTree } from "./flow/types.ts"
import { FlowStore, getSessionID } from "./flow/reducer.ts"
import { renderTree } from "./flow/render.ts"
import { createPanelServer } from "./server/panel-server.ts"

const execFileAsync = promisify(execFile)
const stores = new Map<string, FlowStore>()
let activeSessionID: string | undefined

const panelServer = createPanelServer({
  getTree: (): FlowTree => {
    const store = activeSessionID ? stores.get(activeSessionID) : undefined
    return store ? store.tree() : { sessionID: activeSessionID ?? "", units: [] }
  },
})

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
    activeSessionID = context.sessionID
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
    const store = stores.get(context.sessionID)
    return store ? renderTree(store.tree()) : "No flow data recorded for this session."
  },
})

const server: Plugin = async () => {
  return {
    event: async ({ event }) => {
      const sessionID = getSessionID(event)
      if (!sessionID) {
        return
      }
      activeSessionID = sessionID
      let store = stores.get(sessionID)
      if (!store) {
        store = new FlowStore(sessionID)
        stores.set(sessionID, store)
      }
      store.dispatch(event)
      panelServer.publish()
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
