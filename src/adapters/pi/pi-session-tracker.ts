import type { FlowTree } from "../../flow/types.ts"
import { PiFlowStore } from "./pi-reducer.ts"

export type UpdateListener = () => void

export class PiSessionTracker {
  private readonly stores = new Map<string, PiFlowStore>()
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

  tree(sessionID?: string): FlowTree {
    const id = sessionID ?? this.activeSessionID
    if (!id) return { sessionID: "", units: [] }
    const store = this.stores.get(id)
    return store ? store.tree() : { sessionID: id, units: [] }
  }

  setActiveSession(sessionID: string): void {
    this.activeSessionID = sessionID
  }

  reset(): void {
    this.stores.clear()
    this.activeSessionID = undefined
  }

  onUpdate(listener: UpdateListener): void {
    this.listener = listener
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  graftChildIntoParent(_parentID: string, _childID: string): void {}
}
