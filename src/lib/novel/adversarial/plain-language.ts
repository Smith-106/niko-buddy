/**
 * plain-language.ts — v2.6.5 D3: 文档三件套（术语白话 + stub 图例 + 重标定对照表）
 *
 * 蓝图 `docs/p0/blueprint-v265-20260826.md` D3：
 *   - 术语→白话映射（加注不删术语、双读）
 *   - stub 图例（[STUB]=未实现占位非缺陷）
 *   - buildRecalibrationSheet(chapterId) → RecalibrationRow（纯函数可重放）
 *
 * 执行纪律: ADR-19 零 LLM / 零 IO；Draft-first
 */

// ============================================================================
// 术语→白话映射（D3）
// ============================================================================

/** 术语映射表（检测侧 + 写作侧——7 团队共识清单）。 */
export const PLAIN_LANGUAGE_MAP: Record<string, string> = {
  LLR: "AI 味分值（像机器写 vs 像人写的概率比，越大越像 AI）",
  "对抗回归集": "作弊样本库（专收「伪装人写」的 AI 文本，考防骗力）",
  "分层召回": "分桶查全率（按文体/篇幅分段，查有无漏判）",
  "原笔指纹": "作者笔迹 DNA（本人历史正文提炼的稳定文风特征）",
  "漂移阈值": "跑偏红线（文风偏离指纹达此值即判异常）",
  ContextPack: "上下文包（评审时携带的章节上下文）",
  "六维 overall": "整体分（悬疑张力/节奏/勾子等六维综合）",
  thril: "悬疑张力",
  pacing: "节奏",
  pull: "勾子",
  "Consistency(P0)": "一致性硬门（最高优先级）",
  "Anti-AI(P1)": "防 AI 门（次高优先级）",
  "Quality(P2)": "质量门（最低优先级）",
  "重标定": "重打分",
  "漂移幅度": "分数涨跌了多少",
  "因子链": "这个分怎么算出来的",
  "基线版本": "跟哪一稿比",
  "责任判官": "谁打的分",
  "L9 复验": "终稿级再审一遍",
}

/** 术语→白话（加注不删术语——双读）。 */
export function plainLanguage(term: string): string {
  return PLAIN_LANGUAGE_MAP[term] ?? term
}

/** 映射覆盖断言辅助（全部维度术语都有白话）。 */
export function assertCoverage(terms: string[]): string[] {
  return terms.filter((t) => !(t in PLAIN_LANGUAGE_MAP))
}

// ============================================================================
// stub 图例（D3）
// ============================================================================

/** stub 图例（统一标注——防误读为缺陷）。 */
export const STUB_LEGEND = {
  marker: "[STUB]",
  meaning: "未实现占位（非缺陷）——数据待运营期回填",
  policy: "stub 不产出任何阳性/缺陷结论；显式标注「测试桩/未启用」",
} as const

// ============================================================================
// 重标定对照表（D3——编辑可签字的实物）
// ============================================================================

/** 对照表行（一行=一章，编辑逐行勾「认可/退回」）。 */
export interface RecalibrationRow {
  chapterId: string
  /** 重标定前各维分数（旧 L9 报告）。 */
  scoreBefore: Record<string, number>
  /** 重标定后各维分数（新 L9 复验）。 */
  scoreAfter: Record<string, number>
  /** 漂移幅度 |Y-X|（按维）。 */
  driftMagnitude: Record<string, number>
  /** 责任判官。 */
  judgeId: string
  /** 编辑签字位（留白）。 */
  editorSign: string | null
}

/**
 * 构建重标定对照表（纯函数——输入只读旧报告+新复验，无副作用，可重放）。
 */
export function buildRecalibrationSheet(
  chapterId: string,
  scoreBefore: Record<string, number>,
  scoreAfter: Record<string, number>,
  judgeId: string,
): RecalibrationRow {
  const driftMagnitude: Record<string, number> = {}
  for (const dim of Object.keys(scoreBefore)) {
    const after = scoreAfter[dim] ?? 0
    driftMagnitude[dim] = Math.abs(after - (scoreBefore[dim] ?? 0))
  }
  return { chapterId, scoreBefore, scoreAfter, driftMagnitude, judgeId, editorSign: null }
}
