/**
 * watchdog.spec.ts — T34 无 token 卡死检测收敛测试（N 秒无新 token → block 回落锚点）。
 * 纯函数 + 注入时钟，零 mock。
 */

import { describe, expect, it } from "vitest"
import {
  DEFAULT_STALL_TIMEOUT_MS,
  createWatchdog,
  feedToken,
  pollWatchdog,
  resetWatchdog,
  type WatchdogState,
} from "./watchdog"

describe("createWatchdog", () => {
  it("默认阈值 = DEFAULT_STALL_TIMEOUT_MS（90s）", () => {
    const w = createWatchdog({ now: 1000 })
    expect(DEFAULT_STALL_TIMEOUT_MS).toBe(90_000)
    expect(w.stallTimeoutMs).toBe(90_000)
    expect(w.startedAtMs).toBe(1000)
    expect(w.lastTokenAtMs).toBeNull()
    expect(w.triggered).toBe(false)
    expect(w.triggerCount).toBe(0)
  })

  it("非法阈值回退默认值（哨兵阈值不被坏配置静默关闭）", () => {
    expect(createWatchdog({ stallTimeoutMs: 0 }).stallTimeoutMs).toBe(DEFAULT_STALL_TIMEOUT_MS)
    expect(createWatchdog({ stallTimeoutMs: -1 }).stallTimeoutMs).toBe(DEFAULT_STALL_TIMEOUT_MS)
    expect(createWatchdog({ stallTimeoutMs: Number.NaN }).stallTimeoutMs).toBe(DEFAULT_STALL_TIMEOUT_MS)
    expect(createWatchdog({ stallTimeoutMs: Number.POSITIVE_INFINITY }).stallTimeoutMs).toBe(
      DEFAULT_STALL_TIMEOUT_MS,
    )
  })

  it("自定义阈值生效；缺省 now 回退 0 起点", () => {
    const w = createWatchdog({ stallTimeoutMs: 5000 })
    expect(w.stallTimeoutMs).toBe(5000)
    expect(w.startedAtMs).toBe(0)
  })
})

describe("feedToken / pollWatchdog 基础判定", () => {
  it("未收到 token 时以监控起点计 elapsed；未超时 continue", () => {
    const w = createWatchdog({ stallTimeoutMs: 10_000, now: 0 })
    const v = pollWatchdog(w, 9_999)
    expect(v).toEqual({ action: "continue", elapsedMs: 9_999, triggered: false })
  })

  it("恰好达到阈值触发 block_fallback（>= 语义），triggerCount=1", () => {
    const w = createWatchdog({ stallTimeoutMs: 10_000, now: 0 })
    const v = pollWatchdog(w, 10_000)
    expect(v.action).toBe("block_fallback")
    expect(v.elapsedMs).toBe(10_000)
    expect(w.triggered).toBe(true)
    expect(w.triggerCount).toBe(1)
  })

  it("token 到达刷新活跃时刻，elapsed 从最后 token 起算", () => {
    const w = createWatchdog({ stallTimeoutMs: 10_000, now: 0 })
    feedToken(w, 4_000)
    feedToken(w, 6_000)
    const v = pollWatchdog(w, 12_000)
    expect(v.action).toBe("continue")
    expect(v.elapsedMs).toBe(6_000)
  })

  it("最后一次 token 后超时 → block_fallback", () => {
    const w = createWatchdog({ stallTimeoutMs: 10_000, now: 0 })
    feedToken(w, 50_000)
    const v = pollWatchdog(w, 60_000)
    expect(v.action).toBe("block_fallback")
    expect(v.elapsedMs).toBe(10_000)
  })
})

describe("触发后语义 / reset 回落重开", () => {
  it("触发后持续 block 且不重复累计 triggerCount", () => {
    const w = createWatchdog({ stallTimeoutMs: 1000, now: 0 })
    pollWatchdog(w, 2000)
    const again = pollWatchdog(w, 3000)
    const later = pollWatchdog(w, 999_999)
    expect(again.action).toBe("block_fallback")
    expect(later.action).toBe("block_fallback")
    expect(w.triggerCount).toBe(1)
  })

  it("reset 开启新一轮：清 triggered/lastToken、保留 triggerCount、更新起点", () => {
    const w: WatchdogState = createWatchdog({ stallTimeoutMs: 1000, now: 0 })
    pollWatchdog(w, 2000)
    resetWatchdog(w, 5_000)
    expect(w.triggered).toBe(false)
    expect(w.lastTokenAtMs).toBeNull()
    expect(w.startedAtMs).toBe(5_000)
    expect(w.triggerCount).toBe(1) // 历史累计保留
    expect(pollWatchdog(w, 5_500).action).toBe("continue")
  })

  it("reset 后再次卡死可再次触发（triggerCount 累积为 2）——回落锚点重入循环", () => {
    const w = createWatchdog({ stallTimeoutMs: 1000, now: 0 })
    pollWatchdog(w, 2000)
    resetWatchdog(w, 10_000)
    pollWatchdog(w, 20_000)
    expect(w.triggerCount).toBe(2)
  })
})

describe("时间防御（单调时钟假设下的坏输入钳制）", () => {
  it("时间倒流：poll 早于上次活动 → elapsed 钳制为 0 不误触", () => {
    const w = createWatchdog({ stallTimeoutMs: 1000, now: 10_000 })
    feedToken(w, 11_000)
    const v = pollWatchdog(w, 10_500)
    expect(v.action).toBe("continue")
    expect(v.elapsedMs).toBe(0)
  })

  it("时间倒流的 feed 被忽略（活跃时刻不后退）", () => {
    const w = createWatchdog({ stallTimeoutMs: 1000, now: 0 })
    feedToken(w, 5_000)
    feedToken(w, 3_000)
    expect(w.lastTokenAtMs).toBe(5_000)
  })

  it("非有限 now 的 poll 按 elapsed=0 continue 处理", () => {
    const w = createWatchdog({ stallTimeoutMs: 1000, now: 0 })
    expect(pollWatchdog(w, Number.NaN).action).toBe("continue")
    expect(pollWatchdog(w, Number.POSITIVE_INFINITY).elapsedMs).toBe(0)
  })

  it("非有限的 feed 时间戳被忽略（不污染活跃时刻）", () => {
    const w = createWatchdog({ stallTimeoutMs: 1000, now: 0 })
    feedToken(w, Number.NaN)
    feedToken(w, Number.POSITIVE_INFINITY)
    expect(w.lastTokenAtMs).toBeNull()
    // 起点口径仍生效
    expect(pollWatchdog(w, 1_000).action).toBe("block_fallback")
  })

  it("reset 用非有限 now 保留原起点（不置 NaN 起点）", () => {
    const w = createWatchdog({ stallTimeoutMs: 1000, now: 42 })
    resetWatchdog(w, Number.NaN)
    expect(w.startedAtMs).toBe(42)
  })

  it("负 elapsed 场景（起点晚于 poll 时刻的倒流）钳制为 0 并按 continue", () => {
    const w = createWatchdog({ stallTimeoutMs: 1000, now: 10_000 })
    const v = pollWatchdog(w, 9_999)
    expect(v.elapsedMs).toBe(0)
    expect(v.action).toBe("continue")
  })
})
