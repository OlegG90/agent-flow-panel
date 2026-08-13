import type { FlowTree, StepNode, UnitOfWork } from "../flow/types.ts"
import { STATE_LABEL } from "../flow/labels.ts"
import { truncate } from "../flow/text.ts"

export const FLOW_CONTAINER_ID = "flow"
export const EVENTS_PATH = "/events"

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;")
}

function nodeHtml(node: StepNode): string {
  const parts = [
    `<li class="step step--${node.type} step--${STATE_LABEL[node.state]}" data-type="${node.type}" data-state="${node.state}">`,
    `<span class="step-label">${escapeHtml(node.label)}</span>`,
    `<span class="step-state">${STATE_LABEL[node.state]}</span>`,
  ]
  if (node.content.length > 0) {
    parts.push(`<span class="step-content">${escapeHtml(truncate(node.content, 120))}</span>`)
  }
  if (node.reasoning) {
    parts.push(`<div class="step-reasoning">${escapeHtml(truncate(node.reasoning))}</div>`)
  }
  if (node.children.length > 0) {
    parts.push(`<ol class="steps steps--nested">${node.children.map(nodeHtml).join("")}</ol>`)
  }
  parts.push("</li>")
  return parts.join("")
}

function unitHtml(unit: UnitOfWork, index: number): string {
  const planHtml =
    unit.plan.length > 0
      ? `<ul class="plan">${unit.plan
          .map(
            (item) =>
              `<li class="plan-item" data-state="${item.state}">${escapeHtml(item.title)}</li>`,
          )
          .join("")}</ul>`
      : ""
  return [
    '<section class="unit">',
    `<h2 class="unit-title">Unit of Work #${index + 1}</h2>`,
    planHtml,
    `<ol class="steps">${nodeHtml(unit.request)}${unit.steps.map(nodeHtml).join("")}</ol>`,
    "</section>",
  ].join("")
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
.step-content { color: var(--muted); margin-left: 0.5rem; }
.step-reasoning { color: var(--muted); font-style: italic; margin-top: 0.25rem; font-size: 0.85rem; }
.step--user-request { border-color: var(--user-request); }
.step--model-call { border-color: var(--model-call); }
.step--model-reply { border-color: var(--model-reply); }
.step--tool-call { border-color: var(--tool-call); }
.step--tool-result { border-color: var(--tool-result); }
.step--answer { border-color: var(--answer); }
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

export function renderFlowHtml(tree: FlowTree): string {
  const units = tree.units.map((unit, index) => unitHtml(unit, index)).join("")
  const empty = tree.units.length === 0 ? '<p class="empty">No flow recorded yet.</p>' : ""
  return units + empty
}

const CLIENT_SCRIPT = `
<script>
(() => {
  const flow = document.getElementById("${FLOW_CONTAINER_ID}");
  if (!flow) return;
  const source = new EventSource("${EVENTS_PATH}");
  source.onmessage = (event) => { flow.innerHTML = event.data; };
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
