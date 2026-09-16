#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs"
import { basename, resolve } from "node:path"
import type { FlowTree } from "../flow/types.ts"
import { reduceTranscript } from "../adapters/claude/transcript.ts"
import { reducePiSession } from "../adapters/pi/session-file.ts"
import { createPanelServer } from "../server/panel-server.ts"
import { openInBrowser } from "../server/open-browser.ts"
import { renderExportHtml } from "../flow/render.ts"
import { detectAgent, type AgentKind } from "./detect.ts"

export interface CliOptions {
  file: string
  agent: AgentKind | undefined
  port: number
  open: boolean
  exportPath: string | undefined
}

function usage(): string {
  return [
    "Usage: flow-panel <session-file> [--agent claude|pi] [--port N] [--no-open] [--export [out.html]]",
    "",
    "Show a finished agent session as a flowchart panel:",
    "  flow-panel sess1.jsonl              serve Claude/Pi log, open browser",
    "  flow-panel sess1.jsonl --export     write sess1.html and exit",
    "",
    "The agent is auto-detected from the file content; --agent overrides it.",
  ].join("\n")
}

export function parseArgs(argv: readonly string[]): CliOptions {
  let file: string | undefined
  let agent: AgentKind | undefined
  let port = 0
  let open = true
  let exportPath: string | undefined
  let exportFlag = false

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string
    if (arg === "--agent") {
      const value = argv[++i]
      if (value !== "claude" && value !== "pi") {
        throw new Error(`invalid --agent ${value ?? "(missing)"} — expected claude|pi`)
      }
      agent = value
    } else if (arg === "--port") {
      const value = argv[++i]
      port = Number(value)
      if (!Number.isInteger(port) || port < 0 || port > 65535) {
        throw new Error(`invalid --port ${value ?? "(missing)"} — expected 0-65535`)
      }
    } else if (arg === "--no-open") {
      open = false
    } else if (arg === "--export") {
      exportFlag = true
      const next = argv[i + 1]
      if (next !== undefined && !next.startsWith("--")) {
        exportPath = next
        i++
      }
    } else if (arg === "--help" || arg === "-h") {
      throw { help: true }
    } else if (arg.startsWith("--")) {
      throw new Error(`unknown option ${arg}\n${usage()}`)
    } else if (!file) {
      file = arg
    } else {
      throw new Error(`unexpected argument ${arg}\n${usage()}`)
    }
  }

  if (!file) {
    throw new Error(usage())
  }
  if (exportFlag && exportPath === undefined) {
    exportPath = file.replace(/\.jsonl$/i, "") + ".html"
  }
  return { file, agent, port, open, exportPath }
}

function readLines(path: string): string[] {
  try {
    return readFileSync(path, "utf8").split("\n")
  } catch {
    throw new Error(`file not found: ${path}`)
  }
}

function buildTree(lines: string[], file: string, agent: AgentKind): { tree: FlowTree; source: string } {
  const sessionID = basename(file).replace(/\.jsonl$/i, "")
  if (agent === "claude") {
    return { tree: reduceTranscript(lines, sessionID), source: "Claude Code (static)" }
  }
  return { tree: reducePiSession(lines, sessionID), source: "Pi (static)" }
}

async function main(argv: readonly string[]): Promise<number> {
  let options: CliOptions
  try {
    options = parseArgs(argv)
  } catch (error) {
    if (error !== null && typeof error === "object" && "help" in error) {
      process.stdout.write(`${usage()}\n`)
      return 0
    }
    process.stderr.write(`${(error as Error).message}\n`)
    return 2
  }

  const path = resolve(options.file)
  let lines: string[]
  try {
    lines = readLines(path)
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n`)
    return 1
  }
  if (lines.every((line) => line.trim().length === 0)) {
    process.stderr.write(`empty file: ${options.file}\n`)
    return 1
  }

  const agent = options.agent ?? detectAgent(lines)
  if (!agent) {
    process.stderr.write("unknown format — retry with --agent claude|pi\n")
    return 1
  }

  const { tree, source } = buildTree(lines, options.file, agent)
  if (tree.units.length === 0) {
    process.stderr.write("no flow data found in file\n")
    return 1
  }

  if (options.exportPath) {
    writeFileSync(resolve(options.exportPath), renderExportHtml(tree, { source }), "utf8")
    process.stdout.write(`${options.exportPath}\n`)
    return 0
  }

  const panel = createPanelServer({ getTree: () => tree, source })
  try {
    await panel.start(options.port)
  } catch {
    process.stderr.write(`cannot bind port ${options.port}\n`)
    return 1
  }
  const url = panel.url()
  process.stdout.write(`${url}\n`)
  if (options.open) {
    try {
      await openInBrowser(url)
    } catch {
      // Headless box still gets the URL on stdout.
    }
  }
  const shutdown = (): void => {
    void panel.close().finally(() => process.exit(0))
  }
  process.on("SIGINT", shutdown)
  process.on("SIGTERM", shutdown)
  return await new Promise<number>(() => {})
}

const code = await main(process.argv.slice(2))
process.exit(code)
