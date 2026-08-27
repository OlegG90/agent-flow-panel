import { execFile } from "node:child_process"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)

/**
 * Hand a URL to the platform's browser.
 *
 * On Windows this goes through `cmd /c start` with an empty title argument —
 * `start` treats a lone quoted argument as the window title, so the empty
 * string is what makes the URL the target rather than the title.
 *
 * Failure is the caller's to interpret: opening a browser is best-effort, and
 * every entry point still has a working URL to report when it does not happen.
 */
export async function openInBrowser(url: string): Promise<void> {
  if (process.platform === "win32") {
    await execFileAsync("cmd", ["/c", "start", "", url])
    return
  }
  const opener = process.platform === "darwin" ? "open" : "xdg-open"
  await execFileAsync(opener, [url])
}
