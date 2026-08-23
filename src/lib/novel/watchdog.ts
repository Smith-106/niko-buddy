/**
 * watchdog.ts — T34 哨兵硬化：无 token 卡死检测（N 秒无新 token → block 回落锚点）。
 *
 * ## 职责（TASK-P6-34 / T34）
 *   流式生成期间，若连续 N 秒没有新 token 到达（上游挂死 / 网络黑洞 / provider
 *   静默断流），判定为卡死并给出 `block_fallback` 动作——调用方据此中断当前流、
 *   回落锚点（resume_checkpoint / stage-output journal 缓存工件）重入。
 *
 * ## 定位与边界
 *   - **只检测不执行回落**：本模块是纯机械判定器（ADR-19 零 IO/零 LLM/零时钟读取，
 *     now 全部由调用方注入），实际的中断与锚点回落在编排层 seam 执行。
 *   - 与 budget-counters.ts 互补：budget 管「花多久/花多少 token」，watchdog 管
 *     「还活着吗」。二者共同构成哨兵硬化面。
 *   - 触发一次后进入 triggered 态（持续 block），由调用方 reset() 开启新一轮监控
 *     （对应回落后重新开始生成）。
 */

/** 默认无 token 卡死阈值：90s。可经 createWatchdog 覆盖（telemetry 校准同源）。 */
export const DEFAULT_STALL_TIMEOUT_MS = 90_000

/** watchdog 判定动作：continue = 正常；block_fallback = 卡死，应中断并回落锚点。 */
export type WatchdogAction = "continue" | "block_fallback"

/** poll 的裁定结果。 */
export interface WatchdogVerdict {
  action: WatchdogAction
  /** 距最近一次 token（或监控起点）的 ms。 */
  elapsedMs: number
  /** 本轮监控是否已触发过 block_fallback（触发后持续 true 直到 reset）。 */
  triggered: boolean
}

/** watchdog 运行态（纯数据，可序列化进 checkpoint 以跨重启续判）。 */
export interface WatchdogState {
  /** 监控窗口起点 epoch ms（创建/reset 时设置）。 */
  startedAtMs: number
  /** 最近一次收到 token 的 epoch ms；尚无 token 时为 null（以 startedAtMs 计）。 */
  lastTokenAtMs: number | null
  /** 无 token 卡死阈值 ms。 */
  stallTimeoutMs: number
  /** 本轮是否已触发。 */
  triggered: boolean
  /** 历史累计触发次数（跨 reset 累积，供熔断/遥测）。 */
  triggerCount: number
}

/**
 * 创建 watchdog。stallTimeoutMs 非法（<=0/NaN）时回退 DEFAULT_STALL_TIMEOUT_MS
 * （哨兵阈值不允许被坏配置静默关闭）。
 */
export function createWatchdog(
  opts: { stallTimeoutMs?: number; now?: number } = {},
): WatchdogState {
  const timeout =
    typeof opts.stallTimeoutMs === "number" && Number.isFinite(opts.stallTimeoutMs) && opts.stallTimeoutMs > 0
      ? opts.stallTimeoutMs
      : DEFAULT_STALL_TIMEOUT_MS
  return {
    startedAtMs: typeof opts.now === "number" && Number.isFinite(opts.now) ? opts.now : 0,
    lastTokenAtMs: null,
    stallTimeoutMs: timeout,
    triggered: false,
    triggerCount: 0,
  }
}

/** 收到新 token（含 chunk 内任意增量）：刷新活跃时间戳。时间倒流按不变处理。 */
export function feedToken(state: WatchdogState, now: number): void {
  if (typeof now !== "number" || !Number.isFinite(now)) return
  if (state.lastTokenAtMs !== null && now < state.lastTokenAtMs) return
  state.lastTokenAtMs = now
}

function lastActivityMs(state: WatchdogState): number {
  return state.lastTokenAtMs ?? state.startedAtMs
}

/**
 * 轮询判定：距上次 token ≥ stallTimeoutMs 且本轮未触发 → 触发 block_fallback
 * （落 triggered 标记 + 累计 triggerCount）；已触发 → 持续 block（防重复回落）；
 * 未超时 → continue。
 *
 * 时间倒流保护：now 早于上次活动时刻时 elapsed 按 0 计（单调时钟假设下的防御）。
 */
export function pollWatchdog(state: WatchdogState, now: number): WatchdogVerdict {
  if (state.triggered) {
    return { action: "block_fallback", elapsedMs: Math.max(0, now - lastActivityMs(state)), triggered: true }
  }
  const elapsed = typeof now === "number" && Number.isFinite(now)
    ? Math.max(0, now - lastActivityMs(state))
    : 0
  if (elapsed >= state.stallTimeoutMs) {
    state.triggered = true
    state.triggerCount += 1
    return { action: "block_fallback", elapsedMs: elapsed, triggered: true }
  }
  return { action: "continue", elapsedMs: elapsed, triggered: false }
}

/**
 * 回落完成后开启新一轮监控：清 triggered / lastToken，保留 triggerCount 累计值。
 */
export function resetWatchdog(state: WatchdogState, now: number): void {
  state.startedAtMs = typeof now === "number" && Number.isFinite(now) ? now : state.startedAtMs
  state.lastTokenAtMs = null
  state.triggered = false
}
