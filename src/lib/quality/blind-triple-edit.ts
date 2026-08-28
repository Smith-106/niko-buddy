/**
 * blind-triple-edit.ts — v2.6.10 D5: 双盲三编辑（观测——视角分裂防同源污染）
 *
 * 蓝图 `docs/p0/blueprint-v2610-20260828.md` D5：
 *   - 三编辑独立评审（双盲——互不可见）
 *   - ContextPack 视角分裂（差异化分发——防三份同源改写）
 *   - 共识收敛率（两两 diff 共识区块占比）
 *
 * 执行纪律: ADR-19 零 LLM / 零 IO；纯函数
 */

// ============================================================================
// 双盲三编辑（观测）
// ============================================================================

/** 编辑视角（ContextPack 分裂——差异化分发）。 */
export const EDITOR_PERSPECTIVES = ["structure", "voice", "continuity"] as const

export type EditorPerspective = (typeof EDITOR_PERSPECTIVES)[number]

/** 双盲评审结果。 */
export interface TripleEditResult {
  /** 三编辑产出（视角分裂——防同源污染）。 */
  outputs: Record<EditorPerspective, string>
  /** 共识收敛率（两两 diff 共识区块占比）。 */
  consensusRate: number
  /** 观测通道标记（不挡结案）。 */
  observationOnly: true
}

/**
 * 共识收敛率（纯函数——确定性）。
 * 输入：三编辑产出；输出：两两共识区块占比（≥阈值 0.6 视为收敛）。
 */
export function consensusRate(a: string, b: string, c: string): number {
  const pairs = [
    [a, b],
    [a, c],
    [b, c],
  ]
  let total = 0
  for (const [x, y] of pairs) {
    const minLen = Math.min(x.length, y.length)
    if (minLen === 0) continue
    let common = 0
    for (let i = 0; i < minLen; i++) {
      if (x[i] === y[i]) common++
    }
    total += common / minLen
  }
  return total / pairs.length
}

/** 共识阈值（冻结——≥0.6 视为收敛）。 */
export const CONSENSUS_THRESHOLD = 0.6

/**
 * 双盲三编辑（纯函数——确定性）。
 * 输入：三视角产出；输出：共识收敛率 + 观测标记。
 */
export function evaluateTripleEdit(
  outputs: Record<EditorPerspective, string>,
): TripleEditResult {
  return {
    outputs,
    consensusRate: consensusRate(outputs.structure, outputs.voice, outputs.continuity),
    observationOnly: true,
  }
}
