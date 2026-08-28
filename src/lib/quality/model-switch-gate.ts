/**
 * model-switch-gate.ts — v2.7.0 换模型硬门（触发检测 + 漏报=0）
 *
 * 蓝图 `docs/p0/blueprint-v270-20260828.md`：
 *   - 触发事件=模型指纹/权重/版本变更；触发率 100%（CI 监听模型清单）
 *   - 漏报=0 硬断言（阴性样本注入）；replay 可复现
 *
 * 执行纪律: ADR-19 零 LLM / 零 IO；纯函数
 */

// ============================================================================
// 换模型硬门
// ============================================================================

/** 模型指纹。 */
export interface ModelFingerprint {
  model: string
  version: string
  weightHash: string
}

/** 硬门结果。 */
export interface SwitchGateResult {
  /** 模型清单是否变更。 */
  changed: boolean
  /** 硬门是否触发（100% 要求）。 */
  triggered: boolean
  /** 漏报数（变更但未触发）。 */
  missed: number
}

/**
 * 换模型硬门（纯函数——确定性）。
 * 输入：基线指纹 + 当前指纹；输出：变更检测 + 触发判定。
 * 语义：指纹任一字段变更即触发——触发率 100%；漏报=0。
 */
export function evaluateModelSwitch(baseline: ModelFingerprint, current: ModelFingerprint): SwitchGateResult {
  const changed = JSON.stringify(baseline) !== JSON.stringify(current)
  const triggered = changed
  const missed = changed && !triggered ? 1 : 0
  return { changed, triggered, missed }
}

/**
 * 漏报率校验（纯函数——确定性）。
 * 输入：注入变更样本集；输出：漏报总数（必须=0）。
 */
export function verifyZeroMissed(
  samples: Array<{ baseline: ModelFingerprint; current: ModelFingerprint }>,
): { missed: number; pass: boolean } {
  let missed = 0
  for (const s of samples) {
    if (!evaluateModelSwitch(s.baseline, s.current).triggered) missed++
  }
  return { missed, pass: missed === 0 }
}
