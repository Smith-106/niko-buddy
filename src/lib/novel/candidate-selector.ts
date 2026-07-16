/**
 * candidate-selector.ts — fix-loop 候选退化检测选优层 (A19 借鉴点 #4, 零 LLM 机械分)
 *
 * 借鉴点 #4 (ANL-20260715-16proj-selrev F-007): QMAI deep-chapter-generation.ts
 * fix-loop 无候选选择 — currentContent = revisedContent 直接覆盖 (file:1747),
 * 无版本对比/打分。返修可能越改越差 (slop 上升) 却无机制回退。本模块补退化检测层。
 *
 * 诚实标注机械层价值局限 (plan DD-3): autonovel evaluate.py 的 Elo 实质是 LLM
 * judge 打分 (JUDGE_MODEL opus harsh), 非纯 Elo 算法, 不符 A19 零 LLM。QMAI 版
 * 机械层只复用 #1 slopScore 做候选机械分 + 退化检测 (防越改越差), 非真正 Elo
 * 选优。slop 低不代表质量高/一致性高 — 真正选优需 LLM judge, 降级 deferred。
 * 退化检测 (防回退) 是机械层能可靠做到的, 选最优 (正向比较) 超出机械层能力。
 *
 * 与 ADR-17 Q4 fix-loop max_retry=3 + emotion-ledger Circuit Breaker 配套:
 *   - emotion-ledger Circuit Breaker: 情绪债务超阈值 → 熔断转人工 (不再返修)
 *   - candidate-selector (本模块): 返修退化 → 回退前版 (仍继续返修, 但不采用更差版)
 * 两者互补不重叠: 熔断是"停止返修", 退化检测是"返修但选优"。
 *
 * 参考 (只读, 不改上游):
 *   - autonovel/evaluate.py: Elo+LLM judge 架构 (实质 LLM judge, 非纯 Elo)
 *   - QMAI/src/lib/novel/mechanical-slop-detector.ts: slopScore (#1 已落地, 复用)
 */

import { slopScore } from "./mechanical-slop-detector"

/**
 * 退化判定阈值: 当前版 slopPenalty 超过前版 + 此阈值 → 判退化 (回退前版)。
 * 经验值 2 — slop 分波动小于 2 视为正常迭代噪声, 超 2 才判真退化。
 */
export const SLOP_REGRESSION_THRESHOLD = 2

export interface CandidateVersion {
  content: string
  /** 机械 slop 分 (复用 #1 slopScore, 0-10, 越低越好) */
  slopPenalty: number
  /** 返修轮次 (0=初稿, 1+=第 N 次返修) */
  retryCount: number
}

export interface SelectionResult {
  /** 选中的候选 (退化时=前版, 不退化时=当前版) */
  keep: CandidateVersion
  /** 是否检测到退化 */
  regressed: boolean
  /** 退化原因 (regressed=true 时非空) */
  reason: string
}

/**
 * 给候选版本打机械 slop 分 (复用 #1 slopScore, 零 LLM)。
 * slopScore 纯正则+算术, 不调 LLM。
 */
export function scoreCandidate(content: string): number {
  return slopScore(content).slopPenalty
}

/**
 * 退化检测 (零 LLM): 当前版 slop 比前版高 + threshold → 退化。
 * 用 > (严格大于) 而非 >=: curr=prev+threshold 视为边界不退化 (正常迭代噪声)。
 * 返回 regressed=true 时 keep=prev (回退前版)。
 */
export function detectRegression(
  prev: CandidateVersion,
  curr: CandidateVersion,
  threshold: number = SLOP_REGRESSION_THRESHOLD,
): SelectionResult {
  if (curr.slopPenalty > prev.slopPenalty + threshold) {
    return {
      keep: prev,
      regressed: true,
      reason: `返修退化: 第 ${curr.retryCount} 版 slop 分 ${curr.slopPenalty.toFixed(1)} 比第 ${prev.retryCount} 版 ${prev.slopPenalty.toFixed(1)} 高 ${threshold}+ (越改越 AI 味), 回退前版`,
    }
  }
  return { keep: curr, regressed: false, reason: "" }
}

/**
 * 从候选列表选最优 (零 LLM): slopPenalty 最低优先, 同分时 retryCount 最小
 * (优先早期版本, 避免越改越差 — DD-2)。
 *
 * 注意机械层局限 (DD-3): slop 低≠质量高, 此函数只按机械 slop 选, 真正质量
 * 比较需 LLM judge (deferred)。fix-loop 主路径用 detectRegression (防退化)
 * 而非此函数 (正向选优), 此函数供未来 LLM judge 增强或独立场景用。
 */
export function selectBestCandidate(candidates: CandidateVersion[]): CandidateVersion | null {
  if (candidates.length === 0) return null
  return [...candidates].sort((a, b) => {
    // slopPenalty 升序 (低优先); 同分 retryCount 升序 (早期优先)
    if (a.slopPenalty !== b.slopPenalty) return a.slopPenalty - b.slopPenalty
    return a.retryCount - b.retryCount
  })[0]
}
