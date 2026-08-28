/**
 * commit-discipline.ts — v2.6.7 D4: 原子提交纪律（单章 Draft-first 闭环）
 *
 * 蓝图 `docs/p0/blueprint-v267-20260828.md` D4：
 *   - 粒度=单章 Draft-first 闭环（草稿→accept→回填→status.json 单次更新——禁跨章批量）
 *   - 逐条可 revert
 *
 * 执行纪律: ADR-19 零 LLM / 零 IO；纯函数
 */

// ============================================================================
// 提交粒度检查（单章 Draft-first 闭环）
// ============================================================================

/** 提交范围声明。 */
export interface CommitScope {
  /** 涉及章节（单章闭环=1 章）。 */
  chapterIds: string[]
  /** 是否含 status.json 更新。 */
  touchesStatusJson: boolean
  /** 是否含正式正文回填。 */
  touchesCanonicalContent: boolean
  /** 是否含正式记忆回填。 */
  touchesCanonicalMemory: boolean
}

/** 粒度检查结果。 */
export interface CommitDisciplineResult {
  ok: boolean
  reasons: string[]
}

/**
 * 提交粒度检查：单章 Draft-first 闭环（禁跨章批量）。
 * 纯函数：输入提交范围，输出是否合规。
 */
export function checkCommitDiscipline(scope: CommitScope): CommitDisciplineResult {
  const reasons: string[] = []
  if (scope.chapterIds.length === 0) reasons.push("提交必须声明涉及章节")
  if (scope.chapterIds.length > 1) reasons.push(`禁跨章批量提交（涉及 ${scope.chapterIds.length} 章——应为单章闭环）`)
  if (scope.touchesStatusJson && scope.chapterIds.length !== 1) {
    reasons.push("status.json 更新必须对应单章闭环")
  }
  // 正文/记忆回填必须成对（防「正文已改、记忆未改」中间态）
  if (scope.touchesCanonicalContent !== scope.touchesCanonicalMemory) {
    reasons.push("正式正文与正式记忆回填必须成对（同事务）")
  }
  return { ok: reasons.length === 0, reasons }
}

/** 单章闭环最小单元（草稿→accept→回填→status.json 单次更新）。 */
export const DRAFT_FIRST_CLOSED_LOOP = {
  unit: "单章 Draft-first 闭环",
  steps: ["pending -> ready -> accepted", "回填正式正文 + 正式记忆（同事务）", "status.json 单次更新"],
} as const
