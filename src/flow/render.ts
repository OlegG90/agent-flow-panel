import type { FlowTree, PlanItem, StepNode, TokenUsage, UnitOfWork } from "./types.ts"
import { VERSION } from "../version.ts"
import { clientScript } from "./panel-client.ts"
import { FLOW_CONTAINER_ID } from "./panel-routes.ts"
import { STYLES } from "./panel-styles.ts"

export { EVENTS_PATH, EXPORT_PATH, FLOW_CONTAINER_ID, NODE_PATH } from "./panel-routes.ts"


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

export function formatDuration(ms: number): string {
  if (ms < 0) {
    return ""
  }
  if (ms < 1000) {
    return `${Math.round(ms)}ms`
  }
  if (ms < 60_000) {
    return `${(ms / 1000).toFixed(1)}s`
  }
  const minutes = Math.floor(ms / 60_000)
  const seconds = Math.round((ms % 60_000) / 1000)
  return `${minutes}m ${String(seconds).padStart(2, "0")}s`
}

function duration(node: StepNode): string {
  if (node.startedAt === undefined || node.endedAt === undefined) {
    return ""
  }
  return formatDuration(node.endedAt - node.startedAt)
}

export function formatTokens(tokens: TokenUsage): string {
  const compact = (value: number): string =>
    value >= 1000 ? `${(value / 1000).toFixed(1)}k` : String(value)
  const cached = tokens.cacheRead > 0 ? ` (${compact(tokens.cacheRead)} cached)` : ""
  return `${compact(tokens.input)}→${compact(tokens.output)} tok${cached}`
}

export function formatCost(cost: number): string {
  if (cost === 0) {
    return "$0"
  }
  return cost < 0.01 ? `$${cost.toFixed(4)}` : `$${cost.toFixed(2)}`
}

/** The badges that answer "how long did this take and what did it cost". */
/**
 * Spells out a token badge, because the compact form is not self-evident:
 * `input` counts only tokens the model had to read fresh — anything served
 * from the prompt cache is reported separately, so a call can legitimately
 * show 2 input tokens beside 41k cached.
 */
export function explainTokens(tokens: TokenUsage): string {
  const total = tokens.input + tokens.cacheRead + tokens.cacheWrite
  const parts = [
    `${tokens.input.toLocaleString("en-US")} new input tokens`,
    tokens.cacheRead > 0 ? `${tokens.cacheRead.toLocaleString("en-US")} read from cache` : "",
    tokens.cacheWrite > 0 ? `${tokens.cacheWrite.toLocaleString("en-US")} written to cache` : "",
    `${tokens.output.toLocaleString("en-US")} generated`,
    tokens.reasoning > 0 ? `of which ${tokens.reasoning.toLocaleString("en-US")} reasoning` : "",
  ].filter(Boolean)
  return `${parts.join(" · ")} — ${total.toLocaleString("en-US")} tokens went in altogether`
}

interface Metric {
  text: string
  /** Shown on hover where the compact form needs unpacking. */
  title?: string
}

function metrics(node: StepNode): Metric[] {
  const out: Metric[] = []
  const elapsed = duration(node)
  if (elapsed) {
    out.push({ text: elapsed, title: "wall clock for this step" })
  }
  if (node.tokens) {
    out.push({ text: formatTokens(node.tokens), title: explainTokens(node.tokens) })
  }
  if (node.cost !== undefined && node.cost > 0) {
    out.push({ text: formatCost(node.cost), title: "cost as billed by the provider" })
  }
  return out
}

interface UnitTotals {
  cost: number
  tokens: number
  elapsed: number
}

function totalsOf(unit: UnitOfWork): UnitTotals {
  const totals: UnitTotals = { cost: 0, tokens: 0, elapsed: 0 }
  let earliest = Number.POSITIVE_INFINITY
  let latest = 0
  const visit = (node: StepNode): void => {
    totals.cost += node.cost ?? 0
    if (node.tokens) {
      totals.tokens += node.tokens.input + node.tokens.output
    }
    if (node.startedAt !== undefined) {
      earliest = Math.min(earliest, node.startedAt)
    }
    if (node.endedAt !== undefined) {
      latest = Math.max(latest, node.endedAt)
    }
    node.children.forEach(visit)
  }
  unit.steps.forEach(visit)
  if (earliest !== Number.POSITIVE_INFINITY && latest > earliest) {
    totals.elapsed = latest - earliest
  }
  return totals
}

function attrEscape(value: string): string {
  return escapeHtml(value).replaceAll("\n", "&#10;")
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;")
}


/**
 * A ModelCall always wraps exactly one ModelReply and carries no content of
 * its own, so rendering both costs two levels of nesting per turn for no
 * information. Collapse them into one row for display only — the domain keeps
 * the two nodes distinct, and the id stays the ModelCall's so collapse and
 * selection survive the transform.
 */
function collapseTurn(node: StepNode): StepNode {
  const children = node.children.map(collapseTurn)
  const reply = children[0]
  const mergeable =
    node.type === "model-call" &&
    node.content.length === 0 &&
    children.length === 1 &&
    reply !== undefined &&
    reply.type === "model-reply"
  if (!mergeable) {
    return { ...node, children }
  }
  return {
    ...node,
    content: reply.content,
    reasoning: reply.reasoning ?? node.reasoning,
    children: reply.children,
  }
}

/**
 * Look a node up in the tree as the panel presents it. Turn collapsing moves
 * the reply's content onto the ModelCall's id, so the details endpoint has to
 * search the collapsed shape or it would answer with the wrong (empty) node.
 */
export function findStep(tree: FlowTree, id: string): StepNode | undefined {
  const search = (node: StepNode): StepNode | undefined => {
    if (node.id === id) {
      return node
    }
    for (const child of node.children) {
      const hit = search(child)
      if (hit) {
        return hit
      }
    }
    return undefined
  }
  for (const unit of tree.units) {
    const hit = search(unit.request) ?? unit.steps.map(collapseTurn).reduce<StepNode | undefined>(
      (found, step) => found ?? search(step),
      undefined,
    )
    if (hit) {
      return hit
    }
  }
  return undefined
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
  const meta = metrics(node).map((m) => m.text)
  const suffix = meta.length > 0 ? ` (${meta.join(", ")})` : ""
  const lines = [`${pad}[${STATE_LABEL[node.state]}] ${truncate(node.label, 120)}${suffix}${content}`]
  if (node.reasoning) {
    lines.push(`${pad}  ↳ reasoning: ${truncate(node.reasoning)}`)
  }
  if (inner) {
    lines.push(inner)
  }
  return lines.join("\n")
}

/**
 * `inlineContent` is for the static export only: a saved page has no server to
 * fetch details from, so it pays the size to stay self-contained. Live frames
 * never inline — that is the whole point of the /node endpoint.
 */
function makeHtmlLeaf(inlineContent: boolean): (ctx: WalkContext) => string {
  return ({ node, inner }: WalkContext): string => {
  const hasChildren = inner ? " has-children" : ""
  const subtaskClass = node.subtask ? " step--subtask" : ""
  const toggle = inner ? '<button class="step-toggle" type="button" aria-label="Toggle">▾</button>' : ""
  const badge = node.subtask ? '<span class="step-badge">sub-agent</span>' : ""
  const hasDetail = inlineContent
    ? `${node.content.length > 0 ? ` data-content="${attrEscape(node.content)}"` : ""}${
        node.reasoning ? ` data-reasoning="${attrEscape(node.reasoning)}"` : ""
      }`
    : node.content.length > 0 || node.reasoning
      ? ' data-detail="1"'
      : ""
  const parts = [
    `<li class="step step--${node.type} step--${STATE_LABEL[node.state]}${hasChildren}${subtaskClass}" data-id="${escapeHtml(node.id)}" data-type="${node.type}" data-state="${node.state}"${hasDetail}>`,
    toggle,
    // Labels carry platform-supplied text (ToolState.title, agent names), so
    // they go through truncate too: a newline would break the SSE framing.
    `<span class="step-label">${escapeHtml(truncate(node.label, 120))}</span>`,
    badge,
    `<span class="step-state">${STATE_LABEL[node.state]}</span>`,
    ...metrics(node).map(
      (m) =>
        `<span class="step-metric"${m.title ? ` title="${attrEscape(m.title)}"` : ""}>${escapeHtml(m.text)}</span>`,
    ),
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
}

const htmlLeaf = makeHtmlLeaf(false)
const staticHtmlLeaf = makeHtmlLeaf(true)

function renderPlan(plan: PlanItem[], format: "text" | "html"): string {
  if (plan.length === 0) {
    return ""
  }
  if (format === "text") {
    return `  Plan:\n${plan
      .map((item) => `    [${item.state}] ${truncate(item.title)}`)
      .join("\n")}`
  }
  // `truncate` also collapses newlines: a multi-line title would otherwise
  // break the single-line `data: …` framing of an SSE message.
  return `<ul class="plan">${plan
    .map(
      (item) =>
        `<li class="plan-item" data-state="${item.state}">${escapeHtml(truncate(item.title, 120))}</li>`,
    )
    .join("")}</ul>`
}

/**
 * CONTEXT.md defines the Plan as upcoming steps "previewed in the panel as
 * pending nodes". Only items still to be started get a node — the ones already
 * done or in flight are visible as real steps, and duplicating them would just
 * double the tree. The chips above stay as the compact overview.
 */
function plannedNodes(unit: UnitOfWork): StepNode[] {
  return unit.plan
    .filter((item) => item.state === "pending")
    .map((item) => ({
      id: `plan-${item.id}`,
      type: "planned" as const,
      label: item.title,
      state: "pending" as const,
      content: "",
      children: [],
    }))
}

function unitSummary(unit: UnitOfWork): string[] {
  const totals = totalsOf(unit)
  const out: string[] = []
  if (totals.elapsed > 0) {
    out.push(formatDuration(totals.elapsed))
  }
  if (totals.tokens > 0) {
    out.push(
      totals.tokens >= 1000 ? `${(totals.tokens / 1000).toFixed(1)}k tok` : `${totals.tokens} tok`,
    )
  }
  if (totals.cost > 0) {
    out.push(formatCost(totals.cost))
  }
  return out
}

function unitText(unit: UnitOfWork, index: number): string {
  const summary = unitSummary(unit)
  const suffix = summary.length > 0 ? ` [${summary.join(" · ")}]` : ""
  const lines = [`Unit of Work #${index + 1}${suffix}: ${truncate(unit.request.content)}`]
  lines.push(walk(unit.request, 1, textLeaf))
  for (const step of unit.steps) {
    lines.push(walk(collapseTurn(step), 1, textLeaf))
  }
  for (const planned of plannedNodes(unit)) {
    lines.push(walk(planned, 1, textLeaf))
  }
  const plan = renderPlan(unit.plan, "text")
  if (plan) {
    lines.push(plan)
  }
  return lines.join("\n")
}

function unitHtml(unit: UnitOfWork, index: number, leaf = htmlLeaf): string {
  const summary = unitSummary(unit)
    .map((value) => `<span class="unit-metric">${escapeHtml(value)}</span>`)
    .join("")
  return [
    '<section class="unit">',
    `<h2 class="unit-title">Unit of Work #${index + 1}${summary}</h2>`,
    renderPlan(unit.plan, "html"),
    `<ol class="steps">${walk(unit.request, 0, leaf)}${unit.steps
      .map((step) => walk(collapseTurn(step), 0, leaf))
      .join("")}${plannedNodes(unit)
      .map((planned) => walk(planned, 0, leaf))
      .join("")}</ol>`,
    "</section>",
  ].join("")
}

/**
 * The text tree goes into a chat message, which has a size limit the flow
 * does not. A 38-unit session rendered 218KB and was rejected outright —
 * unusable exactly where it is most wanted. So the newest units are kept and
 * older ones dropped, since the recent end is what a reader is asking about;
 * the panel remains the place to see everything.
 */
export const DEFAULT_TREE_MAX_CHARS = 30_000

export interface TextTreeOptions {
  maxChars?: number
  maxUnits?: number
}

export function renderTree(tree: FlowTree, options: TextTreeOptions = {}): string {
  if (tree.units.length === 0) {
    return "(no flow recorded)"
  }
  const maxChars = options.maxChars ?? DEFAULT_TREE_MAX_CHARS
  const maxUnits = options.maxUnits ?? tree.units.length

  const rendered = tree.units.map((unit, index) => unitText(unit, index))
  const kept: string[] = []
  let used = 0
  for (let i = rendered.length - 1; i >= 0; i--) {
    let text = rendered[i]!
    if (kept.length >= maxUnits) {
      break
    }
    // A single unit can exceed the budget on its own; show its head rather
    // than nothing, so the newest work is never invisible.
    if (kept.length === 0 && text.length > maxChars) {
      text = `${text.slice(0, maxChars)}\n  … unit truncated`
    } else if (used + text.length > maxChars) {
      break
    }
    used += text.length + 1
    kept.unshift(text)
  }

  const omitted = tree.units.length - kept.length
  const header =
    omitted > 0
      ? [
          `… ${omitted} earlier ${omitted === 1 ? "Unit" : "Units"} of Work omitted of ${tree.units.length} — open the panel for the full flow.`,
          "",
        ]
      : []
  return [...header, ...kept].join("\n").trimEnd()
}

export function renderFlowHtml(tree: FlowTree, leaf = htmlLeaf): string {
  const units = tree.units.map((unit, index) => unitHtml(unit, index, leaf)).join("")
  const empty = tree.units.length === 0 ? '<p class="empty">No flow recorded yet.</p>' : ""
  return units + empty
}

/**
 * Which agent this panel belongs to. Several can run at once — a Claude Code
 * MCP server, an OpenCode plugin and an omp extension each open their own port
 * — and without this every page looked identical, which is exactly how a panel
 * gets mistaken for another agent's.
 */
export interface PageOptions {
  source?: string
}

function renderPage(tree: FlowTree, live: boolean, options: PageOptions = {}): string {
  return [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8" />',
    `<title>${escapeHtml(options.source ? `${options.source} — Agent Flow` : "Agent Flow Panel")}</title>`,
    `<style>${STYLES}</style>`,
    "</head>",
    "<body>",
    '<header class="topbar">',
    `<h1>Agent Flow Panel <span class="page-source">${escapeHtml(
      [options.source, tree.sessionID].filter(Boolean).join(" · ") || `v${VERSION}`,
    )}</span></h1>`,
    '<div class="toolbar">',
    '<input id="filter-search" class="toolbar-search" type="search" placeholder="Filter steps…" aria-label="Filter steps" />',
    '<button id="filter-failed" class="toolbar-toggle" type="button" aria-pressed="false">Failed only</button>',
    '<button id="follow-toggle" class="toolbar-toggle" type="button" aria-pressed="false">Follow</button>',
    '<button id="order-toggle" class="toolbar-toggle" type="button" aria-pressed="false">Newest first</button>',
    '<button id="collapse-all" class="toolbar-button" type="button">Collapse all</button>',
    '<button id="expand-all" class="toolbar-button" type="button">Expand all</button>',
    live ? '<a id="export-link" class="toolbar-button" href="#" download="agent-flow.html">Export</a>' : "",
    '<button id="details-toggle" type="button">Hide details</button>',
    "</div>",
    "</header>",
    '<main class="layout" id="layout">',
    `<p class="filter-empty" id="filter-empty" hidden>Nothing matches this filter.</p>`,
    `<div class="flow" id="${FLOW_CONTAINER_ID}">${renderFlowHtml(
      tree,
      live ? htmlLeaf : staticHtmlLeaf,
    )}</div>`,
    '<aside class="details" id="details"><p class="details-empty">Select a step to see its details.</p></aside>',
    "</main>",
    clientScript(live),
    "</body>",
    "</html>",
  ].join("")
}

export function renderPanelHtml(tree: FlowTree, options: PageOptions = {}): string {
  return renderPage(tree, true, options)
}

/** A standalone snapshot that keeps working after the server is gone. */
export function renderExportHtml(tree: FlowTree, options: PageOptions = {}): string {
  return renderPage(tree, false, options)
}
