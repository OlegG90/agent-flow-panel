# 02 — Session hierarchy and child completion in the tracker

**What to build:** The session tracker learns parent-child relationships from session creation events (recording children in creation order) and tracks which child sessions have finished, so the panel knows when a sub-agent's work is done.

**Blocked by:** None — can start immediately.

**Status:** resolved

- [x] session.created with a parent records the child in creation order
- [x] A child session's idle is recorded as finished
- [x] Existing routing (message, part, todo, idle events) is unchanged

## Comments

The tracker now handles `session.created` (records `childrenOf[parent]` in creation order, without hijacking the active session) and tracks `idleSessions` from `session.idle`. `sessionIDOf` covers session.created/updated (`info.id`).
