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

function attrEscape(value: string): string {
  return escapeHtml(value).replaceAll("\n", "&#10;")
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
  const contentAttr = node.content.length > 0 ? ` data-content="${attrEscape(node.content)}"` : ""
  const reasoningAttr = node.reasoning ? ` data-reasoning="${attrEscape(node.reasoning)}"` : ""
  const parts = [
    `<li class="step step--${node.type} step--${STATE_LABEL[node.state]}${hasChildren}${subtaskClass}" data-id="${escapeHtml(node.id)}" data-type="${node.type}" data-state="${node.state}"${contentAttr}${reasoningAttr}>`,
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
  --selected: #22d3ee;
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
.topbar { display: flex; align-items: center; justify-content: space-between; gap: 1rem; margin-bottom: 1rem; }
.topbar h1 { margin: 0; }
#details-toggle { background: var(--panel); color: var(--text); border: 1px solid var(--border); border-radius: 6px; padding: 0.3rem 0.7rem; cursor: pointer; font-size: 0.8rem; }
#details-toggle:hover { border-color: var(--selected); color: var(--selected); }
.layout { display: flex; gap: 1rem; align-items: flex-start; }
.flow { flex: 3; min-width: 0; }
.details {
  flex: 2;
  min-width: 0;
  position: sticky;
  top: 0;
  max-height: calc(100vh - 2rem);
  overflow: auto;
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 1rem;
}
.details-empty { color: var(--muted); margin: 0; }
.layout.details-hidden .details { display: none; }
.step--selected { outline: 2px solid var(--selected); background: rgba(34, 211, 238, 0.08); }
.details-header { display: flex; gap: 0.5rem; align-items: center; margin-bottom: 0.5rem; }
.details-type { font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.05em; border: 1px solid; border-radius: 999px; padding: 0.05rem 0.5rem; }
.details-state { font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.05em; color: var(--muted); border: 1px solid var(--border); border-radius: 999px; padding: 0.05rem 0.5rem; }
.details-label { font-size: 1.05rem; font-weight: 600; margin-bottom: 0.25rem; }
.details-id { color: var(--muted); font-size: 0.75rem; font-family: monospace; word-break: break-all; }
.details-section { margin-top: 0.75rem; }
.details-section h3 { font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.05em; color: var(--muted); margin: 0 0 0.25rem; }
.details-content { white-space: pre-wrap; word-break: break-word; font-size: 0.9rem; }
.details-reasoning { white-space: pre-wrap; word-break: break-word; font-size: 0.9rem; color: var(--muted); font-style: italic; }
@media (max-width: 760px) {
  .layout { display: block; position: relative; }
  .details {
    position: absolute;
    inset: 0;
    z-index: 10;
    max-height: none;
    height: 100%;
  }
  #details-toggle { position: fixed; top: 0.75rem; right: 0.75rem; z-index: 20; }
}
`

const CLIENT_SCRIPT = `
<script>
(() => {
  const flow = document.getElementById("${FLOW_CONTAINER_ID}");
  const details = document.getElementById("details");
  const layout = document.getElementById("layout");
  const detailsToggle = document.getElementById("details-toggle");
  if (!flow || !details || !layout || !detailsToggle) return;
  const collapsed = new Set();
  let selectedId = null;
  const esc = (value) => String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
  const applyCollapsed = () => {
    for (const id of collapsed) {
      const step = flow.querySelector('[data-id="' + id + '"]');
      if (step) step.classList.add("collapsed");
    }
  };
  const emptyDetails = () => {
    details.innerHTML = '<p class="details-empty">Select a step to see its details.</p>';
  };
  const showDetails = (step) => {
    const id = step.getAttribute("data-id") || "";
    const type = step.getAttribute("data-type") || "";
    const state = step.getAttribute("data-state") || "";
    const labelEl = step.querySelector(".step-label");
    const label = labelEl ? labelEl.textContent : "";
    const content = step.getAttribute("data-content") || "";
    const reasoning = step.getAttribute("data-reasoning") || "";
    const header =
      '<div class="details-header">' +
      '<span class="details-type step--' + esc(type) + '">' + esc(type) + "</span>" +
      '<span class="details-state">' + esc(state) + "</span></div>";
    const body =
      '<div class="details-label">' + esc(label) + "</div>" +
      '<div class="details-id">' + esc(id) + "</div>";
    const contentSection = content
      ? '<div class="details-section"><h3>Content</h3><div class="details-content">' + esc(content) + "</div></div>"
      : "";
    const reasoningSection = reasoning
      ? '<div class="details-section"><h3>Reasoning</h3><div class="details-reasoning">' + esc(reasoning) + "</div></div>"
      : "";
    details.innerHTML = header + body + contentSection + reasoningSection;
  };
  const applySelected = () => {
    if (!selectedId) return;
    const step = flow.querySelector('[data-id="' + selectedId + '"]');
    if (!step) {
      selectedId = null;
      emptyDetails();
      return;
    }
    step.classList.add("step--selected");
    showDetails(step);
  };
  const select = (step) => {
    const id = step.getAttribute("data-id");
    const previous = flow.querySelector(".step--selected");
    if (previous) previous.classList.remove("step--selected");
    if (selectedId === id) {
      selectedId = null;
      emptyDetails();
      return;
    }
    selectedId = id;
    step.classList.add("step--selected");
    layout.classList.remove("details-hidden");
    detailsToggle.textContent = "Hide details";
    showDetails(step);
  };
  const source = new EventSource("${EVENTS_PATH}");
  source.onmessage = (event) => { flow.innerHTML = event.data; applyCollapsed(); applySelected(); };
  flow.addEventListener("click", (event) => {
    const toggle = event.target.closest(".step-toggle");
    if (toggle) {
      const step = toggle.closest(".step");
      if (!step) return;
      const id = step.getAttribute("data-id");
      step.classList.toggle("collapsed");
      if (id) {
        if (step.classList.contains("collapsed")) collapsed.add(id);
        else collapsed.delete(id);
      }
      return;
    }
    const labelEl = event.target.closest(".step-label");
    if (!labelEl) return;
    const step = labelEl.closest(".step");
    if (step) select(step);
  });
  detailsToggle.addEventListener("click", () => {
    const hidden = layout.classList.toggle("details-hidden");
    detailsToggle.textContent = hidden ? "Show details" : "Hide details";
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
    '<header class="topbar">',
    "<h1>Agent Flow Panel</h1>",
    '<button id="details-toggle" type="button">Hide details</button>',
    "</header>",
    '<main class="layout" id="layout">',
    `<div class="flow" id="${FLOW_CONTAINER_ID}">${renderFlowHtml(tree)}</div>`,
    '<aside class="details" id="details"><p class="details-empty">Select a step to see its details.</p></aside>',
    "</main>",
    CLIENT_SCRIPT,
    "</body>",
    "</html>",
  ].join("")
}
