import type { StepNode, StepState, StepType } from "./types.ts"

/**
 * Step construction, shared by every adapter.
 *
 * Node ids are not decorative: the panel keys collapse state, selection and
 * the `/node` details lookup off them, so the prefixes are a contract rather
 * than a naming habit.
 *
 * | prefix    | node                                    |
 * |-----------|-----------------------------------------|
 * | `ur-`     | the unit's UserRequest                  |
 * | `mc-`     | ModelCall — the id the panel selects on |
 * | `mr-`     | ModelReply, folded into the call on screen |
 * | `tc-`     | ToolCall, keyed by the platform's call id |
 * | `tr-`     | ToolResult, derived from its call's id  |
 * | `ans-`    | the unit's Answer                       |
 */
export function makeNode(
  id: string,
  type: StepType,
  label: string,
  state: StepState,
  content = "",
): StepNode {
  return { id, type, label, state, content, children: [] }
}

/** The final message of a unit. Empty text yields nothing, not an empty node. */
export function makeAnswer(unitID: string, text: string): StepNode | undefined {
  const trimmed = text.trim()
  if (trimmed.length === 0) {
    return undefined
  }
  return makeNode(`ans-${unitID}`, "answer", "Answer", "completed", trimmed)
}
