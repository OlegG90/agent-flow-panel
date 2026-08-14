import { execFile } from "node:child_process"
import { readFileSync, writeFileSync } from "node:fs"
import { promisify } from "node:util"
import { renderPanelHtml } from "../src/flow/render.ts"
import type { FlowTree } from "../src/flow/types.ts"

const execFileAsync = promisify(execFile)

const name = process.argv[2] ?? "subagent-session"
const tree = JSON.parse(readFileSync(`fixtures/${name}.json`, "utf8")) as FlowTree
const out = `panel-preview-${name}.html`
writeFileSync(out, renderPanelHtml(tree))
console.log(`wrote ${out}`)

if (process.platform === "win32") {
  await execFileAsync("cmd", ["/c", "start", "", out])
} else {
  await execFileAsync(process.platform === "darwin" ? "open" : "xdg-open", [out])
}
