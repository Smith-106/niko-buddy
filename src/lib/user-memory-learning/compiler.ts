import type { UserMemoryRule } from "./types"

export function compileUserMemorySkill(rules: UserMemoryRule[], maxChars = 3000): string {
  const limit = Math.max(0, Math.floor(maxChars))
  if (rules.length === 0 || limit === 0) return ""
  const header = [
    "## 全局用户规则",
    "以下规则来自用户长期习惯。当前用户请求与历史规则冲突时，以当前请求为准。",
  ].join("\n")
  if (header.length >= limit) return header.slice(0, limit)
  let result = header
  const sorted = [...rules].sort((left, right) => {
    const source = Number(right.source === "manual") - Number(left.source === "manual")
    return source || right.confidence - left.confidence
  })
  for (const rule of sorted) {
    const prefix = rule.source === "manual" ? "- [用户手动规则] " : "- "
    const line = `\n${prefix}${rule.rule}`
    if (result.length + line.length <= limit) {
      result += line
      continue
    }
    const remaining = limit - result.length
    if (remaining > prefix.length + 2) {
      result += `${line.slice(0, Math.max(0, remaining - 1))}…`
    }
    break
  }
  return result.slice(0, limit)
}
