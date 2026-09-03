/**
 * 53 号报告 P1-3: critic 防伪完成门 (open-write-studio verify_completion.py
 * 模式, MIT 借模式; QMAI 纯函数 TS 实现, 零 IO 零 LLM)。
 *
 * 语义 (对齐 open-write-studio):
 *  - _compute_chapter_hash: SHA-256 of artifact-stripped content → QMAI 用
 *    computeCheckpointDigest 同源摘要 (checkpoint-digest.ts, 既有实现);
 *  - _check_hash_binding (STALE_ARTIFACT): 审查绑定章节 hash 与当前章不匹配
 *    → 旧审查作废, 不得宣称完成;
 *  - _validate_critic_substance (HOLLOW_ARTIFACT/INSUFFICIENT_FINDINGS):
 *    PASS/ADVANCE 断言但零定位发现 → 空 PASS 自夸失败; QMAI 阈值 ≥3 定位发现
 *    (LOCATED_FINDING_PATTERN 语义: 数字定位 + ≥10 字符原文引用)。
 *
 * 与既有防幻觉检查 (review-scoring runAntiHallucinationChecks 软告警) 的关系:
 * 新 gate 是硬完成门 (零 agent 判断), 防伪只影响「完成」语义, 不阻断审查
 * 结果展示 (Draft-first: 审查可看, 完成态不可宣称)。
 */

import { computeCheckpointDigest } from "./checkpoint-digest"

/** 定位发现判定: evidence 含定位标记 (章/段/行数字) + ≥10 字符原文引用。 */
export function countLocatedFindings(
  results: ReadonlyArray<{ severity: string; message: string; evidence?: string }>,
  chapterBody: string,
): number {
  let count = 0
  for (const r of results) {
    const ev = (r.evidence ?? "").trim()
    if (ev.length < 10) continue
    const hasNumericLocator = /(?:第?\s*\d+\s*(?:章|节|段|页|行)|chapter\s*\d+|[（(]\d+[)）])/i.test(ev)
    if (!hasNumericLocator) continue
    // 原文片段引用判定: 剥离定位前缀后 ≥10 字符与正文匹配 (空白归一化)
    const normalizedBody = chapterBody.replace(/\s+/g, "")
    const normalizedEv = ev.replace(/\s+/g, "")
    const stripped = normalizedEv.replace(/^第?\s*\d+\s*(?:章|节|段|页|行)\s*[|:：]?/, "")
    if (stripped.length >= 10 && normalizedBody.includes(stripped.slice(0, 80))) {
      count += 1
    }
  }
  return count
}

/** 完成门结果。 */
export interface ReviewCompletionGateResult {
  passed: boolean
  /** 失败原因码: HOLLOW_PASS (全 pass 断言但定位发现 < 阈值) /
   *  INSUFFICIENT_FINDINGS / STALE_ARTIFACT。 */
  failures: Array<"HOLLOW_PASS" | "INSUFFICIENT_FINDINGS" | "STALE_ARTIFACT">
  locatedFindings: number
  minLocatedFindings: number
  chapterHash: string
  boundChapterHash?: string
}

/** 章节内容摘要 (SHA-256, 复用 checkpoint-digest 同源实现)。 */
export async function computeChapterHash(content: string): Promise<string> {
  return computeCheckpointDigest(content)
}

/**
 * checkReviewCompletionGate (53 号报告 P1-3 权威入口, 纯函数):
 *  - boundChapterHash 存在且 ≠ chapterHash → STALE_ARTIFACT (章被改, 旧审查作废);
 *  - 定位发现 < minLocatedFindings (默认 3):
 *      - results 无 error/warning (全 pass 断言) → HOLLOW_PASS (空 PASS 自夸);
 *      - 否则 → INSUFFICIENT_FINDINGS;
 *  - 真干净章节豁免: 显式传递 cleanExemption=true (零发现 + 已读 hash 双证据)
 *    时全 pass 场景不判 HOLLOW_PASS (镜像 verify_completion has_findings_section)。
 */
export function checkReviewCompletionGate(input: {
  chapterHash: string
  boundChapterHash?: string
  results: ReadonlyArray<{ severity: string; message: string; evidence?: string }>
  chapterBody: string
  minLocatedFindings?: number
  cleanExemption?: boolean
}): ReviewCompletionGateResult {
  const minLocatedFindings = input.minLocatedFindings ?? 3
  const failures: ReviewCompletionGateResult["failures"] = []
  const locatedFindings = countLocatedFindings(input.results, input.chapterBody)
  if (input.boundChapterHash !== undefined && input.boundChapterHash !== input.chapterHash) {
    failures.push("STALE_ARTIFACT")
  }
  if (locatedFindings < minLocatedFindings) {
    const anyIssue = input.results.some((r) => r.severity === "error" || r.severity === "warning")
    const cleanExempt = input.cleanExemption === true && !anyIssue
    if (!cleanExempt) {
      failures.push(anyIssue ? "INSUFFICIENT_FINDINGS" : "HOLLOW_PASS")
    }
  }
  return {
    passed: failures.length === 0,
    failures,
    locatedFindings,
    minLocatedFindings,
    chapterHash: input.chapterHash,
    boundChapterHash: input.boundChapterHash,
  }
}
