# OpenCode Plugin System — Research Report (FACTS ONLY)

Researched: 2026-08-13. Environment: Windows 10/11, PowerShell 5.1.
Repo under study: `C:\Workspace\Sandbox\Projects\Opencode_Plg` (empty git repo, intended to become an OpenCode plugin in TypeScript).

Sources are primary: official docs, npm registry metadata, and the opencode source at
`https://github.com/anomalyco/opencode` (branch `dev` and tag `v1.18.16`).

Version caveat up front: the installed binary is **1.18.16**; the live docs site and the latest
published npm packages describe **1.18.18**. Where facts were verified to be identical between
`v1.18.16` and `dev` (plugin loader, plugin shared helpers, storage service), this is stated.
The **v2** APIs below (`@opencode-ai/sdk/v2`, `@opencode-ai/plugin/v2`, TUI plugin API) are newer
and were verified against the `dev` branch / published packages, not against the installed binary.

---

## 1. Installed OpenCode version

| Check | Result |
|---|---|
| `opencode --version` | `1.18.16` |
| `npm ls -g opencode-ai` | not installed (npm global is empty) |
| `where.exe opencode` | `C:\Users\OlegG\AppData\Local\Microsoft\WinGet\Packages\SST.opencode_Microsoft.Winget.Source_8wekyb3d8bbwe\opencode.exe` (installed via WinGet) |
| `~/.config/opencode/` | exists (contains `opencode.jsonc`, `package.json`, `skills/`, `node_modules/`) |
| `~/.local/share/opencode/` | exists (contains `opencode.db`, `opencode.db-shm`, `opencode.db-wal`, `auth.json`, `log/`, `repos/`, `snapshot/`, `storage/`, `tool-output/`) |
| `~/.cache/opencode/` | exists (`bin/rg.exe`, `packages/`, `models.json`) |

Notes:

- A live opencode server appears to be running (the SQLite DB `opencode.db` is file-locked; WAL files present).
- The global config `~/.config/opencode/package.json` depends on `@opencode-ai/plugin@1.18.15`.
- `~/.cache/opencode/packages/` contains an installed npm plugin `oh-my-opencode-slim@2.2.13`
  (this is the cache directory opencode uses for npm plugins; the docs also mention
  `~/.cache/opencode/node_modules/`).
- Release `v1.18.16` published 2026-08-10 (GitHub releases: https://github.com/anomalyco/opencode/releases/tag/v1.18.16).

---

## 2. Plugin API surface

### 2.1 What a plugin module looks like

Docs: https://opencode.ai/docs/plugins (Create a plugin).

- A plugin is a **JavaScript/TypeScript module** that exports plugin functions. Each plugin function
  receives a context object and returns a hooks object.
- Plugin context (docs "Basic structure"; exact type `PluginInput` in
  `packages/plugin/src/index.ts`): `project`, `directory`, `worktree`, `client` (an opencode SDK
  client), `$` (Bun's shell API), plus `experimental_workspace`, `serverUrl`.
- TypeScript type import (docs):

  ```ts
  import type { Plugin } from "@opencode-ai/plugin"
  ```

- The docs examples use **named exports** of async functions, e.g.
  `export const MyPlugin = async (ctx) => { return { /* hooks */ } }`.

### 2.2 Actual module contract enforced by the loader (source-verified)

Source: `packages/opencode/src/plugin/index.ts` and `packages/opencode/src/plugin/shared.ts`
(identical between `v1.18.16` and `dev`).

The loader (`PluginLoader`) imports the module via `await import(row.entry)`
(`packages/opencode/src/plugin/loader.ts`, `load()`), then accepts either form:

1. **v1 plugin module** (preferred): the module has a **default export object**
   `{ id?, server?, tui? }` where `server`/`tui` is a `Plugin` function. Type:

   ```ts
   export type Plugin = (input: PluginInput, options?: PluginOptions) => Promise<Hooks>
   export type PluginModule = { id?: string; server: Plugin; tui?: never }
   export type TuiPluginModule = { id?: string; tui: TuiPlugin; server?: never }
   ```

   (`packages/plugin/src/index.ts`, `packages/plugin/src/tui.ts`). A module must export **either**
   `server()` or `tui()`, not both.
2. **Legacy form**: every named export of the module that is a function is treated as a server
   plugin (`getLegacyPlugins()` in `packages/opencode/src/plugin/index.ts`). This is the form the
   docs' "Basic structure" examples use.

File/path plugins must export an `id`; npm plugins default to their package name
(`resolvePluginId()` in `packages/opencode/src/plugin/shared.ts`).

### 2.3 The hooks object (what keys a plugin can return)

Source: `packages/plugin/src/index.ts` (`export interface Hooks`), identical for v1.18.16 and dev.

Keys (each optional, all `Promise<void>` where shown):

- `dispose?: () => Promise<void>`
- `event?: (input: { event: Event }) => Promise<void>` — subscribe to every server event (see §3)
- `config?: (input: Config) => Promise<void>` — called with the merged config
- `tool?: { [name]: ToolDefinition }` — add custom tools (via the `tool()` helper, `@opencode-ai/plugin/tool`)
- `auth?: AuthHook`
- `provider?: ProviderHook`
- `"chat.message"?: (input, output) => Promise<void>` — called when a new message is received; input `{ sessionID, agent?, model?, messageID?, variant? }`, output `{ message, parts }`
- `"chat.params"?: ...` — modify LLM request params; input `{ sessionID, agent, model, provider, message }`, output `{ temperature, topP, topK, maxOutputTokens, options }`
- `"chat.headers"?: ...` — output `{ headers }`
- `"permission.ask"?: (input: Permission, output: { status: "ask" | "deny" | "allow" })`
- `"command.execute.before"?: (input: { command, sessionID, arguments }, output: { parts })`
- `"tool.execute.before"?: (input: { tool, sessionID, callID }, output: { args })`
- `"shell.env"?: (input: { cwd, sessionID?, callID? }, output: { env })`
- `"tool.execute.after"?: (input: { tool, sessionID, callID, args }, output: { title, output, metadata })`
- `"tool.definition"?: (input: { toolID }, output: { description, parameters })`
- `"experimental.chat.messages.transform"?: ...`
- `"experimental.chat.system.transform"?: ...`
- `"experimental.provider.small_model"?: ...`
- `"experimental.session.compacting"?: (input: { sessionID }, output: { context, prompt? })`
- `"experimental.compaction.autocontinue"?: ...`
- `"experimental.text.complete"?: (input: { sessionID, messageID, partID }, output: { text })`

Docs list the same hook/event categories on https://opencode.ai/docs/plugins (Events section).

Custom tools are added with the `tool()` helper from `@opencode-ai/plugin`:

```ts
import { type Plugin, tool } from "@opencode-ai/plugin"
// returns { description, args (zod schema), execute(args, context) }
```

`tool.schema = z` (zod); `ToolContext` gives `{ sessionID, messageID, agent, directory, worktree, abort, metadata(), ask() }`
(`packages/plugin/src/tool.ts`). Plugin tools override built-in tools with the same name (docs).

### 2.4 Config schema — how a plugin is enabled

Docs: https://opencode.ai/docs/config (Plugins section) and https://opencode.ai/docs/plugins (Use a plugin).

Two loading mechanisms:

1. **Local files**: `.opencode/plugins/` (project) and `~/.config/opencode/plugins/` (global).
   Any `*.ts`/`*.js` file there is loaded at startup. Glob used: `{plugin,plugins}/*.{ts,js}`
   (`packages/opencode/src/config/plugin.ts`).
2. **npm packages / file paths via config**: the top-level `plugin` array in `opencode.json`:

   ```json
   { "plugin": ["opencode-helicone-session", "@my-org/custom-plugin"] }
   ```

   The `plugin` array items are either a string spec or `[spec, optionsObject]` tuples
   (type `Config.plugin?: Array<string | [string, PluginOptions]>`, `packages/plugin/src/index.ts`).
   Path specs (`file://`, `.`-relative, absolute) are resolved relative to the config file that
   declares them (`packages/opencode/src/config/plugin.ts`).

Load order (docs): global config → project config → global plugin dir → project plugin dir.

Npm plugins are installed automatically with Bun at startup and cached (docs say
`~/.cache/opencode/node_modules/`; observed cache dir on this machine: `~/.cache/opencode/packages/`).
Load paths are also supported for the TUI: the `tui.json` schema (https://opencode.ai/tui.json) has
a `plugin` array (same `string | [string, object]` shape) and a `plugin_enabled` map.

### 2.5 package.json declaration for an npm plugin (source-verified)

From the published package `oh-my-opencode-slim@2.2.13` installed in
`~/.cache/opencode/packages/` (real-world example) and the entry-point resolution code in
`packages/opencode/src/plugin/shared.ts`:

- The loader looks for the entry in the package `exports` map at **`./server`** and **`./tui`**
  subpaths; falls back to `main` for the server kind only.
- `readPluginPackage()` reads `package.json` of the resolved target.
- `engines.opencode` (semver range) is checked against the running opencode version for npm
  plugins only (`checkPluginCompatibility()`).
- Example observed `exports`:

  ```json
  "exports": {
    ".":      { "import": "./dist/index.js", "types": "./dist/index.d.ts" },
    "./server": { "import": "./dist/server.js" },
    "./tui":    { "import": "./dist/tui.js", "types": "./dist/tui.d.ts" }
  }
  ```

- `main: "dist/index.js"` is the fallback entry.
- So there is **no dedicated `opencode` metadata field** required in `package.json`; entry-point
  detection is via the `exports["./server"]` / `exports["./tui"]` subpaths or `main`.
- The plugin-framework package itself, `@opencode-ai/plugin@1.18.18` (latest, npm), declares
  `exports` for `.`, `./tool`, `./tui`, `./v2/effect`, `./v2/effect/integration`,
  `./v2/effect/plugin`, `./v2/promise`, with compiled `dist/*.js` + `*.d.ts`. It depends on
  `@opencode-ai/sdk@1.18.18`, `zod@4.1.8`, `effect@4.0.0-beta.83`, `@ai-sdk/provider@3.0.8`, and has
  optional peer deps `@opentui/core`, `@opentui/keymap`, `@opentui/solid` (>=0.4.5).
- `@opencode-ai/sdk` (https://opencode.ai/docs/sdk) exports `.`, `./client`, `./server`, `./v2`,
  `./v2/client`, `./v2/gen/client`, `./v2/server`, `./v2/types`
  (`packages/sdk/js/package.json`).

### 2.6 Bundled/compiled vs run directly as TS

- **Local file plugins** are imported directly as `.ts`/`.js` source via `await import()` and run as
  TypeScript without a separate build step (opencode runs on Bun).
- **npm plugins** are installed (Bun) into the cache and imported from their resolved entry
  (`exports["./server"]`/`./tui` or `main`). Published plugins typically ship compiled output
  (observed: `oh-my-opencode-slim` bundles to `dist/` with `bun build`). opencode does not bundle
  plugins itself; the framework package's own exports point at `dist/` files in the published
  package.

---

## 3. Events / hooks that expose agent activity

### 3.1 The `event` hook

Any plugin can subscribe to **all** server events with:

```ts
return { event: async ({ event }) => { if (event.type === "session.idle") { /* ... */ } } }
```

The event payload shape passed to plugins is `{ id, type, properties }`
(`hook["event"]?.({ event: { id: event.id, type: event.type, properties: event.data } })`,
`packages/opencode/src/plugin/index.ts`).

### 3.2 v1 event union (authoritative list)

Generated types: https://github.com/anomalyco/opencode/blob/dev/packages/sdk/js/src/gen/types.gen.ts
(`export type Event = ...`). The docs page lists the same names under "Events"
(https://opencode.ai/docs/plugins#events).

`Event =` one of: `server.instance.disposed`, `installation.updated`,
`installation.update-available`, `lsp.client.diagnostics`, `lsp.updated`, `message.updated`,
`message.removed`, `message.part.updated`, `message.part.removed`, `permission.updated`,
`permission.replied`, `session.status`, `session.idle`, `session.compacted`, `file.edited`,
`todo.updated`, `command.executed`, `session.created`, `session.updated`, `session.deleted`,
`session.diff`, `session.error`, `file.watcher.updated`, `vcs.branch.updated`,
`tui.prompt.append`, `tui.command.execute`, `tui.toast.show`, `pty.created`, `pty.updated`,
`pty.exited`, `pty.deleted`, `server.connected`.

### 3.3 Data carried by the most relevant events (type-quoted)

From `packages/sdk/js/src/gen/types.gen.ts` (v1):

- `message.part.updated`: `{ type: "message.part.updated"; properties: { part: Part; delta?: string } }`
  — `delta` is the incremental text streamed for text/reasoning parts.
- `message.part.removed`: `{ sessionID, messageID, partID }`
- `message.updated`: `{ info: Message }`
- `message.removed`: `{ sessionID, messageID }`
- `session.created` / `session.updated` / `session.deleted`: `{ info: Session }`
- `session.idle`: `{ sessionID }`
- `session.compacted`: `{ sessionID }`
- `session.status`: `{ sessionID, status: SessionStatus }` where `SessionStatus = { type: "idle" } | { type: "retry"; attempt; message; next } | { type: "busy" }`
- `session.diff`: `{ sessionID, diff: Array<FileDiff> }`
- `session.error`: `{ sessionID?, error? }`
- `todo.updated`: `{ sessionID, todos: Array<Todo> }`
- `command.executed`: `{ name, sessionID, arguments, messageID }`
- `file.edited`: `{ file }`
- `permission.updated` (SDK name) / docs call it `permission.asked`: `properties: Permission`
- `permission.replied`: `{ sessionID, permissionID, response }`
- `tool` activity is **not** a separate event in the v1 union — tool calls are represented as
  `message.part.updated` events whose `part.type === "tool"`.

### 3.4 The `Part` type (what message parts carry)

`Part` union (`types.gen.ts`): `TextPart | subtask | ReasoningPart | FilePart | ToolPart |
StepStartPart | StepFinishPart | SnapshotPart | PatchPart | AgentPart | RetryPart | CompactionPart`.

Each part carries `id`, `sessionID`, `messageID` plus:

- `TextPart`: `type: "text"; text: string; synthetic?; ignored?; time?; metadata?`
- `ReasoningPart`: `type: "reasoning"; text: string; time: { start; end? }`
- `ToolPart`: `type: "tool"; callID: string; tool: string; state: ToolState; metadata?` where
  `ToolState = pending | running | completed | error` and the `completed` state includes `output`,
  `title`, `time`, `attachments?`; `error` state includes `error`.
- `StepFinishPart`: `{ reason, snapshot?, cost, tokens }` (token/cost accounting per step).
- `AgentPart`: `{ type: "agent"; name: string; source? }`
- subtask part (inline): `{ type: "subtask"; prompt: string; description: string; agent: string }`
- `RetryPart`: `{ attempt, error }`; `CompactionPart`: `{ auto }`.

`Message = UserMessage | AssistantMessage`; `AssistantMessage` carries `id`, `sessionID`,
`parentID`, `modelID`, `providerID`, `mode`, `path { cwd, root }`, `cost`, `tokens`, `error?`,
`finish?`, `time { created, completed? }`. `UserMessage` carries `agent`, `model`, `summary?`.

### 3.5 LLM request-level hooks (pre/post model calls)

There are no `model.request` / `model.response` events in the v1 Event union. The LLM-facing hooks are:

- `chat.params` — mutate temperature/topP/topK/maxOutputTokens/options sent to the LLM
- `chat.headers` — mutate HTTP headers sent to the provider
- `experimental.chat.messages.transform` — rewrite the full `{ info, parts }[]` sent to the model
- `experimental.chat.system.transform` — rewrite system prompts
- `experimental.text.complete` — post-process final text of a part

(All from `packages/plugin/src/index.ts`; the `chat.*` hooks are also documented at
https://opencode.ai/docs/plugins under examples / events.)

### 3.6 Newer v2 event system (dev branch / `@opencode-ai/sdk/v2`)

`packages/sdk/js/src/v2/gen/types.gen.ts` defines a much richer `Event` union including
`session.next.*` granular events and a generic `event.message.part.delta`. Relevant for tracking
agent work:

- `session.next.agent.switched`: `properties: { timestamp, sessionID, messageID, agent }`
- `session.next.step.started`: `{ timestamp, sessionID, assistantMessageID, agent, model, snapshot? }`
- `session.next.step.ended` / `step.failed`
- `session.next.text.started` / `text.delta` / `text.ended`
- `session.next.reasoning.started` / `reasoning.delta` / `reasoning.ended`
- `session.next.tool.input.started` / `tool.input.delta` / `tool.input.ended`
- `session.next.tool.called`: `{ timestamp, sessionID, assistantMessageID, callID, tool, input, provider }`
- `session.next.tool.progress` / `tool.success` (includes `structured`, `content`, `result?`, `outputPaths?`) / `tool.failed`
- `session.next.shell.started` (`{ callID, command }`) / `shell.ended` (`{ callID, output }`)
- `session.next.retried` (`{ attempt, error }`), `session.next.compaction.*`
- `permission.asked` / `permission.replied`, `question.asked` / `question.replied` / `question.rejected`
- `event.message.part.delta`

Each v2 event object carries a top-level `id` and `properties.timestamp`. These v2 types are also
reachable from plugins via `@opencode-ai/plugin/v2/effect` (the Effect-based v2 plugin API).

---

## 4. UI surface

### 4.1 What the docs support

The docs plugin page (https://opencode.ai/docs/plugins#events) lists **TUI events**
(`tui.prompt.append`, `tui.command.execute`, `tui.toast.show`) that plugins can emit, and the SDK
client exposes TUI controls (https://opencode.ai/docs/sdk#tui):

- `client.tui.appendPrompt({ body: { text } })`
- `client.tui.openHelp()`, `openSessions()`, `openThemes()`, `openModels()`
- `client.tui.submitPrompt()`, `clearPrompt()`
- `client.tui.executeCommand({ body })`
- `client.tui.showToast({ body: { message, variant: "info"|"success"|"warning"|"error", duration? } })`

These are one-shot actions, not persistent UI.

### 4.2 TUI plugin API (full UI embedding) — new, on the published plugin package

`@opencode-ai/plugin` exposes `@opencode-ai/plugin/tui`. The module contract is a default-export
object `{ id, tui(api, options, meta) }` (`TuiPluginModule` in `packages/plugin/src/tui.ts`, also in
the published `dist/tui.d.ts`). The `TuiPluginApi` provides:

- `route.register(routes)` / `route.navigate(name, params)` — register **custom routes** that render
  `JSX.Element` (`TuiRouteDefinition = { name, render({ params }) }`).
- `slots.register(plugin)` — inject components into **host slot points** (`TuiHostSlotMap`):
  `app`, `app_bottom`, `home_logo`, `home_prompt`, `home_prompt_right`, `session_prompt`,
  `session_prompt_right`, `home_bottom`, `home_footer`, `sidebar_title`, `sidebar_content`,
  `sidebar_footer`.
- `ui.Dialog / DialogAlert / DialogConfirm / DialogPrompt / DialogSelect`, `ui.Slot`, `ui.Prompt`,
  `ui.toast(...)`, `ui.dialog` (dialog stack).
- `theme` (current palette RGBA values, `set`, `install`, `mode`, `has`), `keymap`,
  `keys` (formatting helpers), `mode` (push/pop UI modes), `kv` (persistent key-value store),
  `state` (session/message/part/lsp/mcp/todo/permission/question snapshot getters),
  `event.on(type, handler)` (typed event bus), `client` (SDK client), `renderer` (`CliRenderer`),
  `plugins` (list/activate/deactivate/add/install plugins), `lifecycle` (`AbortSignal`, `onDispose`),
  `attention` (notifications + soundboard; sounds include `subagent_done`), `tuiConfig`, `app`.
- JSX is `@opentui/solid` (peer dep `@opentui/solid`, `@opentui/core`, `@opentui/keymap`).

TUI plugins are enabled via the `plugin` array in `tui.json` (schema at https://opencode.ai/tui.json:
top-level keys include `plugin` and `plugin_enabled`). An npm plugin with an `exports["./tui"]`
subpath is loaded as a TUI plugin; one with `exports["./server"]` (or `main`) as a server plugin.

There is **no dedicated "statusbar" API**; the closest status-bar-like injection points are the
`home_footer`, `home_bottom`, `app_bottom`, `session_prompt_right`, and `sidebar_footer` slots.

### 4.3 Caveat

The TUI plugin API is verified against the `dev` source and the published `@opencode-ai/plugin`
(1.18.18) package. It was not directly exercised against the installed 1.18.16 binary; the plugin
entry-point loader (server/tui kinds) is identical between `v1.18.16` and `dev`, but TUI-render
support was not empirically verified on 1.18.16.

---

## 5. Session / transcript data

### 5.1 Programmatic access (documented)

SDK, https://opencode.ai/docs/sdk#sessions:

- `client.session.list()` → `Session[]`
- `client.session.get({ path: { id } })` → `Session`
- `client.session.messages({ path: { id } })` → `{ info: Message; parts: Part[] }[]`
- `client.session.message({ path })` → `{ info: Message; parts: Part[] }`
- `client.session.create`, `update`, `delete`, `abort`, `children` (list child sessions),
  `prompt`, `command`, `shell`, `revert`, `unrevert`, `summarize`, `share`, `unshare`, `init`
- `client.event.subscribe()` → server-sent events stream (all events in §3)

Types are importable: `import type { Session, Message, Part } from "@opencode-ai/sdk"`.

### 5.2 On-disk storage (source-verified + observed)

- Sessions/messages are stored in a **SQLite database** at `~/.local/share/opencode/opencode.db`
  (observed on this machine; `opencode.db-wal`/`-shm` present, DB file locked by a running server).
  `packages/opencode/src/session/session.ts` (identical v1.18.16) reads sessions with
  `db.select().from(SessionTable)`. Database migrations for session/message tables exist under
  `packages/core/src/database/migration/` (e.g. `20260312043431_session_message_cursor.ts`,
  `20260603001617_session_message_projection_indexes.ts`, `20260604172448_event_sourced_session_input.ts`).
- A JSON-file storage layer also exists: `packages/opencode/src/storage/storage.ts` (identical
  between v1.18.16 and dev) writes pretty-printed JSON under `~/.local/share/opencode/storage/`
  keyed by `<key>.json` paths: `session/<projectID>/<sessionID>.json`,
  `message/<sessionID>/<messageID>.json`, `part/<messageID>/<partID>.json`,
  `project/<projectID>.json`, `session_diff/<sessionID>.json`. The storage root is
  `path.join(Global.Path.data, "storage")` where data = `~/.local/share/opencode`.
- Observed on this machine: `~/.local/share/opencode/storage/<project>/<hash>/tui-state.json`
  exists (holds UI state incl. per-agent model/variant maps). No session JSONL files were found.
- **No JSONL transcript format** was found in the current source/docs; the historical
  `<sessionID>.jsonl` session files are not present in the current storage layer
  (the only `jsonl` references found are unrelated: TUI prompt-history tests).

### 5.3 Transient outputs

`~/.local/share/opencode/tool-output/` stores captured command/tool output files
(observed; each bash tool call writes a file there).

---

## 6. Sub-agents / nested agents

### 6.1 Representation in messages/parts

- `Part` includes a `subtask` variant: `{ type: "subtask"; prompt: string; description: string; agent: string }`
  and `AgentPart`: `{ type: "agent"; name: string; source? }` (`packages/sdk/js/src/gen/types.gen.ts`).
- `AgentPart` also appears in the TUI prompt info (`TuiPromptInfo` in `packages/plugin/src/tui.ts`),
  i.e. agents can be `@`-referenced in prompts.
- `Session` has `parentID?: string` and the SDK exposes `session.children({ path })` to list child
  sessions (`types.gen.ts`, `docs/sdk#sessions`). Subagents run in child sessions
  (docs: https://opencode.ai/docs/agents#usage — "When subagents create child sessions…").

### 6.2 The Task tool

- The agents docs (https://opencode.ai/docs/agents#task-permissions) describe the **Task tool** that
  launches subagents: `permission.task` controls which subagents an agent may invoke (glob
  patterns, last match wins); denied subagents are removed from the Task tool's description.
  `hidden: true` subagents are invocable only via the Task tool.
- The tools docs (https://opencode.ai/docs/tools) list built-in tools but do **not** list a `task`
  tool in the current built-in list (no documented `task` tool entry there); it is referenced as a
  permission key (`task` → `task`) and as the "Task tool" in the agents docs. No dedicated
  "subagent launched" event exists in the v1 Event union.

### 6.3 Events/APIs that reveal subagent activity

- `message.part.updated` with `part.type: "subtask"` / `"agent"` reveals a subagent launch/mention.
- v2 events (dev): `session.next.agent.switched` (`{ sessionID, messageID, agent }`),
  `session.next.step.started` (`{ agent, model, snapshot? }`), plus the `session.next.tool.*`
  stream — a subagent launch goes through the tool stream, so `session.next.tool.called`
  (`{ tool, input }`) will show the `task` tool with its input.
- TUI attention sounds include `subagent_done` (`packages/plugin/src/tui.ts`,
  `TuiAttentionSoundNames`), indicating a first-class "subagent done" signal in the TUI layer.
- `client.app.agents()` lists all available agents (docs/sdk#app).
- `session.children()` lists child (subagent) sessions; `Session.parentID` links back to the parent.

---

## Appendix — source URLs

- Docs: plugins https://opencode.ai/docs/plugins · config https://opencode.ai/docs/config · SDK
  https://opencode.ai/docs/sdk · TUI https://opencode.ai/docs/tui · agents https://opencode.ai/docs/agents ·
  tools https://opencode.ai/docs/tools · tui.json schema https://opencode.ai/tui.json ·
  opencode.json schema https://opencode.ai/config.json
- Repo: https://github.com/anomalyco/opencode
  - Plugin framework types: `packages/plugin/src/index.ts`, `tool.ts`, `tui.ts` (branch `dev`)
  - Plugin loader: `packages/opencode/src/plugin/{index,loader,install,shared}.ts`
  - SDK types v1: `packages/sdk/js/src/gen/types.gen.ts`; v2: `packages/sdk/js/src/v2/gen/types.gen.ts`
  - Storage: `packages/opencode/src/storage/storage.ts`; session store:
    `packages/opencode/src/session/session.ts`; core store: `packages/core/src/session/store.ts`
- npm: `@opencode-ai/plugin@1.18.18` (https://www.npmjs.com/package/@opencode-ai/plugin) ·
  `@opencode-ai/sdk` (https://www.npmjs.com/package/@opencode-ai/sdk) ·
  `oh-my-opencode-slim@2.2.13` (installed in `~/.cache/opencode/packages/`)
- GitHub release v1.18.16: https://github.com/anomalyco/opencode/releases/tag/v1.18.16
