import type { Plugin, PluginModule } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"
import type { Plugin as PluginV2 } from "@opencode/plugin"
import { SessionTracker } from "./adapters/opencode/session-tracker.ts"
import { V2SessionTracker } from "./adapters/opencode/v2-session-tracker.ts"
import { V2_EVENT_TYPES, type V2Event } from "./adapters/opencode/v2-reducer.ts"
import type { BaseSessionTracker, FlowStoreLike } from "./flow/tracker.ts"
import { renderTree } from "./flow/render.ts"
import { createPanelServer } from "./server/panel-server.ts"
import { openInBrowser } from "./server/open-browser.ts"
import { VERSION } from "./version.ts"

type FlowRuntime = ReturnType<typeof createFlowRuntime>

// State lives per plugin instance, not per module: two OpenCode instances
// loading this plugin must not share a tracker or an HTTP port.
function createFlowRuntime(tracker: BaseSessionTracker<FlowStoreLike>) {
  const panelServer = createPanelServer({ getTree: () => tracker.tree(), source: "OpenCode" })
  tracker.onUpdate(() => panelServer.publish())

  return {
    async open(sessionID: string, fresh: boolean): Promise<string> {
      if (fresh) {
        tracker.reset()
      }
      tracker.setActiveSession(sessionID)
      await panelServer.start()
      const url = panelServer.url()
      await openInBrowser(url)
      return `Opened ${url}`
    },
    treeText(sessionID: string): string {
      const tree = tracker.tree(sessionID)
      return tree.units.length > 0 ? renderTree(tree) : "No flow data recorded for this session."
    },
    close: () => panelServer.close(),
  }
}

/** The tools both plugin APIs expose; `title` marks the ones that open the panel. */
const TOOLS: readonly {
  name: string
  description: string
  title?: string
  run: (flow: FlowRuntime, sessionID: string) => Promise<string> | string
}[] = [
  {
    name: "flow_panel",
    description: "Open the Agent Flow panel in the default browser, starting fresh from this moment.",
    title: "Agent Flow panel opened",
    run: (flow, sessionID) => flow.open(sessionID, true),
  },
  {
    name: "flow_open",
    description: "Open the Agent Flow panel in the default browser, keeping the current view.",
    title: "Agent Flow panel opened",
    run: (flow, sessionID) => flow.open(sessionID, false),
  },
  {
    name: "flow_tree",
    description: "Show the Agent Flow step tree for this session as text.",
    run: (flow, sessionID) => flow.treeText(sessionID),
  },
]

/** OpenCode 1.x: hooks and tools are returned from `server()`. */
const server: Plugin = async () => {
  const tracker = new SessionTracker()
  const flow = createFlowRuntime(tracker)
  return {
    event: async ({ event }) => {
      if (event.type === "server.instance.disposed") {
        await flow.close()
        return
      }
      tracker.dispatch(event)
    },
    tool: Object.fromEntries(
      TOOLS.map((def) => [
        def.name,
        tool({
          description: def.description,
          args: {},
          execute: async (_args, context) => {
            const output = await def.run(flow, context.sessionID)
            return def.title ? { title: def.title, output } : output
          },
        }),
      ]),
    ),
  }
}

/** OpenCode 2.x: tools and the event subscription are registered in `setup()`. */
const setup: PluginV2.Plugin["setup"] = async (ctx) => {
  const tracker = new V2SessionTracker()
  const flow = createFlowRuntime(tracker)
  const controller = new AbortController()

  void (async () => {
    let failure: unknown
    try {
      const events = ctx.event.subscribe({ types: [...V2_EVENT_TYPES], signal: controller.signal })
      for await (const event of events) {
        tracker.dispatch(event as V2Event)
      }
    } catch (error) {
      failure = error
    }
    // The stream is volatile by contract; once it ends the panel stops updating.
    if (!controller.signal.aborted) {
      console.error("[flow-panel] event stream ended; the panel will no longer update.", failure ?? "")
    }
  })()

  await ctx.tool.transform((editor) => {
    for (const def of TOOLS) {
      editor.add({
        name: def.name,
        description: def.description,
        input: { type: "object", properties: {}, additionalProperties: false },
        // Direct tools, not Code Mode catalog entries: the user asks for them by name.
        options: { codemode: false },
        execute: async (_input, context) => ({ content: await def.run(flow, context.sessionID) }),
      })
    }
  })

  return async () => {
    controller.abort()
    await flow.close()
  }
}

// One default export serves both: 1.x calls `server()`, 2.x reads `id` + `setup()`.
const module = {
  id: "flow-panel",
  server,
  setup,
  version: VERSION,
} satisfies PluginModule & PluginV2.Plugin & { version: string }

export default module
export { VERSION }
