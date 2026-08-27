import type { FlowTree, StepNode } from "./types.ts"

export type UpdateListener = () => void

/** A per-session reducer: whatever the adapter feeds it, it yields a snapshot. */
export interface FlowStoreLike {
  tree(): FlowTree
}

interface ChildRef {
  id: string
  created: number
}

interface LaunchRef {
  node: StepNode
  parent: StepNode | undefined
}

function collectLaunchRefsIn(step: StepNode, parent: StepNode | undefined, out: LaunchRef[]): void {
  if (step.subtask) {
    out.push({ node: step, parent })
  }
  for (const child of step.children) {
    collectLaunchRefsIn(child, step, out)
  }
}

function collectLaunchRefs(steps: StepNode[], out: LaunchRef[]): void {
  for (const step of steps) {
    collectLaunchRefsIn(step, undefined, out)
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

export const MAX_DETAILED_SUBTASKS = 3

/**
 * Shared session bookkeeping: one reducer per session, a parent→children map,
 * and the composition that grafts each child session's tree under the
 * `subtask` launch node that started it. Adapters add only their own
 * platform-specific `dispatch`.
 */
export abstract class BaseSessionTracker<S extends FlowStoreLike> {
  private readonly stores = new Map<string, S>()
  private readonly childrenOf = new Map<string, ChildRef[]>()
  private activeSessionID: string | undefined
  private listener: UpdateListener | undefined

  protected abstract createStore(sessionID: string): S

  protected storeFor(sessionID: string): S {
    let store = this.stores.get(sessionID)
    if (!store) {
      store = this.createStore(sessionID)
      this.stores.set(sessionID, store)
    }
    return store
  }

  protected notify(): void {
    this.listener?.()
  }

  registerChild(parentID: string, childID: string, created: number): void {
    const children = this.childrenOf.get(parentID) ?? []
    if (children.some((child) => child.id === childID)) {
      return
    }
    children.push({ id: childID, created })
    this.childrenOf.set(parentID, children)
    this.notify()
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
    // Launch nodes carry no child-session id, so they are matched positionally.
    // Sort by creation time, breaking ties on id so concurrent sub-agents keep
    // a stable order across renders instead of shifting the whole tree.
    const ordered = [...children].sort((a, b) => a.created - b.created || a.id.localeCompare(b.id))
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
        // The collapsed sub-agents still consumed their child sessions.
        cursor += rest.length
        for (const ref of rest) {
          detach(ref.node, ref.parent)
        }
        unit.steps.push(this.summaryNode(unit.id, rest))
      }
    }
    return tree
  }

  private graft(node: StepNode, child: ChildRef): void {
    const composed = this.compose(child.id, this.ownTree(child.id))
    for (const unit of composed.units) {
      node.children.push(unit.request, ...unit.steps)
    }
  }

  private summaryNode(unitID: string, refs: LaunchRef[]): StepNode {
    const names = refs.map((ref) => ref.node.label.replace(/^Sub-agent: /, ""))
    const allDone = refs.every(
      (ref) => ref.node.state === "completed" || ref.node.state === "failed",
    )
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
