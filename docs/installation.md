# Installation

## OpenCode

**Local (dev, no build):**
```jsonc
// opencode.json
{ "$schema": "https://opencode.ai/config.json", "plugin": ["./src/server.ts"] }
```

**From bundle (prod) or global `~/.config/opencode/opencode.jsonc`:**
```jsonc
{ "plugin": ["file:///C:/absolute/path/dist/server.js"] }
```

After changes — **restart OpenCode** (config is not hot-reloaded). The plugin provides tools `flow_panel` / `flow_open` / `flow_tree`.

## Pi (mariozechner/pi-mono)

**One-off (no install):**
```sh
npm run build
pi -e C:/path/to/dist/extension.js
# single prompt:
pi -e C:/path/to/dist/extension.js -p "hello"
```

**Global:** copy `dist/extension.js` to `~/.pi/agent/extensions/` or add to `~/.pi/agent/settings.json`:
```json
{ "extensions": ["C:/path/to/dist/extension.js"] }
```

## oh-my-pi / omp (can1357/oh-my-pi)

> `omp` uses `~/.omp` (not `~/.pi`) and its own `plugin` manager. The `pi` field in `package.json` is not auto-picked up for `omp` without action.

**A — one-off (recommended):**
```sh
npm run build
omp -e C:/path/to/dist/extension.js
omp -e C:/path/to/dist/extension.js -p "hello"
```
Inside TUI: `/flow` (keep), `/flow-reset` (reset from scratch), `/flow_tree` or tools `flow_panel`/`flow_open`/`flow_tree`.

**B — permanent (requires Developer Mode / admin for symlink):**
```sh
omp plugin link "C:/path/to/project"  # symlink into ~/.omp/plugins
# if EPERM:
# xcopy /E /I dist C:\Users\<you>\.omp\plugins\flow-panel\dist
# or manually add to ~/.omp/agent/config.yml:
# extensions: ["C:/path/to/dist/extension.js"]
```

Check:
```sh
omp -e C:/path/to/dist/extension.js -p "echo hi" 2>&1 | findstr flow
# in TUI: /help should list /flow, /flow-reset
```

## Build & development

```sh
npm install
npm run build          # → dist/server.js + dist/extension.js
npm test               # node --test src/**/*.test.ts (106 tests)
npm run typecheck
npm run lint
npm run panel:fixture  # → docs/previews/panel-preview-*.html
```
