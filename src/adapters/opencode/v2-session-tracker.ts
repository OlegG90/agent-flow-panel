import { BaseSessionTracker } from "../../flow/tracker.ts"
import { FlowStoreV2, type V2Event } from "./v2-reducer.ts"

/** Session bookkeeping for OpenCode's V2 event stream (OpenCode 2.x). */
export class SessionTrackerV2 extends BaseSessionTracker<FlowStoreV2> {
  protected createStore(sessionID: string): FlowStoreV2 {
    return new FlowStoreV2(sessionID)
  }

  dispatch(event: V2Event): void {
    if (event.type === "session.created") {
      if (event.data.parentID) {
        this.registerChild(event.data.parentID, event.data.sessionID, event.created)
      }
      return
    }
    this.storeFor(event.data.sessionID).dispatch(event)
    this.notify()
  }
}
