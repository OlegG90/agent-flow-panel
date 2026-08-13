import type { StepNode } from "./types.ts"

export const STATE_LABEL: Record<StepNode["state"], string> = {
  pending: "pending",
  running: "running",
  completed: "done",
  failed: "failed",
}
