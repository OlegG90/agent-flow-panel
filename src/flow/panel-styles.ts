/** The panel's stylesheet, inlined into the page — the panel ships no assets. */
export const STYLES = `
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
  --orchestration: #6b7280;
  --planned: #64748b;
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
.step-metric { font-size: 0.7rem; font-variant-numeric: tabular-nums; color: var(--muted); background: rgba(255, 255, 255, 0.04); border-radius: 4px; padding: 0.05rem 0.4rem; margin-left: 0.35rem; }
.unit-metric { font-size: 0.7rem; font-weight: 400; font-variant-numeric: tabular-nums; color: var(--muted); border: 1px solid var(--border); border-radius: 999px; padding: 0.1rem 0.5rem; margin-left: 0.4rem; }
.step-content { color: var(--muted); margin-left: 0.5rem; }
.step-reasoning { color: var(--muted); font-style: italic; margin-top: 0.25rem; font-size: 0.85rem; }
.step--user-request { border-color: var(--user-request); }
.step--model-call { border-color: var(--model-call); }
.step--model-reply { border-color: var(--model-reply); }
.step--tool-call { border-color: var(--tool-call); }
.step--tool-result { border-color: var(--tool-result); }
.step--answer { border-color: var(--answer); }
.step--subtask-summary { border-color: var(--subtask-summary); }
.step--orchestration { border-color: var(--orchestration); border-style: dashed; }
.step--planned { border-color: var(--planned); border-style: dashed; opacity: 0.55; }
.step--planned .step-label { font-weight: 400; }
.step--done { opacity: 1; }
.step--pending { opacity: 0.45; border-style: dashed; }
.step--running { opacity: 1; animation: pulse 1.6s ease-in-out infinite; }
.step--failed { border-color: var(--failed); }
/* Dimming is the point of an Orchestration node, so it has to outrank the
   state rules above. A failed one stays bright: that is the signal. */
.step--orchestration.step--done { opacity: 0.6; }
@keyframes pulse { 50% { opacity: 0.5; } }
.plan { list-style: none; padding: 0; margin: 0.75rem 0 0; display: flex; gap: 0.5rem; flex-wrap: wrap; }
.plan-item { font-size: 0.8rem; color: var(--muted); border: 1px solid var(--border); border-radius: 999px; padding: 0.2rem 0.6rem; }
.plan-item[data-state="completed"] { color: var(--model-reply); border-color: var(--model-reply); }
.plan-item[data-state="in-progress"] { color: var(--tool-call); border-color: var(--tool-call); }
.topbar { display: flex; align-items: center; justify-content: space-between; gap: 1rem; margin-bottom: 1rem; }
.topbar h1 { margin: 0; }
#details-toggle { background: var(--panel); color: var(--text); border: 1px solid var(--border); border-radius: 6px; padding: 0.3rem 0.7rem; cursor: pointer; font-size: 0.8rem; }
#details-toggle:hover { border-color: var(--selected); color: var(--selected); }
.toolbar { display: flex; align-items: center; gap: 0.4rem; flex-wrap: wrap; }
.toolbar-search { background: var(--bg); color: var(--text); border: 1px solid var(--border); border-radius: 6px; padding: 0.3rem 0.6rem; font-size: 0.8rem; min-width: 12rem; }
.toolbar-search:focus { outline: none; border-color: var(--selected); }
.toolbar-button, .toolbar-toggle { background: var(--panel); color: var(--text); border: 1px solid var(--border); border-radius: 6px; padding: 0.3rem 0.7rem; cursor: pointer; font-size: 0.8rem; text-decoration: none; display: inline-block; }
.toolbar-button:hover, .toolbar-toggle:hover { border-color: var(--selected); color: var(--selected); }
.toolbar-toggle[aria-pressed="true"] { border-color: var(--selected); color: var(--selected); background: rgba(34, 211, 238, 0.12); }
.step--hidden { display: none; }
.unit--hidden { display: none; }
.filter-empty { color: var(--muted); padding: 1rem; border: 1px dashed var(--border); border-radius: 10px; }
.step--hit > .step-label { text-decoration: underline; text-decoration-color: var(--selected); text-underline-offset: 3px; }
/* While filtering, a collapsed ancestor must not hide a match beneath it. */
.filtering .step.collapsed > .steps--nested { display: block; }
.layout { display: flex; gap: 1rem; align-items: flex-start; }
.flow { flex: 3; min-width: 0; display: flex; flex-direction: column; }
/* Newest-first is a display flip only: units keep their order in the DOM, so
   the choice survives an innerHTML replacement and never reorders steps. */
.flow.newest-first { flex-direction: column-reverse; }
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

// Only the live page talks to a server; the export must not ship this at all.
