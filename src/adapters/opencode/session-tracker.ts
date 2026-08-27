import type { Event } from "@opencode-ai/sdk"
import { BaseSessionTracker } from "../../flow/tracker.ts"
import { FlowStore } from "./reducer.ts"

export type { UpdateListener } from "../../flow/tracker.ts"

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

export class SessionTracker extends BaseSessionTracker<FlowStore> {
  protected createStore(sessionID: string): FlowStore {
    return new FlowStore(sessionID)
  }

  dispatch(event: Event): void {
    if (event.type === "session.created") {
      const info = event.properties.info
      if (info.parentID) {
        this.registerChild(info.parentID, info.id, info.time.created)
      }
      return
    }
    const sessionID = sessionIDOf(event)
    if (!sessionID) {
      return
    }
    this.storeFor(sessionID).dispatch(event)
    this.notify()
  }
}
