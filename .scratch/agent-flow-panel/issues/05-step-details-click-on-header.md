# 05 - Step details open on header click, not only label

**Status:** resolved

**Context:** Clicking the step header (entire li.step header) should open details in aside#details. Currently it only works on span.step-label (src/flow/panel-client.ts:210-213). The general view shows step-content/step-metric/step-state as previews, so the user clicks visible header content and nothing happens. Verified live on http://127.0.0.1:58169/?t=dbe0003... and re-verified on http://127.0.0.1:62237/?t=34511cc... via browser snapshot/click: label click selects, content/padding click does not.

**What to build:**
- [x] Extend flow click handler in src/flow/panel-client.ts:197-214 to select any click on li.step (except .step-toggle)
- [x] Add cursor: pointer for .step in src/flow/panel-styles.ts:42 for affordance
- [x] Update test in src/flow/render.test.ts - header click should also open details
- [x] Verify data-detail=1 / /node logic still works

**Blocked by:** 04

**Refs:** src/flow/panel-client.ts:197-214, src/flow/render.ts:230-267, src/flow/panel-styles.ts:42, src/flow/panel-client.test.ts:214-222

## Comments
Reported from live panel http://127.0.0.1:58169/?t=dbe0003... and re-verified on http://127.0.0.1:62237/?t=34511cc... via browser snapshot/click: label click works, content/padding click does not.

Fixed: src/flow/panel-client.ts:197-214 now uses event.target.closest(".step") (with flow.contains guard) instead of .step-label; toggle handler kept as early return. src/flow/panel-styles.ts:42 adds cursor: pointer to .step. Test src/flow/render.test.ts:689 updated to assert new selector + select(step). Verified live + npm test 207/207, typecheck/lint clean.
