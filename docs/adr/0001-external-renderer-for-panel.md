# External renderer for the live panel

The desktop app (Electron, SolidJS web UI) exposes no plugin UI surface: no slots, routes, or webview injection, `client.tui.*` actions are ignored there, and no `client.desktop.*` API exists. The live panel is therefore rendered as a browser page served by a local HTTP server owned by the plugin, opened on demand via a plugin command.

Considered and rejected: an in-app desktop panel (blocked by the absent plugin API), TUI slots/routes (run only in the terminal TUI, not the desktop app), chat-embedded diagrams (not a live panel).
