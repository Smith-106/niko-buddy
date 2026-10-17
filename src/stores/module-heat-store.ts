/**
 * module-heat-store.ts — 运行热力的会话级收集器（运动热力图数据入口）。
 *
 * 职责：
 * - 初始化时把自己注册成 `module-heat.ts` 的 sink（唯一写入通道）；
 * - 维护本次会话的命中窗口（环形缓冲）、聚合热度与未接线统计所需原料；
 * - 节流落盘 `.novel/telemetry/module-heat.json`（best-effort，失败不影响主流程）。
 *
 * 纯函数聚合全部委托 `lib/novel/module-heat.ts`；本文件只负责状态与 IO 边界。
 *
 * @license MIT © Niko Buddy
 */

import { create } from "zustand"
import {
  DEFAULT_HEAT_CAPACITY,
  aggregateHeat,
  appendHit,
  saveHeatSnapshot,
  setModuleHeatSink,
  type ModuleHeat,
  type ModuleHit,
} from "@/lib/novel"

/** 落盘节流窗口（ms）：命中密集时不每条都写盘。 */
const FLUSH_INTERVAL_MS = 15_000
/** 未落盘命中达到该条数时提前 flush。 */
const FLUSH_BATCH = 80

interface ModuleHeatState {
  /** 本次会话命中窗口（旧→新）。 */
  hits: ModuleHit[]
  /** 会话起始时刻。 */
  sessionStartedAt: number
  /** 上次落盘时刻。 */
  lastFlushAt: number
  /** 已落盘但可能还有新增的标记。 */
  pendingSinceFlush: number
  /** 收集是否已安装（幂等）。 */
  installed: boolean
  install: () => void
  record: (hit: ModuleHit) => void
  reset: () => void
  /** 显式落盘（项目路径未知时跳过，不报错）。 */
  flush: (projectPath: string | null) => Promise<void>
  /** 当前聚合热度（派生值，按需计算避免每帧重算）。 */
  heatMap: () => Map<string, ModuleHeat>
}

export const useModuleHeatStore = create<ModuleHeatState>((set, get) => ({
  hits: [],
  sessionStartedAt: Date.now(),
  lastFlushAt: Date.now(),
  pendingSinceFlush: 0,
  installed: false,

  install: () => {
    if (get().installed) return
    setModuleHeatSink((hit) => get().record(hit))
    set({ installed: true })
  },

  record: (hit) => {
    set((state) => ({
      hits: appendHit(state.hits, hit, DEFAULT_HEAT_CAPACITY),
      pendingSinceFlush: state.pendingSinceFlush + 1,
    }))
  },

  reset: () => {
    set({
      hits: [],
      sessionStartedAt: Date.now(),
      lastFlushAt: Date.now(),
      pendingSinceFlush: 0,
    })
  },

  flush: async (projectPath) => {
    if (!projectPath) return
    const state = get()
    if (state.pendingSinceFlush === 0) return
    const now = Date.now()
    const saved = await saveHeatSnapshot(projectPath, state.sessionStartedAt, state.hits, now)
    if (saved) set({ lastFlushAt: now, pendingSinceFlush: 0 })
  },

  heatMap: () => aggregateHeat(get().hits),
}))

/** 是否该触发一次节流落盘（供视图/定时器判断）。 */
export function shouldFlushHeat(state: {
  pendingSinceFlush: number
  lastFlushAt: number
}, now: number): boolean {
  if (state.pendingSinceFlush === 0) return false
  return state.pendingSinceFlush >= FLUSH_BATCH || now - state.lastFlushAt >= FLUSH_INTERVAL_MS
}
