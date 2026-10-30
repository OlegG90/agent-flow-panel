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
 * `subtask` launch node that started it — by the node's `childSessionID` when
 * the adapter knows it, otherwise by creation order. Adapters add only their own
 * platform-specific `dispatch`.
 */
export abstract class BaseSessionTracker<S extends FlowStoreLike> {
  private readonly stores = new Map<string, S>()
  private readonly childrenOf = new Map<string, ChildRef[]>()
  /** Sessions on the current `compose` chain, so a graft never recurses into one. */
  private readonly composing = new Set<string>()
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
    const launches = tree.units.map((unit) => {
      const refs: LaunchRef[] = []
      collectLaunchRefs(unit.steps, refs)
      return { unit, refs }
    })
    // A launch node that names its child session is grafted by that id; the
    // rest are matched positionally against the children no node claimed.
    const claimed = new Set(launches.flatMap(({ refs }) => refs.flatMap((ref) => ref.node.childSessionID ?? [])))
    // Sort by creation time, breaking ties on id so concurrent sub-agents keep
    // a stable order across renders instead of shifting the whole tree.
    const ordered = (this.childrenOf.get(id) ?? [])
      .filter((child) => !claimed.has(child.id))
      .sort((a, b) => a.created - b.created || a.id.localeCompare(b.id))
    if (claimed.size === 0 && ordered.length === 0) {
      return tree
    }
    let cursor = 0
    // Every launch, collapsed or not, takes its child, so positional ones advance the cursor.
    const take = (ref: LaunchRef): string | undefined => ref.node.childSessionID ?? ordered[cursor++]?.id
    this.composing.add(id)
    for (const { unit, refs } of launches) {
      const childIDs = refs.map(take)
      refs.slice(0, MAX_DETAILED_SUBTASKS).forEach((ref, index) => {
        const childID = childIDs[index]
        if (childID !== undefined) {
          this.graft(ref.node, childID)
        }
      })
      const rest = refs.slice(MAX_DETAILED_SUBTASKS)
      if (rest.length > 0) {
        for (const ref of rest) {
          detach(ref.node, ref.parent)
        }
        unit.steps.push(this.summaryNode(unit.id, rest))
      }
    }
    this.composing.delete(id)
    return tree
  }

  private graft(node: StepNode, childID: string): void {
    // An id reported by the platform could point back up the chain; never recurse into it.
    if (this.composing.has(childID)) {
      return
    }
    const composed = this.compose(childID, this.ownTree(childID))
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
