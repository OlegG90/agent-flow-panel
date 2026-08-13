import type { FlowTree, StepNode } from "./types.ts"
import { STATE_LABEL } from "./labels.ts"
import { truncate } from "./text.ts"

function renderNode(node: StepNode, indent: number): string[] {
  const pad = "  ".repeat(indent)
  const content = node.content.length > 0 ? `: ${truncate(node.content)}` : ""
  const lines = [`${pad}[${STATE_LABEL[node.state]}] ${node.label}${content}`]
  if (node.reasoning) {
    lines.push(`${pad}  ↳ reasoning: ${truncate(node.reasoning)}`)
  }
  for (const child of node.children) {
    lines.push(...renderNode(child, indent + 1))
  }
  return lines
}

export function renderTree(tree: FlowTree): string {
  const lines: string[] = []
  for (const [index, unit] of tree.units.entries()) {
    lines.push(`Unit of Work #${index + 1}: ${truncate(unit.request.content)}`)
    lines.push(...renderNode(unit.request, 1))
    for (const step of unit.steps) {
      lines.push(...renderNode(step, 1))
    }
    if (unit.plan.length > 0) {
      lines.push("  Plan:")
      for (const item of unit.plan) {
        lines.push(`    [${item.state}] ${item.title}`)
      }
    }
    lines.push("")
  }
  return lines.join("\n").trimEnd() || "(no flow recorded)"
}
