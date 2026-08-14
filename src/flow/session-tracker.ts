import type { Event } from "@opencode-ai/sdk"
import type { FlowTree, StepNode } from "./types.ts"
import { FlowStore } from "./reducer.ts"

export type UpdateListener = () => void

function sessionIDOf(event: Event): string | undefined {
  switch (event.type) {
    case "message.updated":
      return event.properties.info.sessionID
    case "message.part.updated":
      return event.properties.part.sessionID
    case "todo.updated":
    case "session.idle":
    case "session.status":
      return event.properties.sessionID
    default:
      return undefined
  }
}

function collectLaunchNodes(steps: StepNode[], out: StepNode[]): void {
  for (const step of steps) {
    if (step.subtask) {
      out.push(step)
    }
    collectLaunchNodes(step.children, out)
  }
}

export class SessionTracker {
  private readonly stores = new Map<string, FlowStore>()
  private readonly childrenOf = new Map<string, Array<{ id: string; created: number }>>()
  private readonly idleSessions = new Set<string>()
  private activeSessionID: string | undefined
  private listener: UpdateListener | undefined

  dispatch(event: Event): void {
    if (event.type === "session.created") {
      const info = event.properties.info
      if (info.parentID) {
        const children = this.childrenOf.get(info.parentID) ?? []
        children.push({ id: info.id, created: info.time.created })
        this.childrenOf.set(info.parentID, children)
      }
      return
    }
    if (event.type === "session.idle") {
      this.idleSessions.add(event.properties.sessionID)
    }
    const sessionID = sessionIDOf(event)
    if (!sessionID) {
      return
    }
    let store = this.stores.get(sessionID)
    if (!store) {
      store = new FlowStore(sessionID)
      this.stores.set(sessionID, store)
    }
    store.dispatch(event)
    this.listener?.()
  }

  tree(sessionID?: string): FlowTree {
    const id = sessionID ?? this.activeSessionID
    if (!id) {
      return { sessionID: "", units: [] }
    }
    return this.compose(id, this.ownTree(id))
  }

  setActiveSession(sessionID: string): void {
    this.activeSessionID = sessionID
  }

  reset(): void {
    this.stores.clear()
    this.childrenOf.clear()
    this.idleSessions.clear()
    this.activeSessionID = undefined
  }

  onUpdate(listener: UpdateListener): void {
    this.listener = listener
  }

  private ownTree(id: string): FlowTree {
    const store = this.stores.get(id)
    return store ? store.tree() : { sessionID: id, units: [] }
  }

  private compose(id: string, tree: FlowTree): FlowTree {
    const children = this.childrenOf.get(id)
    if (!children || children.length === 0) {
      return tree
    }
    const ordered = children.map((child) => child).sort((a, b) => a.created - b.created)
    const launchNodes: StepNode[] = []
    for (const unit of tree.units) {
      collectLaunchNodes(unit.steps, launchNodes)
    }
    let index = 0
    for (const node of launchNodes) {
      const child = ordered[index]
      if (!child) {
        break
      }
      index += 1
      const composed = this.compose(child.id, this.ownTree(child.id))
      for (const unit of composed.units) {
        node.children.push(unit.request, ...unit.steps)
      }
      node.state = this.idleSessions.has(child.id) ? "completed" : "running"
    }
    return tree
  }
}
