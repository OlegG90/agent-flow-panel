import http from "node:http"
import type { FlowTree } from "../flow/types.ts"
import { EVENTS_PATH, renderFlowHtml, renderPanelHtml } from "../flow/render.ts"

function sseData(data: string): string {
  return `data: ${data}\n\n`
}

export interface PanelServerDeps {
  getTree: () => FlowTree
}

export interface PanelServer {
  start(): Promise<void>
  url(): string
  publish(): void
  close(): Promise<void>
}

export function createPanelServer(deps: PanelServerDeps): PanelServer {
  let boundPort = 0
  const clients = new Set<http.ServerResponse>()
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`)
    if (url.pathname === "/") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" })
      res.end(renderPanelHtml(deps.getTree()))
      return
    }
    if (url.pathname === EVENTS_PATH) {
      res.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache",
        connection: "keep-alive",
      })
      res.write(": connected\n\n")
      res.write(sseData(renderFlowHtml(deps.getTree())))
      clients.add(res)
      req.on("close", () => clients.delete(res))
      return
    }
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" })
    res.end("not found")
  })

  return {
    async start(): Promise<void> {
      if (server.listening) {
        return
      }
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject)
        server.listen(0, "127.0.0.1", () => {
          server.removeListener("error", reject)
          resolve()
        })
      })
      const address = server.address()
      if (address && typeof address === "object") {
        boundPort = address.port
      }
    },
    url(): string {
      return `http://127.0.0.1:${boundPort}/`
    },
    publish(): void {
      if (clients.size === 0) {
        return
      }
      const payload = sseData(renderFlowHtml(deps.getTree()))
      for (const client of clients) {
        try {
          client.write(payload)
        } catch {
          // socket already dead; its close handler will remove it
        }
      }
    },
    async close(): Promise<void> {
      if (!server.listening) {
        return
      }
      for (const client of clients) {
        client.end()
      }
      clients.clear()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}
