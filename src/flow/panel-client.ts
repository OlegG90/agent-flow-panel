import { EVENTS_PATH, EXPORT_PATH, FLOW_CONTAINER_ID, NODE_PATH } from "./panel-routes.ts"

/**
 * The browser half of the panel. It ships as source text inlined into the
 * page, so it is written against the DOM directly rather than imported.
 */
const LIVE_BLOCK = `
  // Carry the page's access token (?t=…) over to the event stream.
  const source = new EventSource("${EVENTS_PATH}" + window.location.search);
  source.onmessage = (event) => {
    flow.innerHTML = event.data;
    applyCollapsed();
    applySelected();
    applyFilter();
    applyFollow();
  };
  const exportLink = document.getElementById("export-link");
  if (exportLink) exportLink.href = "${EXPORT_PATH}" + window.location.search;
`

export function clientScript(live: boolean): string {
  return `
<script>
(() => {
  const LIVE = ${live ? "true" : "false"};
  const flow = document.getElementById("${FLOW_CONTAINER_ID}");
  const details = document.getElementById("details");
  const layout = document.getElementById("layout");
  const detailsToggle = document.getElementById("details-toggle");
  const search = document.getElementById("filter-search");
  const failedToggle = document.getElementById("filter-failed");
  const followToggle = document.getElementById("follow-toggle");
  const filterEmpty = document.getElementById("filter-empty");
  const orderToggle = document.getElementById("order-toggle");
  const collapseAll = document.getElementById("collapse-all");
  const expandAll = document.getElementById("expand-all");
  if (!flow || !details || !layout || !detailsToggle) return;
  const collapsed = new Set();
  let selectedId = null;
  let loadedFor = null;
  let loadedState = null;
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
  const renderDetails = (step, node) => {
    const type = step.getAttribute("data-type") || "";
    const state = step.getAttribute("data-state") || "";
    const labelEl = step.querySelector(".step-label");
    const label = node && node.label ? node.label : labelEl ? labelEl.textContent : "";
    const content = node ? node.content || "" : "";
    const reasoning = node ? node.reasoning || "" : "";
    const header =
      '<div class="details-header">' +
      '<span class="details-type step--' + esc(type) + '">' + esc(type) + "</span>" +
      '<span class="details-state">' + esc(state) + "</span></div>";
    const body =
      '<div class="details-label">' + esc(label) + "</div>" +
      '<div class="details-id">' + esc(step.getAttribute("data-id") || "") + "</div>";
    const contentSection = content
      ? '<div class="details-section"><h3>Content</h3><div class="details-content">' + esc(content) + "</div></div>"
      : "";
    const reasoningSection = reasoning
      ? '<div class="details-section"><h3>Reasoning</h3><div class="details-reasoning">' + esc(reasoning) + "</div></div>"
      : "";
    details.innerHTML = header + body + contentSection + reasoningSection;
  };
  // Content is no longer in the frame; fetch the selected node on demand.
  const loadDetails = (step) => {
    const id = step.getAttribute("data-id");
    if (!id) return;
    loadedFor = id;
    loadedState = step.getAttribute("data-state");
    if (!LIVE) {
      // A saved page has no server: the export inlines what it needs.
      renderDetails(step, {
        label: "",
        content: step.getAttribute("data-content") || "",
        reasoning: step.getAttribute("data-reasoning") || "",
      });
      return;
    }
    if (step.getAttribute("data-detail") !== "1") {
      renderDetails(step, null);
      return;
    }
    fetch("${NODE_PATH}" + window.location.search + "&id=" + encodeURIComponent(id))
      .then((response) => (response.ok ? response.json() : null))
      .then((node) => {
        if (selectedId === id) renderDetails(step, node);
      })
      .catch(() => {
        if (selectedId === id) renderDetails(step, null);
      });
  };
  const applySelected = () => {
    if (!selectedId) return;
    const step = flow.querySelector('[data-id="' + selectedId + '"]');
    if (!step) {
      selectedId = null;
      loadedFor = null;
      emptyDetails();
      return;
    }
    step.classList.add("step--selected");
    // Refetch only when the step moved on: a running tool keeps growing, a
    // finished one does not, and refetching per frame would undo the win.
    if (loadedFor !== selectedId || loadedState !== step.getAttribute("data-state")) {
      loadDetails(step);
    }
  };
  const select = (step) => {
    const id = step.getAttribute("data-id");
    const previous = flow.querySelector(".step--selected");
    if (previous) previous.classList.remove("step--selected");
    if (selectedId === id) {
      selectedId = null;
      loadedFor = null;
      emptyDetails();
      return;
    }
    selectedId = id;
    step.classList.add("step--selected");
    layout.classList.remove("details-hidden");
    detailsToggle.textContent = "Hide details";
    loadDetails(step);
  };
  // A long session is unreadable without a way to narrow it down. Filtering
  // works on what the frame carries: labels and content previews.
  const applyFilter = () => {
    const query = search ? search.value.trim().toLowerCase() : "";
    const failedOnly = failedToggle && failedToggle.getAttribute("aria-pressed") === "true";
    const steps = flow.querySelectorAll(".step");
    const units = flow.querySelectorAll(".unit");
    for (const step of steps) step.classList.remove("step--hidden", "step--hit");
    for (const unit of units) unit.classList.remove("unit--hidden");
    const active = Boolean(query) || Boolean(failedOnly);
    flow.classList.toggle("filtering", active);
    if (filterEmpty) filterEmpty.hidden = true;
    if (!active) return;
    for (const step of steps) {
      const label = step.querySelector(":scope > .step-label");
      const preview = step.querySelector(":scope > .step-content");
      // The node type is searchable too, so "orchestration" or "answer" finds
      // those steps even though the word never appears in their label.
      const hay = (
        (label ? label.textContent : "") + " " +
        (preview ? preview.textContent : "") + " " +
        (step.getAttribute("data-type") || "")
      ).toLowerCase();
      const textOk = !query || hay.indexOf(query) !== -1;
      const stateOk = !failedOnly || step.getAttribute("data-state") === "failed";
      if (textOk && stateOk) step.classList.add("step--hit");
    }
    // An ancestor of a hit stays visible so the hit keeps its context.
    for (const step of steps) {
      if (!step.classList.contains("step--hit") && !step.querySelector(".step--hit")) {
        step.classList.add("step--hidden");
      }
    }
    // A unit whose every step is hidden would otherwise render as an empty
    // heading, so a filter with few matches left a wall of blank boxes.
    let matched = 0;
    for (const unit of units) {
      const hit = unit.querySelector(".step--hit");
      unit.classList.toggle("unit--hidden", !hit);
      if (hit) matched += 1;
    }
    if (filterEmpty) filterEmpty.hidden = matched > 0;
  };
  const applyFollow = () => {
    if (!followToggle || followToggle.getAttribute("aria-pressed") !== "true") return;
    const running = flow.querySelectorAll('[data-state="running"]');
    const last = running[running.length - 1];
    if (last) last.scrollIntoView({ block: "nearest" });
  };
  const setAllCollapsed = (value) => {
    collapsed.clear();
    for (const step of flow.querySelectorAll(".step.has-children")) {
      const id = step.getAttribute("data-id");
      step.classList.toggle("collapsed", value);
      if (value && id) collapsed.add(id);
    }
  };
${live ? LIVE_BLOCK : ""}
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
  // Units read oldest-first by default, the order they happened in. On a long
  // session the newest work is the reason the panel is open, so it can be
  // flipped to the top instead.
  const applyOrder = () => {
    const newestFirst = orderToggle && orderToggle.getAttribute("aria-pressed") === "true";
    flow.classList.toggle("newest-first", Boolean(newestFirst));
    if (orderToggle) orderToggle.textContent = newestFirst ? "Oldest first" : "Newest first";
  };
  if (search) search.addEventListener("input", applyFilter);
  const pressToggle = (button, after) => {
    if (!button) return;
    button.addEventListener("click", () => {
      const next = button.getAttribute("aria-pressed") !== "true";
      button.setAttribute("aria-pressed", String(next));
      if (after) after(next);
    });
  };
  pressToggle(failedToggle, applyFilter);
  pressToggle(followToggle, applyFollow);
  pressToggle(orderToggle, applyOrder);
  if (collapseAll) collapseAll.addEventListener("click", () => setAllCollapsed(true));
  if (expandAll) expandAll.addEventListener("click", () => setAllCollapsed(false));
})();
</script>
`
}

/**
 * `live: false` renders a self-contained snapshot: content inlined, no event
 * stream, no export button — what /export hands the user to keep or share.
 */
