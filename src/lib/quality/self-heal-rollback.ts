/**
 * self-heal-rollback.ts — v2.7.2 双门自愈回滚（P0/P1 触发 + 成功率/P95 + 熔断）
 *
 * 蓝图 `docs/p0/blueprint-v272-20260828.md`：
 *   - P0（Consistency）+ P1（Anti-AI）失败触发自动回滚（P2 不自动——仅出建议）
 *   - 成功率 ≥90%（注入 N=100 分母）；P95 恢复 <60s（双条件同达标）
 *   - 熔断：单章连续 ≥3 次章级熔断 + 单波累计 ≥10 次全局熔断
 *   - 只动 pending/ready 草稿（不碰正式正文/正式记忆）
 *
 * 执行纪律: ADR-19 零 LLM / 零 IO；纯函数
 */

// ============================================================================
// 双门自愈回滚
// ============================================================================

/** 自愈成功率硬门（共识定死）。 */
export const HEAL_SUCCESS_RATE = 0.9

/** P95 恢复上限 ms（共识定死）。 */
export const HEAL_P95_MS = 60_000

/** 章级熔断：单章连续失败次数（共识定死）。 */
export const CHAPTER_CIRCUIT_BREAK = 3

/** 波级熔断：单波累计回滚上限（共识定死）。 */
export const WAVE_CIRCUIT_BREAK = 10

/** 熔断后冷却窗口 ms（半开试探恢复）。 */
export const CIRCUIT_COOLDOWN_MS = 300_000

/** 熔断三态。 */
export type CircuitState = "closed" | "open" | "half-open"

/** 熔断状态判定。 */
export interface CircuitStateResult {
  state: CircuitState
  /** 距上次熔断经过 ms。 */
  elapsedMs: number
  /** 半开试探（冷却后允许 1 次试探回滚，成功转 closed 失败回 open）。 */
  halfOpenProbe: boolean
}

/** 门控维度。 */
export type GateDim = "P0" | "P1" | "P2"

/** 单次回滚记录。 */
export interface RollbackEvent {
  chapterId: string
  gate: GateDim
  /** 回滚耗时 ms。 */
  durationMs: number
  /** 回滚是否成功（P0 不变量回绿 + trace 落盘）。 */
  succeeded: boolean
  /** 是否有 trace（禁静默）。 */
  hasTrace: boolean
}

/** 回滚结果。 */
export interface HealResult {
  /** 成功率（成功/总数）。 */
  successRate: number
  /** P95 耗时 ms。 */
  p95Ms: number
  /** 静默回滚数（无 trace——必须=0）。 */
  silentCount: number
  /** 章级熔断触发。 */
  chapterTripped: boolean
  /** 波级熔断触发。 */
  waveTripped: boolean
  /** 熔断后是否停用自动回滚。 */
  circuitBroken: boolean
  /** 双条件达标（≥90% ∧ P95<60s ∧ 静默=0）。 */
  passed: boolean
}

/** P95 计算（确定性排序分位）。 */
function p95(values: number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const idx = Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)
  return sorted[idx]
}

/**
 * 双门自愈回滚评估（纯函数——确定性）。
 * 输入：回滚事件序列（注入 N=100）；输出：成功率/P95/静默/熔断判定。
 * 语义：P0/P1 事件计入分母；P2 不自动回滚（跳过）；熔断=单章连续 ≥3 失败 或 单波 ≥10 次。
 */
export function evaluateSelfHeal(events: RollbackEvent[]): HealResult {
  const healable = events.filter((e) => e.gate === "P0" || e.gate === "P1")
  const total = healable.length
  const succeeded = healable.filter((e) => e.succeeded && e.hasTrace).length
  const silentCount = healable.filter((e) => !e.hasTrace).length
  const successRate = total === 0 ? 0 : succeeded / total
  const p95Ms = p95(healable.map((e) => e.durationMs))

  // 章级熔断：任一章节连续 ≥3 次失败
  const byChapter = new Map<string, number>()
  let chapterTripped = false
  for (const e of healable) {
    const streak = byChapter.get(e.chapterId) ?? 0
    const next = e.succeeded ? 0 : streak + 1
    byChapter.set(e.chapterId, next)
    if (next >= CHAPTER_CIRCUIT_BREAK) chapterTripped = true
  }
  // 波级熔断：单波累计 ≥10 次
  const waveTripped = total >= WAVE_CIRCUIT_BREAK
  const circuitBroken = chapterTripped || waveTripped
  return {
    successRate,
    p95Ms,
    silentCount,
    chapterTripped,
    waveTripped,
    circuitBroken,
    passed: successRate >= HEAL_SUCCESS_RATE && p95Ms < HEAL_P95_MS && silentCount === 0,
  }
}

/**
 * 熔断三态判定（纯函数——确定性）。
 * 语义：closed=自动回滚可用；open=熔断（自动回滚停用转人工）；half-open=冷却窗口后允许 1 次试探，成功转 closed 失败回 open。
 */
export function circuitState(tripped: boolean, elapsedMs: number, probeSucceeded: boolean | null): CircuitStateResult {
  if (!tripped) return { state: "closed", elapsedMs, halfOpenProbe: false }
  if (elapsedMs < CIRCUIT_COOLDOWN_MS) return { state: "open", elapsedMs, halfOpenProbe: false }
  if (probeSucceeded === null) return { state: "half-open", elapsedMs, halfOpenProbe: true }
  return probeSucceeded ? { state: "closed", elapsedMs, halfOpenProbe: true } : { state: "open", elapsedMs, halfOpenProbe: true }
}
