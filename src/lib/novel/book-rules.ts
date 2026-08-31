/**
 * R-inkos-8 (24→25 审计落地): BookRules — 书籍治理约束模型.
 *
 * 吸收来源：reference/inkos packages/core/src/models/book-rules.ts
 * （protagonist.personalityLock/behavioralConstraints、genreLock、
 * prohibitions、eraConstraints、fanficMode、allowedDeviations 等）。
 * 25 号审计三模型盲区扫描第一名（hy3 value 9：QMAI 零命中）。
 *
 * 定位：书籍级统一约束（题材锁/人设锁/禁止项/时代约束/允许偏差白名单），
 * 供写作前预检（plot-forecast 同层）与审稿门控引用。确定性纯函数：
 * prohibitions/genreLock.forbidden 为词面级检测（确定性），人设锁等语义
 * 维度仅做结构治理（存在性/非空），不伪造语义判断。
 * 不构成第二真源（A23）：BookRules 是治理约束声明，权威事实仍在
 * Truth Files/.novel 体系。
 */

export interface ProtagonistRule {
  name: string
  /** 人设性格锁（语义约束声明；供 prompt 注入，不做词面检测）。 */
  personalityLock: string[]
  /** 行为硬约束（语义约束声明）。 */
  behavioralConstraints: string[]
}

export interface GenreLock {
  primary: string
  /** 题材禁止元素（词面级确定性检测）。 */
  forbidden: string[]
}

export interface EraConstraints {
  enabled: boolean
  /** 时代限定词（词面级检测：禁出现晚于时代的元素词）。 */
  anachronismTerms: string[]
  period?: string
  region?: string
}

export interface BookRules {
  version: string
  protagonist?: ProtagonistRule
  genreLock?: GenreLock
  eraConstraints?: EraConstraints
  /** 全书禁止项（词面级确定性检测）。 */
  prohibitions: string[]
  /** 允许偏差白名单：命中禁止项但属于显式豁免的短语。 */
  allowedDeviations: string[]
  fanficMode?: "canon" | "au" | "ooc" | "cp"
}

export const EMPTY_BOOK_RULES: BookRules = {
  version: "1.0",
  prohibitions: [],
  allowedDeviations: [],
}

export interface RuleFinding {
  code: "prohibition_hit" | "genre_forbidden_hit" | "era_anachronism_hit"
  /** 命中的约束词。 */
  term: string
  severity: "error" | "warn"
  message: string
}

export interface BookRulesValidation {
  findings: RuleFinding[]
  /** error 存在 → violate（需修改或显式豁免）；否则 comply。 */
  verdict: "comply" | "violate"
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

/** 白名单检查：命中片段是否落在 allowedDeviations 豁免内（子串豁免语义）。 */
function isDeviationAllowed(hitTerm: string, allowedDeviations: string[]): boolean {
  return allowedDeviations.some((d) => d !== "" && (d.includes(hitTerm) || hitTerm.includes(d)))
}

/**
 * 结构校验 + 词面级约束检测。确定性：相同输入必产生相同输出。
 * findings 顺序：prohibitions（输入序）→ genreLock.forbidden（输入序）→
 * eraConstraints.anachronismTerms（输入序）；白名单豁免项不产出 finding。
 */
export function validateAgainstBookRules(
  rules: BookRules,
  text: string,
): BookRulesValidation {
  const findings: RuleFinding[] = []

  for (const p of rules.prohibitions) {
    if (countOccurrences(text, p) > 0 && !isDeviationAllowed(p, rules.allowedDeviations)) {
      findings.push({
        code: "prohibition_hit",
        term: p,
        severity: "error",
        message: `命中全书禁止项「${p}」`,
      })
    }
  }

  if (rules.genreLock) {
    for (const f of rules.genreLock.forbidden) {
      if (countOccurrences(text, f) > 0 && !isDeviationAllowed(f, rules.allowedDeviations)) {
        findings.push({
          code: "genre_forbidden_hit",
          term: f,
          severity: "error",
          message: `命中题材锁（${rules.genreLock.primary}）禁止元素「${f}」`,
        })
      }
    }
  }

  if (rules.eraConstraints?.enabled) {
    for (const t of rules.eraConstraints.anachronismTerms) {
      if (countOccurrences(text, t) > 0 && !isDeviationAllowed(t, rules.allowedDeviations)) {
        findings.push({
          code: "era_anachronism_hit",
          term: t,
          severity: "warn",
          message: `时代约束（${rules.eraConstraints.period ?? "未标注"}）：疑似穿越元素「${t}」`,
        })
      }
    }
  }

  return {
    findings,
    verdict: findings.some((f) => f.severity === "error") ? "violate" : "comply",
  }
}

/** 渲染治理规则为写作 prompt 片段（空规则返回 ""）。 */
export function bookRulesToPromptFragment(rules: BookRules): string {
  const lines: string[] = []
  if (rules.prohibitions.length > 0) {
    lines.push(`全书禁止项（违反即返稿）：${rules.prohibitions.join("、")}`)
  }
  if (rules.genreLock) {
    lines.push(
      `题材锁：${rules.genreLock.primary}${rules.genreLock.forbidden.length > 0 ? `；禁止元素：${rules.genreLock.forbidden.join("、")}` : ""}`,
    )
  }
  if (rules.protagonist) {
    const p = rules.protagonist
    if (p.personalityLock.length > 0) lines.push(`${p.name} 性格锁：${p.personalityLock.join("、")}`)
    if (p.behavioralConstraints.length > 0) lines.push(`${p.name} 行为约束：${p.behavioralConstraints.join("、")}`)
  }
  if (rules.eraConstraints?.enabled) {
    lines.push(
      `时代约束：${rules.eraConstraints.period ?? ""}${rules.eraConstraints.region ? `（${rules.eraConstraints.region}）` : ""}；禁出现：${rules.eraConstraints.anachronismTerms.join("、")}`,
    )
  }
  if (rules.fanficMode) {
    lines.push(`同人模式：${rules.fanficMode}`)
  }
  if (rules.allowedDeviations.length > 0) {
    lines.push(`允许偏差白名单：${rules.allowedDeviations.join("、")}`)
  }
  if (lines.length === 0) return ""
  return ["## 书籍治理规则（必须遵守）", ...lines.map((l) => `- ${l}`)].join("\n")
}
