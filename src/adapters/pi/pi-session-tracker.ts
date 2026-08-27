import { BaseSessionTracker } from "../../flow/tracker.ts"
import { PiFlowStore } from "./pi-reducer.ts"

export type { UpdateListener } from "../../flow/tracker.ts"

export class PiSessionTracker extends BaseSessionTracker<PiFlowStore> {
  protected createStore(sessionID: string): PiFlowStore {
    return new PiFlowStore(sessionID)
  }

  dispatchBySession(sessionID: string, fn: (store: PiFlowStore) => void): void {
    fn(this.storeFor(sessionID))
    this.notify()
  }

  /**
   * Pi's `session_start{reason:"fork"}` carries no creation timestamp, so the
   * fork's arrival time is the best ordering key available.
   */
  override registerChild(parentID: string, childID: string, created = Date.now()): void {
    super.registerChild(parentID, childID, created)
  }
}
