import type { FlowTree, StepNode } from "../../flow/types.ts"
import { PiFlowStore } from "./pi-reducer.ts"

export type UpdateListener = () => void

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

export class PiSessionTracker {
  private readonly stores = new Map<string, PiFlowStore>()
  private readonly childrenOf = new Map<string, Array<{ id: string; created: number }>>()
  private activeSessionID: string | undefined
  private listener: UpdateListener | undefined

  dispatchBySession(sessionID: string, fn: (store: PiFlowStore) => void): void {
    let store = this.stores.get(sessionID)
    if (!store) {
      store = new PiFlowStore(sessionID)
      this.stores.set(sessionID, store)
    }
    fn(store)
    this.listener?.()
  }

  registerChild(parentID: string, childID: string, created = Date.now()): void {
    const children = this.childrenOf.get(parentID) ?? []
    if (children.some((c) => c.id === childID)) return
    children.push({ id: childID, created })
    this.childrenOf.set(parentID, children)
    this.listener?.()
  }

  tree(sessionID?: string): FlowTree {
    const id = sessionID ?? this.activeSessionID
    if (!id) return { sessionID: "", units: [] }
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

  graftChildIntoParent(parentID: string, childID: string): void {
    this.registerChild(parentID, childID)
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
        for (let i = 0; i < rest.length; i++) {
          cursor += 1
        }
        for (const ref of rest) {
          detach(ref.node, ref.parent)
        }
        unit.steps.push(this.summaryNode(unit.id, rest))
      }
    }
    return tree
  }

  private graft(node: StepNode, child: { id: string }): void {
    const composed = this.compose(child.id, this.ownTree(child.id))
    for (const unit of composed.units) {
      node.children.push(unit.request, ...unit.steps)
    }
  }

  private summaryNode(unitID: string, refs: LaunchRef[]): StepNode {
    const names = refs.map((ref) => ref.node.label.replace(/^Sub-agent: /, ""))
    const allDone = refs.every((ref) => ref.node.state === "completed" || ref.node.state === "failed")
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
