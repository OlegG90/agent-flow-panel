export type StepType =
  | "user-request"
  | "model-call"
  | "model-reply"
  | "tool-call"
  | "tool-result"
  | "answer"
  | "subtask-summary"
  | "orchestration"

export type StepState = "pending" | "running" | "completed" | "failed"

/** What one model call consumed, as reported by the platform. */
export interface TokenUsage {
  input: number
  output: number
  reasoning: number
  cacheRead: number
  cacheWrite: number
}

export interface StepNode {
  id: string
  type: StepType
  label: string
  state: StepState
  content: string
  reasoning?: string
  subtask?: boolean
  /** Epoch ms; present once the platform reports when the step began. */
  startedAt?: number
  /** Epoch ms; present once the step reached a terminal state. */
  endedAt?: number
  tokens?: TokenUsage
  /** Cost in USD, as billed by the provider. */
  cost?: number
  children: StepNode[]
}

export type PlanState = "pending" | "in-progress" | "completed"

export interface PlanItem {
  id: string
  title: string
  state: PlanState
}

export interface UnitOfWork {
  id: string
  request: StepNode
  steps: StepNode[]
  plan: PlanItem[]
}

export interface FlowTree {
  sessionID: string
  units: UnitOfWork[]
}
