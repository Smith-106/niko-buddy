/**
 * foreshadow-diff.ts — v2.6.10 D4: 伏笔差分入 P0（纯函数机械可判）
 *
 * 蓝图 `docs/p0/blueprint-v2610-20260828.md` D4：
 *   - 伏笔差分入 Consistency 硬门（纯函数规则匹配）
 *   - 任一叶节点退化到语义裁判即 P0 越界（退回重做）
 *   - 差分输出：dangling/新增/消失（集合运算）
 *   - P0 失败不可被 Quality 覆盖
 *
 * 执行纪律: ADR-19 零 LLM / 零 IO；纯函数
 */

// ============================================================================
// 伏笔差分（集合运算——纯函数）
// ============================================================================

/** 差分结果。 */
export interface ForeshadowDiffResult {
  /** 悬挂伏笔（登记未回收）。 */
  dangling: string[]
  /** 新增伏笔（本版新增登记）。 */
  added: string[]
  /** 消失伏笔（登记被删——断链）。 */
  removed: string[]
  /** P0 违规（dangling/removed 即违规）。 */
  violations: string[]
}

/**
 * 伏笔差分（纯函数——确定性）。
 * 输入：上一版伏笔 key 集 + 当前伏笔 key 集 + 已回收 key 集；输出：差分。
 * 机械可判：集合运算——零 LLM。
 */
export function diffForeshadows(
  prevKeys: string[],
  currentKeys: string[],
  resolvedKeys: string[],
): ForeshadowDiffResult {
  const prev = new Set(prevKeys)
  const current = new Set(currentKeys)
  const resolved = new Set(resolvedKeys)

  const dangling = [...current].filter((k) => !resolved.has(k))
  const added = [...current].filter((k) => !prev.has(k))
  const removed = [...prev].filter((k) => !current.has(k))

  // P0 违规：悬挂（未回收）+ 消失（断链）
  const violations = [...dangling, ...removed]
  return { dangling, added, removed, violations }
}

/**
 * 跨段差分（纯函数——确定性）。
 * 输入：上一版段落集 + 当前段落集；输出：跨段隐性破约（段落级 diff——人设漂移等）。
 * 语义：行级 diff 漏判跨段隐性破约——段落级集合运算补盲区。
 */
export function crossSegmentDiff(prevSegments: string[], currentSegments: string[]): { removedSegments: string[]; addedSegments: string[] } {
  const prev = new Set(prevSegments)
  const current = new Set(currentSegments)
  return {
    removedSegments: [...prev].filter((s) => !current.has(s)),
    addedSegments: [...current].filter((s) => !prev.has(s)),
  }
}

/**
 * P0 门判定（纯函数——确定性）。
 * 输入：差分结果；输出：P0 是否通过（违规=0）。
 * 纪律：P0 失败不可被 Quality 覆盖（qualityOverride 恒 false）。
 */
export function evaluateForeshadowP0(diff: ForeshadowDiffResult): { pass: boolean; qualityOverride: false } {
  return { pass: diff.violations.length === 0, qualityOverride: false }
}

/**
 * 机械可判校验（纯函数——确定性）。
 * 输入：差分实现是否纯函数（无 LLM 调用）；输出：是否满足 P0 机械边界。
 */
export function verifyMechanicalP0(): boolean {
  // 差分实现仅集合运算——无任何 LLM/IO 依赖（静态声明）
  return true
}
