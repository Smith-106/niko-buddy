/**
 * module-heat-store.ts — 运行热力的会话级收集器（运动热力图数据入口）。
 *
 * 职责：
 * - 初始化时把自己注册成 `module-heat.ts` 的 sink（唯一写入通道）；
 * - 维护本次会话的命中窗口（环形缓冲）、聚合热度与未接线统计所需原料；
 * - 节流落盘 `.novel/telemetry/module-heat.json`（best-effort，失败不影响主流程）；
 * - 落盘由 app 级轮询 `startModuleHeatFlushLoop` 驱动（不依赖任何视图挂载），
 *   启动时 `hydrate` 回填上一次会话窗口（幂等，每个会话只读一次盘）。
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
  loadHeatSnapshot,
  saveHeatSnapshot,
  setModuleHeatSink,
  type ModuleHeat,
  type ModuleHit,
} from "@/lib/novel"

/** 落盘节流窗口（ms）：命中密集时不每条都写盘。 */
const FLUSH_INTERVAL_MS = 15_000
/** 未落盘命中达到该条数时提前 flush。 */
const FLUSH_BATCH = 80
/** 落盘轮询间隔（ms）：只决定「多久醒来判断一次」，节流窗口仍由 shouldFlushHeat 决定。 */
export const FLUSH_TICK_MS = 5_000

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
  /** 是否已尝试从磁盘快照回填（幂等；每个会话只读一次）。 */
  hydrated: boolean
  install: () => void
  record: (hit: ModuleHit) => void
  reset: () => void
  /** 从 `.novel/telemetry/module-heat.json` 回填上一次会话的命中窗口（幂等、best-effort）。 */
  hydrate: (projectPath: string | null) => Promise<void>
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
  hydrated: false,

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
      hydrated: false,
    })
  },

  hydrate: async (projectPath) => {
    // 无项目路径时保持「未回填」，等路径就绪后再读；已有快照/已回填则不再重复读盘。
    if (!projectPath || get().hydrated) return
    set({ hydrated: true })
    const snapshot = await loadHeatSnapshot(projectPath)
    if (!snapshot || snapshot.hits.length === 0) return
    set((state) => {
      // 快照是上次会话窗口，本次会话命中在其后：合并后按时间排序，仍受环形缓冲上限约束。
      // sessionStartedAt 保持本次会话时刻（快照里的旧起点不覆盖），避免文件谎报会话起点。
      const merged = [...snapshot.hits, ...state.hits].sort((a, b) => a.at - b.at)
      return { hits: merged.slice(-DEFAULT_HEAT_CAPACITY) }
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

/** 当前 app 级落盘轮询句柄（重复启动时替换，避免多份定时器叠加写盘）。 */
let flushTimer: ReturnType<typeof setInterval> | null = null
/** 是否已有一次落盘在飞（防止写盘慢于轮询间隔时叠加重复覆盖写）。 */
let flushing = false

/**
 * 启动 app 级落盘轮询：热力落盘不再依赖热力图视图挂载。
 *
 * 只做「醒来 → 问 shouldFlushHeat → flush」这一层，节流窗口/批量阈值仍由纯函数判定，
 * 不在这里另写一套节流。项目路径由调用方注入（store 层不反向依赖 wiki-store）。
 *
 * @param resolveProjectPath 每次 tick 现取项目路径（未打开项目返回 null 即跳过）。
 * @param options.tickMs 轮询间隔，默认 {@link FLUSH_TICK_MS}（测试可注入更小值）。
 * @returns 停止函数（幂等）。
 */
export function startModuleHeatFlushLoop(
  resolveProjectPath: () => string | null,
  options: { tickMs?: number } = {},
): () => void {
  if (flushTimer !== null) {
    clearInterval(flushTimer)
    flushTimer = null
  }
  const tickMs = options.tickMs ?? FLUSH_TICK_MS
  const timer = setInterval(() => {
    if (flushing) return
    const projectPath = resolveProjectPath()
    if (!projectPath) return
    const state = useModuleHeatStore.getState()
    if (!shouldFlushHeat(state, Date.now())) return
    flushing = true
    void state.flush(projectPath).finally(() => {
      flushing = false
    })
  }, tickMs)
  flushTimer = timer
  return () => {
    clearInterval(timer)
    if (flushTimer === timer) flushTimer = null
  }
}
