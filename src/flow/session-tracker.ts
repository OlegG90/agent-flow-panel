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

interface LaunchRef {
  node: StepNode
  parent: StepNode | undefined
}

function collectLaunchRefs(steps: StepNode[], out: LaunchRef[]): void {
  for (const step of steps) {
    collectLaunchRefsIn(step, undefined, out)
  }
}

function collectLaunchRefsIn(step: StepNode, parent: StepNode | undefined, out: LaunchRef[]): void {
  if (step.subtask) {
    out.push({ node: step, parent })
  }
  for (const child of step.children) {
    collectLaunchRefsIn(child, step, out)
  }
}

function detach(node: StepNode, parent: StepNode | undefined): void {
  if (!parent) {
    return
  }
  const index = parent.children.indexOf(node)
  if (index !== -1) {
    parent.children.splice(index, 1)
  }
}

const MAX_DETAILED_SUBTASKS = 3

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
    let cursor = 0
    for (const unit of tree.units) {
      const refs: LaunchRef[] = []
      collectLaunchRefs(unit.steps, refs)
      if (refs.length === 0) {
        continue
      }
      const detailed = refs.slice(0, MAX_DETAILED_SUBTASKS)
      const rest = refs.slice(MAX_DETAILED_SUBTASKS)
      for (const ref of detailed) {
        const child = ordered[cursor]
        if (!child) {
          break
        }
        cursor += 1
        this.graft(ref.node, child)
      }
      if (rest.length > 0) {
        const restChildren: Array<{ id: string }> = []
        for (let i = 0; i < rest.length; i++) {
          const child = ordered[cursor]
          if (child) {
            restChildren.push(child)
          }
          cursor += 1
        }
        for (const ref of rest) {
          detach(ref.node, ref.parent)
        }
        unit.steps.push(this.summaryNode(unit.id, rest, restChildren))
      }
    }
    return tree
  }

  private graft(node: StepNode, child: { id: string }): void {
    const composed = this.compose(child.id, this.ownTree(child.id))
    for (const unit of composed.units) {
      node.children.push(unit.request, ...unit.steps)
    }
    node.state = this.idleSessions.has(child.id) ? "completed" : "running"
  }

  private summaryNode(unitID: string, refs: LaunchRef[], children: Array<{ id: string }>): StepNode {
    const names = refs.map((ref) => ref.node.label.replace(/^Sub-agent: /, ""))
    const allDone =
      children.length === refs.length && children.every((child) => this.idleSessions.has(child.id))
    return {
      id: `summary-${unitID}`,
      type: "subtask-summary",
      label: refs.length === 1 ? "1 more sub-agent" : `${refs.length} more sub-agents`,
      state: allDone ? "completed" : "running",
      content: names.join(", "),
      children: [],
    }
  }
}
