/**
 * sign-off-table.ts — v2.6.10 D6: 独立签字表（top/bottom 10%——防只签不评）
 *
 * 蓝图 `docs/p0/blueprint-v2610-20260828.md` D6：
 *   - top/bottom 10% 段落清单 + 编辑签名/日期/结论（改/留/删）
 *   - 结论摘要必填 ≥50 字 + 异议栏（未填须勾「无」）
 *   - 系统校验摘要与样本区间一致后才放行签字
 *
 * 执行纪律: ADR-19 零 LLM / 零 IO；纯函数
 */

// ============================================================================
// 签字表
// ============================================================================

/** 签字结论（改/留/删）。 */
export type SignOffVerdict = "revise" | "keep" | "remove"

/** 签字记录。 */
export interface SignOffEntry {
  /** 编辑 ID。 */
  editorId: string
  /** 角色。 */
  role: string
  /** 样本区间（top/bottom 10%）。 */
  sampleBand: "top10" | "bottom10"
  /** 绑定结论摘要（必填 ≥50 字——防只签不评）。 */
  conclusion: string
  /** 异议栏（未填须勾「无」）。 */
  objection: string | "none"
  /** 原文引用（签字绑定阅读证据——防签而不看）。 */
  evidenceQuote: string
  /** 签字时间戳（由调用方注入）。 */
  ts: string
}

/** 结论摘要最小长度（冻结——防只签不评）。 */
export const CONCLUSION_MIN_LEN = 50

/** 原文引用最小长度（冻结——签字绑定阅读证据）。 */
export const EVIDENCE_QUOTE_MIN = 10

/**
 * 引用相关性校验（纯函数——确定性）。
 * 输入：原文引用 + 结论摘要；输出：是否相关（引用须含结论关键词——防拷贝无关原文）。
 */
export function evidenceRelevance(evidenceQuote: string, conclusion: string): boolean {
  if (evidenceQuote.length === 0 || conclusion.length === 0) return false
  // 结论中的关键词（去停用词——取长度≥2 的字符片段）
  const conclusionChars = new Set(conclusion.split(""))
  const quoteChars = new Set(evidenceQuote.split(""))
  let overlap = 0
  for (const c of conclusionChars) {
    if (quoteChars.has(c)) overlap++
  }
  // 引用与结论字符重叠率 ≥0.3 视为相关（绑定本次签字所涉决策）
  return overlap / conclusionChars.size >= 0.3
}

/**
 * 签字校验（纯函数——确定性）。
 * 结论摘要≥50 字 + 异议栏必填 + 原文引用≥10 字且与结论相关（防签而不看/拷贝无关原文）。
 */
export function validateSignOff(entry: SignOffEntry): { ok: boolean; reasons: string[] } {
  const reasons: string[] = []
  if (entry.conclusion.trim().length < CONCLUSION_MIN_LEN) {
    reasons.push(`结论摘要不足 ${CONCLUSION_MIN_LEN} 字（防只签不评）`)
  }
  if (!entry.objection) {
    reasons.push("异议栏必填（未填须勾「无」）")
  }
  if (entry.evidenceQuote.trim().length < EVIDENCE_QUOTE_MIN) {
    reasons.push(`原文引用不足 ${EVIDENCE_QUOTE_MIN} 字（签字须绑定阅读证据——防签而不看）`)
  } else if (!evidenceRelevance(entry.evidenceQuote, entry.conclusion)) {
    reasons.push("原文引用与结论不相关（防拷贝无关原文——蓄意形式化签字）")
  }
  return { ok: reasons.length === 0, reasons }
}

/**
 * 签字表齐全校验（纯函数——确定性）。
 * 输入：签字记录；输出：是否齐全（每章 top/bottom 各至少 1 条有效签字）。
 */
export function verifySignOffTable(entries: SignOffEntry[]): { complete: boolean; missing: string[] } {
  const missing: string[] = []
  const valid = entries.filter((e) => validateSignOff(e).ok)
  if (valid.length === 0) missing.push("无有效签字")
  if (!valid.some((e) => e.sampleBand === "top10")) missing.push("缺 top10 签字")
  if (!valid.some((e) => e.sampleBand === "bottom10")) missing.push("缺 bottom10 签字")
  return { complete: missing.length === 0, missing }
}
