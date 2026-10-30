import { BaseSessionTracker } from "../../flow/tracker.ts"
import { V2FlowStore, type V2Event } from "./v2-reducer.ts"

/** Session bookkeeping for OpenCode's V2 event stream (OpenCode 2.x). */
export class V2SessionTracker extends BaseSessionTracker<V2FlowStore> {
  private readonly parentOf = new Map<string, string>()

  protected createStore(sessionID: string): V2FlowStore {
    return new V2FlowStore(sessionID)
  }

  dispatch(event: V2Event): void {
    if (event.type === "session.created") {
      if (event.data.parentID) {
        this.parentOf.set(event.data.sessionID, event.data.parentID)
        this.registerChild(event.data.parentID, event.data.sessionID, event.created)
      }
      return
    }
    const { sessionID } = event.data
    this.storeFor(sessionID).dispatch(event)
    const parentID = this.parentOf.get(sessionID)
    if (parentID && event.type.startsWith("session.execution.")) {
      const state = event.type === "session.execution.succeeded" ? "completed" : "failed"
      this.storeFor(parentID).childFinished(sessionID, event.created, state)
    }
    this.notify()
  }

  override reset(): void {
    super.reset()
    this.parentOf.clear()
  }
}
