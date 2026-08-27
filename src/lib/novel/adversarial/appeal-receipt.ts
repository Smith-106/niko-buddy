/**
 * appeal-receipt.ts — v2.6.5 D4: 运行保障（申诉回执 + 稳定性）
 *
 * 蓝图 `docs/p0/blueprint-v265-20260826.md` D4：
 *   - 回执三块（因子链/基线版本/对照锚点——schema 校验非空，缺任一块编辑拒收）
 *   - 回执状态机（pending→ready→accepted/rejected→reject 可环回 draft）
 *   - 稳定性判定 N≥3 && |max-min|≤0.5
 *
 * 执行纪律: ADR-19 零 LLM / 零 IO；Draft-first
 */

// ============================================================================
// 申诉回执（D4）
// ============================================================================

/** 回执三块（缺任一块编辑拒收）。 */
export interface AppealReceipt {
  receiptId: string
  /** 块1：因子链（本维分数由哪些子因子相加——可读解释）。 */
  factorChain: string[]
  /** 块2：基线版本（比对所用基线——如 v2.6.4）。 */
  baselineVersion: string
  /** 块3：对照锚点（引用同类章节/历史阈值出处）。 */
  referenceAnchors: string[]
  /** 结论（通过/降级/拦截）。 */
  verdict: "passed" | "degraded" | "blocked"
  /** 置信度（高/中/低）。 */
  confidence: "high" | "medium" | "low"
  /** 降级记录（无/原因）。 */
  degradationNote: string
  /** 人话摘要。 */
  plainSummary: string
}

/** 回执状态机。 */
export type ReceiptState = "pending" | "ready" | "accepted" | "rejected" | "draft"

const RECEIPT_TRANSITIONS: Record<ReceiptState, ReceiptState[]> = {
  pending: ["ready"],
  ready: ["accepted", "rejected"],
  accepted: [],
  rejected: ["draft"], // 环回：reject → draft 可重算
  draft: ["ready"],
}

/** 回执状态机（非法迁移 throw）。 */
export class ReceiptStateMachine {
  private state: ReceiptState = "pending"

  transition(to: ReceiptState): void {
    const allowed = RECEIPT_TRANSITIONS[this.state]
    if (!allowed.includes(to)) {
      throw new Error(`[appeal-receipt] 非法迁移: ${this.state} → ${to}`)
    }
    this.state = to
  }

  get current(): ReceiptState {
    return this.state
  }
}

/** 回执三块完整性校验（缺任一块 → 拒收）。 */
export function validateReceipt(receipt: AppealReceipt): string[] {
  const errors: string[] = []
  if (!receipt.receiptId || receipt.receiptId.length === 0) errors.push("receiptId 不能为空")
  if (receipt.factorChain.length === 0) errors.push("因子链缺失（块1）")
  if (!receipt.baselineVersion || receipt.baselineVersion.length === 0) errors.push("基线版本缺失（块2）")
  if (receipt.referenceAnchors.length === 0) errors.push("对照锚点缺失（块3）")
  if (!receipt.plainSummary || receipt.plainSummary.length === 0) errors.push("人话摘要不能为空")
  return errors
}

// ============================================================================
// 稳定性判定（D4）
// ============================================================================

/**
 * 稳定性判定：N≥3 且 |max-min|≤0.5 即稳定。
 * 纯函数：输入多次评分，输出稳定判定。
 */
export function isStable(scores: number[], maxSpread = 0.5): boolean {
  if (scores.length < 3) return false
  const max = Math.max(...scores)
  const min = Math.min(...scores)
  return max - min <= maxSpread
}
