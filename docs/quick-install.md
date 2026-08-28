# Quick install

Install the panel once, for one agent, so it is there in every project.

This guide assumes **one agent**. If you run several and want the panel in more than one of
them, read [`installation.md`](installation.md) instead — sharing a machine between agents
changes the scope advice, and getting it wrong silently shows you the wrong agent's flow.

A complete install is three things, and all three are covered below for each agent:

| | what it is |
|---|---|
| **Engine** | the bundle the agent loads — it watches the session and serves the panel |
| **Panel** | the browser page it opens, on `127.0.0.1` with a per-run token |
| **Commands** | `/flow`, `/flow-tree` and friends, so you do not have to ask in prose |

---

## Step 1 — Build once

Building needs **Node ≥ 22.18** (the tests run `.ts` files directly). The bundles it
produces are plain JavaScript and run on **Node ≥ 17**.

```sh
git clone https://github.com/OlegG90/agent-flow-panel.git
cd agent-flow-panel
npm install
npm run build
```

You now have one bundle per agent:

```
dist/opencode/server.js
dist/claude/mcp.js
dist/pi/extension.js
```

## Step 2 — Park the bundle outside the repository

Copy the one bundle your agent needs to a permanent home. Windows PowerShell:

```powershell
New-Item -ItemType Directory -Force "$HOME\agent-flow-panel" | Out-Null
Copy-Item dist\claude\mcp.js "$HOME\agent-flow-panel\"     # or opencode\server.js, or pi\extension.js
```

macOS / Linux:

```sh
mkdir -p ~/agent-flow-panel
cp dist/claude/mcp.js ~/agent-flow-panel/                  # or opencode/server.js, or pi/extension.js
```

**Do not skip this and point the config at `dist/` in the clone.** A global config is loaded
by every session in every directory, so while it points into a working repository, an
unfinished edit or a failed build there takes the agent down everywhere — not just in that
project. A parked copy changes only when you deliberately replace it (see *Updating*).

Everything below uses `~/agent-flow-panel/` as that home. On Windows that is
`C:\Users\<you>\agent-flow-panel\`; write the path with forward slashes in config files.

---

## Claude Code

Claude Code has no plugin event API, so the engine is an **MCP server** that reads the
transcript Claude Code already writes.

**1. Register the engine, globally:**

```sh
claude mcp add flow-panel -s user -- node ~/agent-flow-panel/mcp.js
```

`-s user` is what makes it global — it goes in `~/.claude.json` under `mcpServers` and
applies in every directory. (`-s local` would bind it to the one folder you ran it in.)

**2. Install the commands**, by copying them from the clone into your user command
directory — `~/.claude/commands/` is read no matter which project you are in:

```sh
mkdir -p ~/.claude/commands
cp .claude/commands/flow.md .claude/commands/flow-tree.md ~/.claude/commands/
```

**3. Verify:**

```sh
claude mcp list          # → flow-panel: … - ✔ Connected
```

Then `/flow` in any project. There is no reset command on Claude Code; ask for the
`flow_panel` tool when you want the view to start from the current moment.

---

## OpenCode

**1. Point the global config at the engine** — `~/.config/opencode/opencode.jsonc`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["file:///C:/Users/<you>/agent-flow-panel/server.js"]
}
```

Keep the `file:///` prefix and an absolute path. If the file already exists, add the
`plugin` entry to it rather than replacing it.

**2. Install the commands:**

```sh
mkdir -p ~/.config/opencode/command
cp .opencode/command/flow.md .opencode/command/flow-now.md .opencode/command/flow-tree.md ~/.config/opencode/command/
```

**3. Restart OpenCode** — the config is not hot-reloaded — then `/flow`.

---

## Pi

**1. Point the global settings at the engine** — `~/.pi/agent/settings.json`:

```json
{ "extensions": ["C:/Users/<you>/agent-flow-panel/extension.js"] }
```

Add the `extensions` key to the existing file; do not overwrite the rest.

**2. Commands need no separate install** — the extension registers `/flow`, `/flow-reset`
and `/flow-tree` itself (plus the `/flaw…` typo aliases).

**3. Verify:**

```sh
FLOW_PANEL_DEBUG=1 pi -p "hi"    # → [flow-panel] vX.Y.Z loaded
```

> **Pick one mechanism.** `discoverAndLoadExtensions` collects from three places and then
> de-duplicates **by resolved path**: `<cwd>/.pi/extensions/`, `~/.pi/agent/extensions/`, and
> the configured `extensions` paths. Two *copies* of the same bundle sit at two different
> paths, so nothing de-duplicates them — each is loaded, and each builds its own tracker and
> its own panel server. The duplication is invisible in the command list, because the second
> registration simply overwrites the first name.
>
> So keep exactly one: either a copy in `~/.pi/agent/extensions/`, or the settings key — not
> both. And check `<project>/.pi/extensions/` for a stray copy left behind by an earlier
> install; it loads on top of whatever else you configured, but only in that project.

---

## oh-my-pi (omp)

**1. Point the global config at the engine** — `~/.omp/agent/config.yml`:

```yaml
extensions:
  - C:/Users/<you>/agent-flow-panel/extension.js
```

Append it as a new top-level key. Watch for a missing trailing newline in that file: a naive
`>>` produces `enabled: trueextensions:` and breaks the config.

**2. Commands need no separate install** — same as Pi.

**3. Verify** — ask omp where its commands come from:

```sh
echo '{"type":"noop"}' | omp --mode=rpc --no-session
```

In the `available_commands_update` frame, `flow` and `flow-tree` should read
`source: extension`.

---

## Updating

The engine holds its code in memory, so a new bundle is not picked up until the process
restarts.

```sh
cd agent-flow-panel && git pull && npm run build
cp dist/<agent>/<bundle>.js ~/agent-flow-panel/
```

Then: **Claude Code** — kill the `node …/mcp.js` process, it is respawned automatically.
**OpenCode** — restart it. **Pi / omp** — start a new session.

## Uninstalling

Remove the config entry (`claude mcp remove flow-panel -s user`, or the `plugin` /
`extensions` key), delete the command files you copied, and delete `~/agent-flow-panel/`.

---

## If something looks wrong

**The panel opens but shows nothing.** It is showing the session for the directory the agent
was started in. On Claude Code that is whichever transcript under
`~/.claude/projects/<encoded-cwd>/` is newest.

**Nothing happens at all.** The most common cause is a config path that no longer exists —
a bundle that moved, or a `dist/` layout that changed between versions. Check the path in
the config actually resolves to a file before looking anywhere else.

**Commands are missing but the tools work.** The engine is installed and the commands are
not; repeat the command step for your agent. On Pi and omp there is no separate step, so
missing commands there mean the extension is not loading at all.

**Sub-agents show as one node on Claude Code.** That is expected — Claude Code does not
record a sub-agent's own steps. OpenCode and Pi expand them.
