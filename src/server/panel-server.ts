import http from "node:http"
import { randomBytes, timingSafeEqual } from "node:crypto"
import type { FlowTree } from "../flow/types.ts"
import { EVENTS_PATH, renderFlowHtml, renderPanelHtml } from "../flow/render.ts"

function sseData(data: string): string {
  return `data: ${data}\n\n`
}

function sameToken(candidate: string | null, expected: string): boolean {
  if (candidate === null || candidate.length !== expected.length) {
    return false
  }
  return timingSafeEqual(Buffer.from(candidate), Buffer.from(expected))
}

/**
 * Streaming fires an update per token delta, and every frame re-renders the
 * whole tree. Coalescing on a leading+trailing window keeps the first update
 * of a burst instant while capping a continuous stream at one frame per
 * window, which is well under what the eye resolves anyway.
 */
export const DEFAULT_COALESCE_MS = 120

export interface PanelServerDeps {
  getTree: () => FlowTree
  /** Minimum gap between rendered frames. 0 disables coalescing. */
  coalesceMs?: number
}

export interface PanelServer {
  start(): Promise<void>
  /** Absolute URL of a panel route, carrying the access token. */
  url(path?: string): string
  publish(): void
  close(): Promise<void>
}

export function createPanelServer(deps: PanelServerDeps): PanelServer {
  let boundPort = 0
  // The panel exposes the full session transcript. Binding to loopback keeps
  // it off the network, but every local process shares loopback — so the URL
  // handed to the browser carries a per-run token that requests must repeat.
  const token = randomBytes(16).toString("hex")
  const clients = new Set<http.ServerResponse>()
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`)
    if (!sameToken(url.searchParams.get("t"), token)) {
      res.writeHead(401, { "content-type": "text/plain; charset=utf-8" })
      res.end("unauthorized")
      return
    }
    if (url.pathname === "/") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" })
      res.end(renderPanelHtml(deps.getTree()))
      return
    }
    if (url.pathname === "/data") {
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" })
      res.end(JSON.stringify(deps.getTree()))
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

  const coalesceMs = deps.coalesceMs ?? DEFAULT_COALESCE_MS
  let timer: ReturnType<typeof setTimeout> | undefined
  let pending = false

  function flush(): void {
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
  }

  function schedule(): void {
    if (clients.size === 0) {
      return
    }
    if (coalesceMs <= 0) {
      flush()
      return
    }
    // Inside an open window: remember that something changed and let the
    // trailing flush pick it up, so a burst costs one frame instead of N.
    if (timer) {
      pending = true
      return
    }
    flush()
    timer = setTimeout(() => {
      timer = undefined
      if (pending) {
        pending = false
        schedule()
      }
    }, coalesceMs)
    timer.unref?.()
  }

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
    url(path = ""): string {
      return `http://127.0.0.1:${boundPort}/${path}?t=${token}`
    },
    publish(): void {
      schedule()
    },
    async close(): Promise<void> {
      if (timer) {
        clearTimeout(timer)
        timer = undefined
      }
      pending = false
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
