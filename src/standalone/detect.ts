/**
 * Which agent's log a standalone file belongs to.
 *
 * Claude Code transcripts use `type=user|assistant|system` with
 * `message.role`; Pi persistence files use
 * `type=title|session|model_change|thinking_level_change|message|custom` with
 * `message.role=user|assistant|toolResult`. The two vocabularies do not
 * overlap, so content sniffing decides — `--agent` only overrides it.
 */

export type AgentKind = "claude" | "pi"

export function detectAgent(lines: readonly string[]): AgentKind | undefined {
  for (const line of lines) {
    if (!line.trim()) {
      continue
    }
    let record: { type?: unknown; message?: { role?: unknown }; customType?: unknown }
    try {
      record = JSON.parse(line) as { type?: unknown }
    } catch {
      continue
    }
    const type = typeof record.type === "string" ? record.type : ""
    if (type === "custom" || typeof record.customType === "string") {
      return "pi"
    }
    if (
      type === "title" ||
      type === "session" ||
      type === "model_change" ||
      type === "thinking_level_change"
    ) {
      return "pi"
    }
    if (type === "message") {
      const role =
        record.message && typeof record.message.role === "string" ? record.message.role : ""
      if (role === "toolResult") {
        return "pi"
      }
      if (role === "user" || role === "assistant") {
        // Ambiguous alone (both formats have user/assistant messages), so keep
        // scanning: a Pi file always carries custom/session records nearby.
        continue
      }
      continue
    }
    if (type === "user" || type === "assistant" || type === "system") {
      return "claude"
    }
  }
  return undefined
}
