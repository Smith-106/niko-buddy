/**
 * draft-guard.ts — v2.7.0 Draft-first 守卫（结案只落 pending/ready）
 *
 * 蓝图 `docs/p0/blueprint-v270-20260828.md`：
 *   - 冷评结案只落 pending/ready 草稿（不直写正式正文）
 *   - 换模型硬门触发后进 pending 重评不回填正文
 *
 * 执行纪律: ADR-19 零 LLM / 零 IO；纯函数
 */

// ============================================================================
// Draft-first 守卫
// ============================================================================

/** 落盘目标。 */
export type DraftTarget = "pending" | "ready" | "formal"

/** 守卫结果。 */
export interface DraftGuardResult {
  /** 是否合法（只落 pending/ready）。 */
  allowed: boolean
  /** 目标层。 */
  target: DraftTarget
}

/**
 * Draft-first 守卫（纯函数——确定性）。
 * 输入：目标层；输出：是否允许。
 * 语义：pending/ready 允许；formal（正式正文）拒绝——AI 输出先进草稿。
 */
export function guardDraft(target: DraftTarget): DraftGuardResult {
  return { allowed: target === "pending" || target === "ready", target }
}
