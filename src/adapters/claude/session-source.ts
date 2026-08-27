import { readdirSync, readFileSync, statSync, watch } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import type { FlowTree } from "../../flow/types.ts"
import { reduceTranscript } from "./transcript.ts"

/**
 * Claude Code stores transcripts as
 * `~/.claude/projects/<encoded-cwd>/<session-id>.jsonl`, where the directory
 * name is the working directory with every character outside [a-zA-Z0-9-]
 * replaced by a dash. Verified against every project directory on disk.
 */
export function encodeProjectDir(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9-]/g, "-")
}

export interface TranscriptRef {
  path: string
  sessionID: string
  modifiedAt: number
}

export interface DiscoveryOptions {
  cwd?: string
  home?: string
}

function projectDir(options: DiscoveryOptions): string {
  const cwd = options.cwd ?? process.cwd()
  const home = options.home ?? homedir()
  return join(home, ".claude", "projects", encodeProjectDir(cwd))
}

/** Every transcript recorded for this working directory, newest first. */
export function listTranscripts(options: DiscoveryOptions = {}): TranscriptRef[] {
  const dir = projectDir(options)
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return []
  }
  const refs: TranscriptRef[] = []
  for (const entry of entries) {
    if (!entry.endsWith(".jsonl")) {
      continue
    }
    const path = join(dir, entry)
    try {
      refs.push({
        path,
        sessionID: entry.slice(0, -".jsonl".length),
        modifiedAt: statSync(path).mtimeMs,
      })
    } catch {
      // raced with a delete; skip it
    }
  }
  return refs.sort((a, b) => b.modifiedAt - a.modifiedAt)
}

/**
 * The session to show. Claude Code does not tell an MCP server which session
 * it is serving, so the most recently written transcript for this directory is
 * the best available answer — and it is the one the user is sitting in.
 */
export function findActiveTranscript(options: DiscoveryOptions = {}): TranscriptRef | undefined {
  return listTranscripts(options)[0]
}

export function readTree(ref: TranscriptRef): FlowTree {
  let raw: string
  try {
    raw = readFileSync(ref.path, "utf8")
  } catch {
    return { sessionID: ref.sessionID, units: [] }
  }
  return reduceTranscript(raw.split("\n"), ref.sessionID)
}

export interface TranscriptSource {
  /** Current tree; re-reduced when the file changed since the last read. */
  tree(): FlowTree
  /** Re-point at the newest transcript, e.g. after /clear starts a new one. */
  refresh(): void
  onChange(listener: () => void): void
  close(): void
}

/**
 * Watches the project's transcript directory and re-reduces on change.
 *
 * Re-reducing the whole file rather than tailing it keeps the reducer pure and
 * costs ~17ms on a 2.8MB transcript; the panel server already coalesces
 * frames, so the rate is bounded regardless.
 */
export function createTranscriptSource(options: DiscoveryOptions = {}): TranscriptSource {
  let ref = findActiveTranscript(options)
  let cached: FlowTree | undefined
  let cachedAt = -1
  let listener: (() => void) | undefined
  let watcher: ReturnType<typeof watch> | undefined

  const dir = projectDir(options)
  try {
    watcher = watch(dir, { persistent: false }, () => {
      // A new session file appears in the same directory, so re-resolve rather
      // than staying pinned to the transcript we started with.
      const latest = findActiveTranscript(options)
      if (latest && latest.path !== ref?.path) {
        ref = latest
        cachedAt = -1
      }
      listener?.()
    })
  } catch {
    // No transcript directory yet: the panel simply shows an empty flow.
  }

  return {
    tree(): FlowTree {
      if (!ref) {
        ref = findActiveTranscript(options)
      }
      if (!ref) {
        return { sessionID: "", units: [] }
      }
      let modified: number
      try {
        modified = statSync(ref.path).mtimeMs
      } catch {
        return cached ?? { sessionID: ref.sessionID, units: [] }
      }
      if (!cached || modified !== cachedAt) {
        cached = readTree(ref)
        cachedAt = modified
      }
      return cached
    },
    refresh(): void {
      ref = findActiveTranscript(options)
      cachedAt = -1
    },
    onChange(next: () => void): void {
      listener = next
    },
    close(): void {
      watcher?.close()
      watcher = undefined
      listener = undefined
    },
  }
}
