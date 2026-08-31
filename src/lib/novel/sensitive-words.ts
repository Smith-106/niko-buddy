/**
 * R-allrepo-2 (29 全仓吸收落地): SensitiveWords — 敏感词分级检测.
 *
 * 吸收来源：累积残余 roadmap（26 号 GLM value 6 / 29 号三模型 3/3 residual
 * value 7）——参考仓 sensitive-words 模式（词表+文本扫描+分级处置）。
 *
 * 定位：发布前合规预检的确定性引擎层——三级处置（ban=阻断发布 /
 * warn=人工复核 / review=记录留痕），默认内置最低限度词表骨架（分类可
 * 扩展），词表内容由项目配置注入（本模块不内置完整敏感词库，只提供
 * 确定性检测语义与分级框架）。
 */

export type SensitivityAction = "ban" | "warn" | "review"

export interface SensitiveWordRule {
  term: string
  action: SensitivityAction
  category: string
}

export interface SensitiveHit {
  term: string
  action: SensitivityAction
  category: string
  count: number
}

export interface SensitiveScanResult {
  hits: SensitiveHit[]
  /** 存在 ban 级命中 → blocked；否则存在 warn → needsReview；否则 clear。 */
  verdict: "clear" | "needsReview" | "blocked"
}

function countOccurrences(text: string, term: string): number {
  if (term === "") return 0
  let count = 0
  let from = 0
  for (;;) {
    const at = text.indexOf(term, from)
    if (at === -1) break
    count++
    from = at + term.length
  }
  return count
}

/**
 * 确定性扫描：按规则表逐词检测；命中聚合次数。
 * 输出顺序 = 规则表输入序（ban > warn > review 不重排，保持规则声明序）。
 * actionPriority 仅用于 verdict 计算，不改变 hits 顺序。
 */
export function scanSensitiveWords(text: string, rules: SensitiveWordRule[]): SensitiveScanResult {
  const hits: SensitiveHit[] = []
  for (const rule of rules) {
    const count = countOccurrences(text, rule.term)
    if (count > 0) {
      hits.push({ term: rule.term, action: rule.action, category: rule.category, count })
    }
  }
  const verdict: SensitiveScanResult["verdict"] = hits.some((h) => h.action === "ban")
    ? "blocked"
    : hits.some((h) => h.action === "warn")
      ? "needsReview"
      : "clear"
  return { hits, verdict }
}

/** 预置骨架词表（分类演示；实际项目词表由配置注入后合并）。 */
export const BUILTIN_SENSITIVE_RULES: SensitiveWordRule[] = [
  { term: "TODO_EXPIRED_CERT", action: "ban", category: "certificate-placeholder" },
]

/**
 * 合并规则表：项目词表覆盖内置同名 term（后到者优先），其余追加。
 * 确定性：同输入同输出（内置在前、项目在后按序去重）。
 */
export function mergeSensitiveRules(builtin: SensitiveWordRule[], project: SensitiveWordRule[]): SensitiveWordRule[] {
  const projectTerms = new Set(project.map((p) => p.term))
  return [...builtin.filter((b) => !projectTerms.has(b.term)), ...project]
}

/** 发布门语义：blocked → 拒绝发布；needsReview → 放行但要求复核记录；clear → 直接放行。 */
export function gatePublishing(result: SensitiveScanResult): { allowed: boolean; requirement?: string } {
  if (result.verdict === "blocked") {
    return { allowed: false, requirement: `存在 ban 级敏感词命中 ${result.hits.filter((h) => h.action === "ban").length} 项，拒绝发布` }
  }
  if (result.verdict === "needsReview") {
    return { allowed: true, requirement: "存在 warn 级命中，放行但须人工复核留痕" }
  }
  return { allowed: true }
}
