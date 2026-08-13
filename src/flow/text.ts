export function truncate(text: string, max = 80): string {
  const compact = text.replace(/\s+/g, " ").trim()
  return compact.length > max ? `${compact.slice(0, max)}…` : compact
}
