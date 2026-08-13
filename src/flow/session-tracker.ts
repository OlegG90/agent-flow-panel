import type { Event } from "@opencode-ai/sdk"
import type { FlowTree } from "./types.ts"
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

export class SessionTracker {
  private readonly stores = new Map<string, FlowStore>()
  private activeSessionID: string | undefined
  private listener: UpdateListener | undefined

  dispatch(event: Event): void {
    const sessionID = sessionIDOf(event)
    if (!sessionID) {
      return
    }
    this.activeSessionID = sessionID
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
    const store = id ? this.stores.get(id) : undefined
    return store ? store.tree() : { sessionID: id ?? "", units: [] }
  }

  setActiveSession(sessionID: string): void {
    this.activeSessionID = sessionID
  }

  onUpdate(listener: UpdateListener): void {
    this.listener = listener
  }
}
