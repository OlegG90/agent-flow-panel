// src/adapters/pi/extension.ts
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Type } from "typebox";

// src/flow/render.ts
var FLOW_CONTAINER_ID = "flow";
var EVENTS_PATH = "/events";
var STATE_LABEL = {
  pending: "pending",
  running: "running",
  completed: "done",
  failed: "failed"
};
function truncate(text, max = 80) {
  const compact = text.replace(/\s+/g, " ").trim();
  return compact.length > max ? `${compact.slice(0, max)}\u2026` : compact;
}
function escapeHtml(value) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}
function attrEscape(value) {
  return escapeHtml(value).replaceAll("\n", "&#10;");
}
function walk(node, depth, leaf) {
  const inner = node.children.map((child) => walk(child, depth + 1, leaf)).join("");
  return leaf({ node, inner, depth });
}
function textLeaf({ node, inner, depth }) {
  const pad = "  ".repeat(depth);
  const content = node.content.length > 0 ? `: ${truncate(node.content)}` : "";
  const lines = [`${pad}[${STATE_LABEL[node.state]}] ${node.label}${content}`];
  if (node.reasoning) {
    lines.push(`${pad}  \u21B3 reasoning: ${truncate(node.reasoning)}`);
  }
  if (inner) {
    lines.push(inner);
  }
  return lines.join("\n");
}
function htmlLeaf({ node, inner }) {
  const hasChildren = inner ? " has-children" : "";
  const subtaskClass = node.subtask ? " step--subtask" : "";
  const toggle = inner ? '<button class="step-toggle" type="button" aria-label="Toggle">\u25BE</button>' : "";
  const badge = node.subtask ? '<span class="step-badge">sub-agent</span>' : "";
  const contentAttr = node.content.length > 0 ? ` data-content="${attrEscape(node.content)}"` : "";
  const reasoningAttr = node.reasoning ? ` data-reasoning="${attrEscape(node.reasoning)}"` : "";
  const parts = [
    `<li class="step step--${node.type} step--${STATE_LABEL[node.state]}${hasChildren}${subtaskClass}" data-id="${escapeHtml(node.id)}" data-type="${node.type}" data-state="${node.state}"${contentAttr}${reasoningAttr}>`,
    toggle,
    `<span class="step-label">${escapeHtml(node.label)}</span>`,
    badge,
    `<span class="step-state">${STATE_LABEL[node.state]}</span>`
  ];
  if (node.content.length > 0) {
    parts.push(`<span class="step-content">${escapeHtml(truncate(node.content, 120))}</span>`);
  }
  if (node.reasoning) {
    parts.push(`<div class="step-reasoning">${escapeHtml(truncate(node.reasoning))}</div>`);
  }
  if (inner) {
    parts.push(`<ol class="steps steps--nested">${inner}</ol>`);
  }
  parts.push("</li>");
  return parts.join("");
}
function renderPlan(plan, format) {
  if (plan.length === 0) {
    return "";
  }
  if (format === "text") {
    return `  Plan:
${plan.map((item) => `    [${item.state}] ${item.title}`).join("\n")}`;
  }
  return `<ul class="plan">${plan.map(
    (item) => `<li class="plan-item" data-state="${item.state}">${escapeHtml(item.title)}</li>`
  ).join("")}</ul>`;
}
function unitText(unit, index) {
  const lines = [`Unit of Work #${index + 1}: ${truncate(unit.request.content)}`];
  lines.push(walk(unit.request, 1, textLeaf));
  for (const step of unit.steps) {
    lines.push(walk(step, 1, textLeaf));
  }
  const plan = renderPlan(unit.plan, "text");
  if (plan) {
    lines.push(plan);
  }
  return lines.join("\n");
}
function unitHtml(unit, index) {
  return [
    '<section class="unit">',
    `<h2 class="unit-title">Unit of Work #${index + 1}</h2>`,
    renderPlan(unit.plan, "html"),
    `<ol class="steps">${walk(unit.request, 0, htmlLeaf)}${unit.steps.map((step) => walk(step, 0, htmlLeaf)).join("")}</ol>`,
    "</section>"
  ].join("");
}
function renderTree(tree) {
  const lines = [];
  for (const [index, unit] of tree.units.entries()) {
    lines.push(unitText(unit, index));
    lines.push("");
  }
  return lines.join("\n").trimEnd() || "(no flow recorded)";
}
function renderFlowHtml(tree) {
  const units = tree.units.map((unit, index) => unitHtml(unit, index)).join("");
  const empty = tree.units.length === 0 ? '<p class="empty">No flow recorded yet.</p>' : "";
  return units + empty;
}
var STYLES = `
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
`;
var CLIENT_SCRIPT = `
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
`;
function renderPanelHtml(tree) {
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
    "</html>"
  ].join("");
}

// src/server/panel-server.ts
import http from "node:http";
function sseData(data) {
  return `data: ${data}

`;
}
function createPanelServer(deps) {
  let boundPort = 0;
  const clients = /* @__PURE__ */ new Set();
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);
    if (url.pathname === "/") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(renderPanelHtml(deps.getTree()));
      return;
    }
    if (url.pathname === "/data") {
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(deps.getTree()));
      return;
    }
    if (url.pathname === EVENTS_PATH) {
      res.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache",
        connection: "keep-alive"
      });
      res.write(": connected\n\n");
      res.write(sseData(renderFlowHtml(deps.getTree())));
      clients.add(res);
      req.on("close", () => clients.delete(res));
      return;
    }
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("not found");
  });
  return {
    async start() {
      if (server.listening) {
        return;
      }
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => {
          server.removeListener("error", reject);
          resolve();
        });
      });
      const address = server.address();
      if (address && typeof address === "object") {
        boundPort = address.port;
      }
    },
    url() {
      return `http://127.0.0.1:${boundPort}/`;
    },
    publish() {
      if (clients.size === 0) {
        return;
      }
      const payload = sseData(renderFlowHtml(deps.getTree()));
      for (const client of clients) {
        try {
          client.write(payload);
        } catch {
        }
      }
    },
    async close() {
      if (!server.listening) {
        return;
      }
      for (const client of clients) {
        client.end();
      }
      clients.clear();
      await new Promise((resolve) => server.close(() => resolve()));
    }
  };
}

// src/adapters/pi/pi-reducer.ts
function makeNode(id, type, label, state, content = "") {
  return { id, type, label, state, content, children: [] };
}
var SUBTASK_TOOLS = {
  oh_my_pi_delegate_task: true,
  oh_my_pi_subagent: true
};
var PiFlowStore = class {
  sessionID;
  units = [];
  openUnit = null;
  toolNodes = /* @__PURE__ */ new Map();
  pendingRequest = "";
  constructor(sessionID) {
    this.sessionID = sessionID;
  }
  tree() {
    return {
      sessionID: this.sessionID,
      units: this.units.map((unit) => ({
        id: unit.id,
        request: structuredClone(unit.request),
        steps: structuredClone(unit.steps),
        plan: unit.plan.map((item) => ({ ...item }))
      }))
    };
  }
  // Called from before_agent_start — user prompt becomes Unit
  startUnit(id, prompt) {
    this.closeOpenUnit();
    const unit = {
      id,
      request: makeNode(`ur-${id}`, "user-request", "User request", "completed", prompt),
      steps: [],
      plan: [],
      turns: [],
      closed: false
    };
    this.units.push(unit);
    this.openUnit = unit;
    this.toolNodes.clear();
    this.pendingRequest = "";
  }
  ensureOpenUnit(id) {
    if (!this.openUnit) {
      this.startUnit(id, this.pendingRequest || "(unknown request)");
      this.pendingRequest = "";
    }
    return this.openUnit;
  }
  setPendingRequest(text) {
    if (!this.openUnit) {
      this.pendingRequest = text;
    }
  }
  startTurn(turnId) {
    const unit = this.ensureOpenUnit(turnId);
    if (unit.turns.find((t) => t.id === turnId)) return;
    const modelCall = makeNode(`mc-${turnId}`, "model-call", "Model call", "running");
    const modelReply = makeNode(`mr-${turnId}`, "model-reply", "Model reply", "running");
    modelCall.children.push(modelReply);
    unit.steps.push(modelCall);
    unit.turns.push({ id: turnId, modelCall, modelReply, text: "", reasoning: "" });
  }
  appendAssistantText(turnId, delta, reasoningDelta) {
    const unit = this.openUnit;
    if (!unit) return;
    let turn = unit.turns.find((t) => t.id === turnId);
    if (!turn) {
      this.startTurn(turnId);
      turn = unit.turns.find((t) => t.id === turnId);
      if (!turn) return;
    }
    if (delta) {
      turn.text += delta;
      turn.modelReply.content = turn.text;
    }
    if (reasoningDelta) {
      turn.reasoning += reasoningDelta;
      turn.modelReply.reasoning = turn.reasoning;
    }
  }
  finishTurn(turnId) {
    const turn = this.openUnit?.turns.find((t) => t.id === turnId);
    if (turn) {
      turn.modelCall.state = "completed";
      turn.modelReply.state = "completed";
    }
  }
  // Pi: tool_call event — before execution, can mutate input. We create ToolCall node.
  onToolCall(toolCallId, toolName, turnId) {
    let node = this.toolNodes.get(toolCallId);
    if (node) return node;
    const unit = this.ensureOpenUnit(turnId);
    let turn = unit.turns.find((t) => t.id === turnId);
    if (!turn) {
      this.startTurn(turnId);
      turn = unit.turns.find((t) => t.id === turnId);
    }
    const isSubtask = SUBTASK_TOOLS[toolName] === true;
    const label = isSubtask ? `Sub-agent: ${toolName}` : `Tool: ${toolName}`;
    node = makeNode(`tc-${toolCallId}`, "tool-call", label, "running");
    if (isSubtask) node.subtask = true;
    this.toolNodes.set(toolCallId, node);
    turn.modelReply.children.push(node);
    return node;
  }
  // Pi: tool_result / tool_execution_end
  onToolResult(toolCallId, toolName, result, isError) {
    const node = this.toolNodes.get(toolCallId);
    if (!node) {
      this.onToolCall(toolCallId, toolName, toolCallId);
      return this.onToolResult(toolCallId, toolName, result, isError);
    }
    if (isError) {
      node.state = "failed";
      node.content = String(result ?? "error");
      return;
    }
    node.state = "completed";
    if (!node.subtask) {
      const text = typeof result === "string" ? result : JSON.stringify(result ?? "");
      node.content = text.slice(0, 2e3);
      const hasResult = node.children.some((c) => c.type === "tool-result");
      if (!hasResult) {
        node.children.push(
          makeNode(`tr-${node.id}`, "tool-result", `Result: ${toolName}`, "completed", node.content)
        );
      }
    } else {
      if (result !== null && typeof result === "object" && "task" in result && typeof result.task === "string") {
        node.content = result.task;
      } else if (result !== null && typeof result === "object" && "content" in result && typeof result.content === "string") {
        node.content = result.content;
      } else if (typeof result === "string") {
        node.content = result.slice(0, 500);
      }
    }
  }
  // Update running state explicitly (tool_execution_start)
  markToolRunning(toolCallId) {
    const node = this.toolNodes.get(toolCallId);
    if (node && node.state === "pending") node.state = "running";
  }
  closeOpenUnit() {
    const unit = this.openUnit;
    if (!unit || unit.closed) return;
    unit.closed = true;
    const last = unit.turns.at(-1);
    if (last) {
      this.finishTurn(last.id);
      const text = last.text.trim();
      if (text.length > 0) {
        unit.steps.push(makeNode(`ans-${unit.id}`, "answer", "Answer", "completed", text));
      }
    }
    this.openUnit = null;
  }
};

// src/adapters/pi/pi-session-tracker.ts
var PiSessionTracker = class {
  stores = /* @__PURE__ */ new Map();
  activeSessionID;
  listener;
  dispatchBySession(sessionID, fn) {
    let store = this.stores.get(sessionID);
    if (!store) {
      store = new PiFlowStore(sessionID);
      this.stores.set(sessionID, store);
    }
    fn(store);
    this.listener?.();
  }
  tree(sessionID) {
    const id = sessionID ?? this.activeSessionID;
    if (!id) return { sessionID: "", units: [] };
    const store = this.stores.get(id);
    return store ? store.tree() : { sessionID: id, units: [] };
  }
  setActiveSession(sessionID) {
    this.activeSessionID = sessionID;
  }
  reset() {
    this.stores.clear();
    this.activeSessionID = void 0;
  }
  onUpdate(listener) {
    this.listener = listener;
  }
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  graftChildIntoParent(_parentID, _childID) {
  }
};

// src/adapters/pi/extension.ts
var execFileAsync = promisify(execFile);
async function openInBrowser(url) {
  if (process.platform === "win32") {
    await execFileAsync("cmd", ["/c", "start", "", url]);
    return;
  }
  const opener = process.platform === "darwin" ? "open" : "xdg-open";
  await execFileAsync(opener, [url]);
}
function stringField(value, key) {
  if (value !== null && typeof value === "object" && key in value) {
    const candidate = value[key];
    return typeof candidate === "string" ? candidate : void 0;
  }
  return void 0;
}
function numberField(value, key) {
  if (value !== null && typeof value === "object" && key in value) {
    const candidate = value[key];
    return typeof candidate === "number" ? candidate : void 0;
  }
  return void 0;
}
function objectField(value, key) {
  if (value !== null && typeof value === "object" && key in value) {
    const candidate = value[key];
    return candidate !== null && typeof candidate === "object" ? candidate : void 0;
  }
  return void 0;
}
function piExtension(pi) {
  const tracker = new PiSessionTracker();
  const panelServer = createPanelServer({
    getTree: () => tracker.tree()
  });
  tracker.onUpdate(() => panelServer.publish());
  async function openPanel(sessionID, reset) {
    if (reset) tracker.reset();
    tracker.setActiveSession(sessionID);
    await panelServer.start();
    const url = panelServer.url();
    await openInBrowser(url);
    return url;
  }
  pi.on("before_agent_start", async (event, ctx) => {
    const prompt = stringField(event, "prompt") ?? "";
    const sid = ctx.sessionManager.getSessionId() ?? prompt.slice(0, 32);
    tracker.setActiveSession(sid);
    tracker.dispatchBySession(sid, (store) => {
      const unitId = `pi-${Date.now()}`;
      store.startUnit(unitId, prompt);
    });
  });
  pi.on("turn_start", async (event, ctx) => {
    const turnIndex = numberField(event, "turnIndex") ?? 0;
    const sid = ctx.sessionManager.getSessionId() ?? "default";
    tracker.dispatchBySession(sid, (store) => store.startTurn(String(turnIndex)));
  });
  pi.on("message_update", async (event, ctx) => {
    const sid = ctx.sessionManager.getSessionId() ?? "default";
    const msg = objectField(event, "message");
    if (!msg || msg["role"] !== "assistant") return;
    const turnIndex = numberField(event, "turnIndex");
    let turnId = "0";
    if (turnIndex !== void 0) turnId = String(turnIndex);
    else {
      const id = stringField(msg, "id");
      if (id) turnId = id;
    }
    const assistantMessageEvent = objectField(event, "assistantMessageEvent");
    const delta = assistantMessageEvent ? stringField(assistantMessageEvent, "delta") ?? "" : "";
    const content = stringField(msg, "content") ?? "";
    tracker.dispatchBySession(sid, (store) => store.appendAssistantText(turnId, delta || content));
  });
  pi.on("tool_call", async (event, ctx) => {
    const sid = ctx.sessionManager.getSessionId() ?? "default";
    const toolCallId = stringField(event, "toolCallId") ?? "unknown";
    const toolName = stringField(event, "toolName") ?? "unknown";
    const turnIndex = numberField(event, "turnIndex");
    const turnId = turnIndex !== void 0 ? String(turnIndex) : "0";
    tracker.dispatchBySession(sid, (store) => {
      store.onToolCall(toolCallId, toolName, turnId);
    });
  });
  pi.on("tool_result", async (event, ctx) => {
    const sid = ctx.sessionManager.getSessionId() ?? "default";
    const toolCallId = stringField(event, "toolCallId") ?? "unknown";
    const toolName = stringField(event, "toolName") ?? "unknown";
    let content = objectField(event, "details") ?? "";
    if (event !== null && typeof event === "object" && "content" in event) {
      const candidate = event["content"];
      if (candidate !== void 0) content = candidate;
    }
    let isError = false;
    if (event !== null && typeof event === "object" && "isError" in event) {
      const candidate = event["isError"];
      if (typeof candidate === "boolean") isError = candidate;
    }
    tracker.dispatchBySession(sid, (store) => {
      store.onToolResult(toolCallId, toolName, content, isError);
    });
  });
  pi.on("tool_execution_start", async (event, ctx) => {
    const sid = ctx.sessionManager.getSessionId() ?? "default";
    const toolCallId = stringField(event, "toolCallId");
    if (!toolCallId) return;
    tracker.dispatchBySession(sid, (store) => store.markToolRunning(toolCallId));
  });
  pi.on("turn_end", async (event, ctx) => {
    const sid = ctx.sessionManager.getSessionId() ?? "default";
    const turnIndex = numberField(event, "turnIndex") ?? 0;
    tracker.dispatchBySession(sid, (store) => store.finishTurn(String(turnIndex)));
  });
  pi.on("agent_end", async (_event, ctx) => {
    const sid = ctx.sessionManager.getSessionId() ?? "default";
    tracker.dispatchBySession(sid, (store) => store.closeOpenUnit());
  });
  pi.on("agent_settled", async (_event, ctx) => {
    const sid = ctx.sessionManager.getSessionId() ?? "default";
    tracker.dispatchBySession(sid, (store) => store.closeOpenUnit());
  });
  pi.on("session_shutdown", async () => {
    await panelServer.close();
  });
  pi.registerCommand("flow", {
    description: "Open the Agent Flow panel (keep history)",
    handler: async (_args, ctx) => {
      const sid = ctx.sessionManager.getSessionId() ?? "default";
      const url = await openPanel(sid, false);
      ctx.ui.notify(`Agent Flow panel: ${url}`, "info");
    }
  });
  pi.registerCommand("flow-reset", {
    description: "Open the Agent Flow panel from scratch",
    handler: async (_args, ctx) => {
      const sid = ctx.sessionManager.getSessionId() ?? "default";
      const url = await openPanel(sid, true);
      ctx.ui.notify(`Agent Flow panel (reset): ${url}`, "info");
    }
  });
  pi.registerTool({
    name: "flow_panel",
    label: "Flow Panel",
    description: "Open the Agent Flow panel in the default browser, starting fresh from this moment.",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      const sid = ctx.sessionManager.getSessionId() ?? "default";
      const url = await openPanel(sid, true);
      return { content: [{ type: "text", text: `Opened ${url}` }], details: { url } };
    }
  });
  pi.registerTool({
    name: "flow_open",
    label: "Flow Panel (keep)",
    description: "Open the Agent Flow panel in the default browser, keeping the current view.",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      const sid = ctx.sessionManager.getSessionId() ?? "default";
      const url = await openPanel(sid, false);
      return { content: [{ type: "text", text: `Opened ${url}` }], details: { url } };
    }
  });
  pi.registerTool({
    name: "flow_tree",
    label: "Flow Tree",
    description: "Show the Agent Flow step tree for this session as text.",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      const sid = ctx.sessionManager.getSessionId() ?? "default";
      const tree = tracker.tree(sid);
      const text = tree.units.length > 0 ? renderTree(tree) : "No flow data recorded for this session.";
      return { content: [{ type: "text", text }], details: {} };
    }
  });
}
export {
  piExtension as default
};
