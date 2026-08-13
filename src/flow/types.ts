export type StepType =
  | "user-request"
  | "model-call"
  | "model-reply"
  | "tool-call"
  | "tool-result"
  | "answer"

export type StepState = "pending" | "running" | "completed" | "failed"

export interface StepNode {
  id: string
  type: StepType
  label: string
  state: StepState
  content: string
  reasoning?: string
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
