import type { UserMemoryCategory, UserMemoryRule, UserMemorySurface } from "./types"

export type UserMemoryFilterReason = "disabled" | "candidate" | "conflicted" | "expired" | "scope_mismatch" | "surface_mismatch" | "category_blocked" | "current_task_conflict" | "shadowed"

export function inferUserMemorySurface(task: string): UserMemorySurface {
  if (/审稿|审查|检查|纠错|连贯性|一致性/.test(task)) return "review"
  if (/大纲|章纲|故事框架|情节规划/.test(task)) return "ai-outline"
  if (/写第|续写|生成.{0,8}章|改写.{0,8}章|章节正文/.test(task)) return "chapter-writing"
  if (/拆书|角色\s*skill|文风提取|故事提取|作品分析/i.test(task)) return "book-analysis"
  return "ai-chat"
}

function categoryAllowed(category: UserMemoryCategory, surface: UserMemorySurface): boolean {
  if (surface === "review") return category !== "writing_preference" && category !== "outline_preference" && category !== "output_style"
  if (surface === "book-analysis" || surface === "analysis") {
    return category === "interaction_preference" || category === "format_preference" || category === "constraint" || category === "manual"
  }
  return true
}

function conflictsWithCurrentTask(rule: string, task: string): boolean {
  const negatives = [...task.matchAll(/(?:不要|禁止|不再|避免|无需)(?:再|使用|采用|保持|输出)?\s*([^，。；\n]{2,24})/g)]
  return negatives.some((match) => {
    const phrase = match[1]?.replace(/^(?:这种|这个|该)/, "").trim() ?? ""
    if (!phrase) return false
    if (rule.includes(phrase)) return true
    const key = phrase.replace(/(?:直接|连续|内容|方式|风格|规则)$/g, "").trim()
    return key.length >= 2 && rule.includes(key)
  })
}

export function selectUserMemoryRules(
  rules: UserMemoryRule[],
  input: { task: string; surface?: UserMemorySurface; limit?: number; projectKey?: string; sessionKey?: string; onlyManual?: boolean },
): UserMemoryRule[] {
  const surface = input.surface ?? inferUserMemorySurface(input.task)
  const limit = Math.max(1, input.limit ?? 12)
  const scopeRank = (rule: UserMemoryRule) => rule.scope === "session" ? 3 : rule.scope === "project" ? 2 : 1
  const eligible = rules
    .filter((rule) => evaluateUserMemoryRule(rule, { ...input, surface }) === null)
    .sort((left, right) => {
      const scope = scopeRank(right) - scopeRank(left)
      const source = Number(right.source === "manual") - Number(left.source === "manual")
      return scope || source || right.confidence - left.confidence || right.updatedAt - left.updatedAt
    })
  const selected: UserMemoryRule[] = []
  const fingerprints = new Set<string>()
  for (const rule of eligible) {
    if (fingerprints.has(rule.fingerprint)) continue
    fingerprints.add(rule.fingerprint)
    selected.push(rule)
    if (selected.length >= limit) break
  }
  return selected
}

export function evaluateUserMemoryRule(
  rule: UserMemoryRule,
  input: { task: string; surface: UserMemorySurface; projectKey?: string; sessionKey?: string; onlyManual?: boolean },
): UserMemoryFilterReason | null {
  if (!rule.enabled) return "disabled"
  if (input.onlyManual && rule.source !== "manual") return "disabled"
  const status = rule.status ?? "active"
  if (status === "candidate") return "candidate"
  if (status === "conflicted") return "conflicted"
  if (status === "expired") return "expired"
  const scope = rule.scope ?? "global"
  if (scope === "project" && (!input.projectKey || rule.projectKey !== input.projectKey)) return "scope_mismatch"
  if (scope === "session" && (
    !input.sessionKey
    || rule.sessionKey !== input.sessionKey
    || (rule.projectKey && rule.projectKey !== input.projectKey)
  )) return "scope_mismatch"
  if (!rule.surfaces.includes("all") && !rule.surfaces.includes(input.surface)) return "surface_mismatch"
  if (!categoryAllowed(rule.category, input.surface)) return "category_blocked"
  if (conflictsWithCurrentTask(rule.rule, input.task)) return "current_task_conflict"
  return null
}
