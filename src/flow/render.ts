import type { FlowTree, PlanItem, StepNode, UnitOfWork } from "./types.ts"

export const FLOW_CONTAINER_ID = "flow"
export const EVENTS_PATH = "/events"

const STATE_LABEL: Record<StepNode["state"], string> = {
  pending: "pending",
  running: "running",
  completed: "done",
  failed: "failed",
}

function truncate(text: string, max = 80): string {
  const compact = text.replace(/\s+/g, " ").trim()
  return compact.length > max ? `${compact.slice(0, max)}…` : compact
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;")
}

interface WalkContext {
  node: StepNode
  inner: string
  depth: number
}

function walk(node: StepNode, depth: number, leaf: (ctx: WalkContext) => string): string {
  const inner = node.children.map((child) => walk(child, depth + 1, leaf)).join("")
  return leaf({ node, inner, depth })
}

function textLeaf({ node, inner, depth }: WalkContext): string {
  const pad = "  ".repeat(depth)
  const content = node.content.length > 0 ? `: ${truncate(node.content)}` : ""
  const lines = [`${pad}[${STATE_LABEL[node.state]}] ${node.label}${content}`]
  if (node.reasoning) {
    lines.push(`${pad}  ↳ reasoning: ${truncate(node.reasoning)}`)
  }
  if (inner) {
    lines.push(inner)
  }
  return lines.join("\n")
}

function htmlLeaf({ node, inner }: WalkContext): string {
  const hasChildren = inner ? " has-children" : ""
  const subtaskClass = node.subtask ? " step--subtask" : ""
  const toggle = inner ? '<button class="step-toggle" type="button" aria-label="Toggle">▾</button>' : ""
  const badge = node.subtask ? '<span class="step-badge">sub-agent</span>' : ""
  const parts = [
    `<li class="step step--${node.type} step--${STATE_LABEL[node.state]}${hasChildren}${subtaskClass}" data-id="${escapeHtml(node.id)}" data-type="${node.type}" data-state="${node.state}">`,
    toggle,
    `<span class="step-label">${escapeHtml(node.label)}</span>`,
    badge,
    `<span class="step-state">${STATE_LABEL[node.state]}</span>`,
  ]
  if (node.content.length > 0) {
    parts.push(`<span class="step-content">${escapeHtml(truncate(node.content, 120))}</span>`)
  }
  if (node.reasoning) {
    parts.push(`<div class="step-reasoning">${escapeHtml(truncate(node.reasoning))}</div>`)
  }
  if (inner) {
    parts.push(`<ol class="steps steps--nested">${inner}</ol>`)
  }
  parts.push("</li>")
  return parts.join("")
}

function renderPlan(plan: PlanItem[], format: "text" | "html"): string {
  if (plan.length === 0) {
    return ""
  }
  if (format === "text") {
    return `  Plan:\n${plan.map((item) => `    [${item.state}] ${item.title}`).join("\n")}`
  }
  return `<ul class="plan">${plan
    .map(
      (item) =>
        `<li class="plan-item" data-state="${item.state}">${escapeHtml(item.title)}</li>`,
    )
    .join("")}</ul>`
}

function unitText(unit: UnitOfWork, index: number): string {
  const lines = [`Unit of Work #${index + 1}: ${truncate(unit.request.content)}`]
  lines.push(walk(unit.request, 1, textLeaf))
  for (const step of unit.steps) {
    lines.push(walk(step, 1, textLeaf))
  }
  const plan = renderPlan(unit.plan, "text")
  if (plan) {
    lines.push(plan)
  }
  return lines.join("\n")
}

function unitHtml(unit: UnitOfWork, index: number): string {
  return [
    '<section class="unit">',
    `<h2 class="unit-title">Unit of Work #${index + 1}</h2>`,
    renderPlan(unit.plan, "html"),
    `<ol class="steps">${walk(unit.request, 0, htmlLeaf)}${unit.steps
      .map((step) => walk(step, 0, htmlLeaf))
      .join("")}</ol>`,
    "</section>",
  ].join("")
}

export function renderTree(tree: FlowTree): string {
  const lines: string[] = []
  for (const [index, unit] of tree.units.entries()) {
    lines.push(unitText(unit, index))
    lines.push("")
  }
  return lines.join("\n").trimEnd() || "(no flow recorded)"
}

export function renderFlowHtml(tree: FlowTree): string {
  const units = tree.units.map((unit, index) => unitHtml(unit, index)).join("")
  const empty = tree.units.length === 0 ? '<p class="empty">No flow recorded yet.</p>' : ""
  return units + empty
}

const STYLES = `
:root {
  color-scheme: dark;
  --bg: #161618;
  --panel: #1f1f23;
  --border: #3f3f46;
  --text: #e4e4e7;
  --muted: #a1a1aa;
  --user-request: #60a5fa;
  --model-call: #a78bfa;
  --model-reply: #34d399;
  --tool-call: #fbbf24;
  --tool-result: #94a3b8;
  --answer: #f472b6;
  --failed: #f87171;
  --subtask-summary: #c084fc;
}
* { box-sizing: border-box; }
body {
  font-family: system-ui, sans-serif;
  margin: 0;
  padding: 2rem;
  background: var(--bg);
  color: var(--text);
}
h1 { font-size: 1.25rem; }
.empty { color: var(--muted); }
.unit {
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 1rem;
  margin-bottom: 1rem;
}
.unit-title { font-size: 1rem; margin-top: 0; }
.steps { list-style: none; margin: 0; padding: 0; }
.steps--nested { margin-left: 1.25rem; margin-top: 0.4rem; border-left: 2px solid var(--border); padding-left: 0.75rem; }
.step { padding: 0.4rem 0.6rem; border-radius: 6px; border: 1px solid transparent; margin-top: 0.3rem; }
.step-label { font-weight: 600; }
.step-state { font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.05em; color: var(--muted); border: 1px solid var(--border); border-radius: 999px; padding: 0.05rem 0.5rem; margin-left: 0.5rem; }
.step-toggle { cursor: pointer; background: none; border: none; color: var(--muted); font-size: 0.75rem; margin-right: 0.35rem; padding: 0; transition: transform 0.15s; }
.step.collapsed > .steps--nested { display: none; }
.step.collapsed > .step-toggle { transform: rotate(-90deg); }
.step-badge { font-size: 0.6rem; text-transform: uppercase; letter-spacing: 0.05em; background: var(--subtask-summary); color: #161618; border-radius: 999px; padding: 0.05rem 0.45rem; margin-left: 0.5rem; }
.step--subtask { background: rgba(192, 132, 252, 0.08); }
.step--subtask > .steps--nested { border-left-color: var(--subtask-summary); }
.step-content { color: var(--muted); margin-left: 0.5rem; }
.step-reasoning { color: var(--muted); font-style: italic; margin-top: 0.25rem; font-size: 0.85rem; }
.step--user-request { border-color: var(--user-request); }
.step--model-call { border-color: var(--model-call); }
.step--model-reply { border-color: var(--model-reply); }
.step--tool-call { border-color: var(--tool-call); }
.step--tool-result { border-color: var(--tool-result); }
.step--answer { border-color: var(--answer); }
.step--subtask-summary { border-color: var(--subtask-summary); }
.step--done { opacity: 1; }
.step--pending { opacity: 0.45; border-style: dashed; }
.step--running { opacity: 1; animation: pulse 1.6s ease-in-out infinite; }
.step--failed { border-color: var(--failed); }
@keyframes pulse { 50% { opacity: 0.5; } }
.plan { list-style: none; padding: 0; margin: 0.75rem 0 0; display: flex; gap: 0.5rem; flex-wrap: wrap; }
.plan-item { font-size: 0.8rem; color: var(--muted); border: 1px solid var(--border); border-radius: 999px; padding: 0.2rem 0.6rem; }
.plan-item[data-state="completed"] { color: var(--model-reply); border-color: var(--model-reply); }
.plan-item[data-state="in-progress"] { color: var(--tool-call); border-color: var(--tool-call); }
`

const CLIENT_SCRIPT = `
<script>
(() => {
  const flow = document.getElementById("${FLOW_CONTAINER_ID}");
  if (!flow) return;
  const collapsed = new Set();
  const applyCollapsed = () => {
    for (const id of collapsed) {
      const step = flow.querySelector('[data-id="' + id + '"]');
      if (step) step.classList.add("collapsed");
    }
  };
  const source = new EventSource("${EVENTS_PATH}");
  source.onmessage = (event) => { flow.innerHTML = event.data; applyCollapsed(); };
  flow.addEventListener("click", (event) => {
    const button = event.target.closest(".step-toggle");
    if (!button) return;
    const step = button.closest(".step");
    if (!step) return;
    const id = step.getAttribute("data-id");
    step.classList.toggle("collapsed");
    if (id) {
      if (step.classList.contains("collapsed")) collapsed.add(id);
      else collapsed.delete(id);
    }
  });
})();
</script>
`

export function renderPanelHtml(tree: FlowTree): string {
  return [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8" />',
    "<title>Agent Flow Panel</title>",
    `<style>${STYLES}</style>`,
    "</head>",
    "<body>",
    "<h1>Agent Flow Panel</h1>",
    `<main class="flow" id="${FLOW_CONTAINER_ID}">${renderFlowHtml(tree)}</main>`,
    CLIENT_SCRIPT,
    "</body>",
    "</html>",
  ].join("")
}
