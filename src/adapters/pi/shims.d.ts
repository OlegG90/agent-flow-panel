declare module "@earendil-works/pi-coding-agent" {
  export interface ExtensionAPI {
    on(event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown): void
    registerCommand(
      name: string,
      opts: { description: string; handler: (args: string, ctx: ExtensionContext) => Promise<void> },
    ): void
    /**
     * Inject a message into the session. A command handler returns void, so
     * this is the only way a command can put text in front of the user.
     */
    sendMessage(
      message: { customType: string; content: string; display: boolean; details?: unknown },
      options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" },
    ): void
    registerTool(tool: {
      name: string
      label: string
      description: string
      parameters: unknown
      execute: (
        id: string,
        params: unknown,
        signal: AbortSignal,
        onUpdate: unknown,
        ctx: ExtensionContext,
      ) => Promise<unknown>
    }): void
  }
  export interface ExtensionContext {
    cwd: string
    mode: string
    hasUI: boolean
    ui: { notify(msg: string, type?: string): void; confirm(a: string, b: string): Promise<boolean> }
    sessionManager: { getSessionId(): string | undefined; getBranch(): unknown[] }
    signal: AbortSignal
  }
}
declare module "typebox" {
  export const Type: {
    Object(o: Record<string, unknown>): unknown
    String(o?: unknown): unknown
  }
}
