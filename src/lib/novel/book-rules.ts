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

// ── 64 号实施（63 号共识 §6 P0-3）：同人四模式语义 ──

/** 同人四模式（与 BookRules.fanficMode 同构）。 */
export type FanficMode = "canon" | "au" | "ooc" | "cp"

/**
 * 同人写作策略（从 BookRules 派生，供 validateFanficChapter 与 prompt 注入）。
 * - canon：禁止把 canonLockNames 写成新身份（正典名册锁）；
 * - au：auDeviations 声明式并入 allowedDeviations（设定分叉白名单）；
 * - ooc：撞 personalityLock 必须显式 oocMarkers 标记；
 * - cp：pairing 双方必须都出现在文本（缺一方 → warn）。
 */
export interface FanficPolicy {
  mode: FanficMode
  canonLockNames: string[]
  auDeviations: string[]
  oocMarkers: string[]
  pairing: [string, string] | null
}

export function fanficPolicyFromRules(rules: BookRules): FanficPolicy {
  return {
    mode: rules.fanficMode ?? "canon",
    canonLockNames: [],
    auDeviations: [],
    oocMarkers: ["(OOC)", "（OOC）", "【OOC】", "(ooc)", "[OOC]"],
    pairing: null,
  }
}

/**
 * 同人章节校验（四模式确定性规则；内部先跑词面校验，再叠加模式规则）。
 * fanfic_canon_lock：canon 模式下文本含 personaLock 主语且改写否定锁词。
 * fanfic_ooc_unmarked：ooc 模式下命中性格锁且全文无标记。
 * fanfic_cp_missing_pair：cp 模式下配对缺一方（warn 不 violate）。
 */
export function validateFanficChapter(
  rules: BookRules,
  text: string,
  appearingNames: string[],
): BookRulesValidation {
  const policy = fanficPolicyFromRules(rules)
  const findings: RuleFinding[] = []

  if (policy.mode === "canon" && rules.protagonist) {
    for (const lock of rules.protagonist.personalityLock) {
      if (text.includes(lock) && /(不再|不是|从未|并非|拒绝)/.test(text)) {
        findings.push({
          code: "fanfic_canon_lock",
          term: lock,
          severity: "error",
          message: `canon 模式：正典人设锁「${lock}」被否定改写`,
        })
      }
    }
  }

  if (policy.mode === "ooc" && rules.protagonist) {
    const hasMarker = policy.oocMarkers.some((m) => text.includes(m))
    for (const lock of rules.protagonist.personalityLock) {
      if (text.includes(lock) && !hasMarker) {
        findings.push({
          code: "fanfic_ooc_unmarked",
          term: lock,
          severity: "error",
          message: `ooc 模式：命中性格锁「${lock}」但无 OOC 标记`,
        })
        break
      }
    }
  }

  if (policy.mode === "cp") {
    // 未配置配对时不判定（由 fanfic-canon-import 的 merge proposal 提供 pairing）
    if (policy.pairing) {
      const [a, b] = policy.pairing
      const hasA = appearingNames.some((n) => n.includes(a) || a.includes(n))
      const hasB = appearingNames.some((n) => n.includes(b) || b.includes(n))
      if (!hasA || !hasB) {
        findings.push({
          code: "fanfic_cp_missing_pair",
          term: `${a}/${b}`,
          severity: "warn",
          message: `cp 模式：本组未同时出现 ${a} 与 ${b}`,
        })
      }
    }
  }

  const base = validateAgainstBookRules(rules, text)
  return {
    findings: [...base.findings, ...findings],
    verdict: findings.some((f) => f.severity === "error") || base.verdict === "violate"
      ? "violate"
      : "comply",
  }
}

export const EMPTY_BOOK_RULES: BookRules = {
  version: "1.0",
  prohibitions: [],
  allowedDeviations: [],
}

export interface RuleFinding {
  code:
    | "prohibition_hit"
    | "genre_forbidden_hit"
    | "era_anachronism_hit"
    | "fanfic_canon_lock"
    | "fanfic_ooc_unmarked"
    | "fanfic_cp_missing_pair"
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

/**
 * 64 号实施（P0-3）：AU 模式自动白名单并入——auDeviations 并入
 * allowedDeviations 后再跑词面检测（人设锁仍生效）。纯函数不修改入参。
 */
export function bookRulesWithAuDeviations(rules: BookRules): BookRules {
  if (rules.fanficMode !== "au") return rules
  const policy = fanficPolicyFromRules(rules)
  const merged = new Set([...rules.allowedDeviations, ...policy.auDeviations])
  return { ...rules, allowedDeviations: [...merged] }
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
    const policy = fanficPolicyFromRules(rules)
    lines.push(`同人模式：${rules.fanficMode}`)
    if (rules.fanficMode === "canon") {
      lines.push(`正典名册锁：${policy.canonLockNames.length > 0 ? policy.canonLockNames.join("、") : "全部既有角色"}——禁止改写成新身份`)
    } else if (rules.fanficMode === "au") {
      const deviations = policy.auDeviations
      lines.push(`AU 设定分叉（自动豁免）：${deviations.length > 0 ? deviations.join("、") : "需声明的分叉以【AU】标注"}`)
    } else if (rules.fanficMode === "ooc") {
      lines.push(`OOC 必须显式标注：${policy.oocMarkers.join(" 或 ")}`)
    } else if (rules.fanficMode === "cp") {
      lines.push(policy.pairing ? `CP 配对：${policy.pairing.join(" × ")}` : `CP 配对双方须同时出现（群像章不强制）`)
    }
  }
  if (rules.allowedDeviations.length > 0) {
    lines.push(`允许偏差白名单：${rules.allowedDeviations.join("、")}`)
  }
  if (lines.length === 0) return ""
  return ["## 书籍治理规则（必须遵守）", ...lines.map((l) => `- ${l}`)].join("\n")
}
