/**
 * module-heat-store.ts — 运行热力的会话级收集器（运动热力图数据入口）。
 *
 * 职责：
 * - 初始化时把自己注册成 `module-heat.ts` 的 sink（唯一写入通道）；
 * - 维护本次会话的命中窗口（环形缓冲）、聚合热度与未接线统计所需原料；
 * - 节流落盘 `.novel/telemetry/module-heat.json`（best-effort，失败不影响主流程）；
 * - 落盘由 app 级轮询 `startModuleHeatFlushLoop` 驱动（不依赖任何视图挂载），
 *   启动时 `hydrate` 回填上一次会话窗口（每个项目一次，切换项目重新回填）；
 * - 落盘前必须先回填：`saveHeatSnapshot` 是整文件覆盖写，未回填就写会把上次会话的
 *   快照抹掉（B5）。所有入口（app 轮询 / 视图手动落盘 / 退出补写）共用同一个在飞守卫
 *   与同一套「先 hydrate 再 flush」序列（B14）。
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
  /**
   * 已回填的项目路径（null = 本次会话尚未回填）。
   *
   * B6：必须是 per-project 而非全局布尔——store 是全局单例、快照路径按 projectPath 分流，
   * 用布尔会在切项目后不再回填，并把 A 项目的窗口写进 B 项目的快照文件。
   */
  hydratedFor: string | null
  install: () => void
  record: (hit: ModuleHit) => void
  reset: () => void
  /**
   * 从 `.novel/telemetry/module-heat.json` 回填该项目的上一次会话窗口。
   *
   * - 同一项目重复调用是幂等的（不重复读盘）；
   * - 项目切换时会重新回填，并**丢弃上一个项目的窗口**（不把 A 的 hits 带进 B）；
   * - 在飞期间发起的并发请求复用同一份回填 promise，避免重复读盘与竞态覆盖。
   */
  hydrate: (projectPath: string | null) => Promise<void>
  /**
   * 显式落盘（项目路径未知时跳过，不报错）。
   *
   * 语义保证：
   * - **未回填绝不覆盖写**：先 `hydrate` 该项目，回填未完成/被切走则直接返回（B5）；
   * - **单飞**：已有一次落盘在飞时复用同一个 promise，所有入口不会并发写同一文件（B14）。
   */
  flush: (projectPath: string | null) => Promise<void>
  /** 当前聚合热度（派生值，按需计算避免每帧重算）。 */
  heatMap: () => Map<string, ModuleHeat>
}

/**
 * 在飞的回填任务（同一项目只跑一份）。
 *
 * 视图挂载、app 轮询 tick、`flush` 自检三条路径可能同时要求回填；
 * 若只靠 `hydratedFor` 早退，后来者会在快照**尚未读完**时就以为已回填，
 * 于是 flush 先写盘、回填后合并 → 覆盖写丢掉上次会话窗口。故按项目单飞。
 */
let hydrateInFlight: { projectPath: string; promise: Promise<void> } | null = null
/** 回填代际：切项目时递增，使在飞的旧项目回填结果作废（不把 A 的快照混进 B）。 */
let hydrateSeq = 0
/** 在飞的落盘任务：视图手动落盘与 app 轮询共用，避免并发覆盖写同一文件。 */
let flushInFlight: Promise<void> | null = null

export const useModuleHeatStore = create<ModuleHeatState>((set, get) => ({
  hits: [],
  sessionStartedAt: Date.now(),
  lastFlushAt: Date.now(),
  pendingSinceFlush: 0,
  installed: false,
  hydratedFor: null,

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
      hydratedFor: null,
    })
  },

  hydrate: (projectPath) => {
    // 无项目路径时保持「未回填」，等路径就绪后再读。
    if (!projectPath) return Promise.resolve()
    // 同一项目已回填（B6：per-project，不是全局布尔）→ 幂等早退。
    if (get().hydratedFor === projectPath) return Promise.resolve()
    // 同项目的回填在飞 → 复用同一份 promise（不让后来者提前认为「已回填」）。
    if (hydrateInFlight !== null && hydrateInFlight.projectPath === projectPath) {
      return hydrateInFlight.promise
    }

    const seq = ++hydrateSeq
    // 切换前的项目：非 null 且与目标不同 ⇒ 本次是跨项目切换，必须丢弃旧窗口。
    const previous = get().hydratedFor
    // 首轮回填还在飞（hydratedFor 还是 null）时切项目，窗口里装的是旧项目的实时命中：
    // 同样按「切换」处理，否则旧项目的 hits 会被合并进新项目（B6）。
    const previousInFlight = hydrateInFlight?.projectPath ?? null
    const switching =
      (previous !== null && previous !== projectPath) ||
      (previousInFlight !== null && previousInFlight !== projectPath)
    const run = (async () => {
      const snapshot = await loadHeatSnapshot(projectPath)
      // 回填期间项目又被切走（更新的代际已发起）：本次结果作废，且不写 hydratedFor。
      if (seq !== hydrateSeq) return
      set((state) => {
        // 切项目：base 为空 ⇒ 上一个项目的 hits 不进入本项目的窗口/快照文件（B6）。
        const base = switching ? [] : state.hits
        // 快照是上次会话窗口，本次会话命中在其后：合并后按时间排序，仍受环形缓冲上限约束。
        // sessionStartedAt 保持本次会话时刻（快照里的旧起点不覆盖），避免文件谎报会话起点。
        const merged =
          snapshot && snapshot.hits.length > 0
            ? [...snapshot.hits, ...base].sort((a, b) => a.at - b.at)
            : base
        return {
          hydratedFor: projectPath,
          hits: merged.slice(-DEFAULT_HEAT_CAPACITY),
          // 切项目后「未落盘条数」属于旧项目，不能带进新项目的落盘判定。
          pendingSinceFlush: switching ? 0 : state.pendingSinceFlush,
        }
      })
    })()
    hydrateInFlight = { projectPath, promise: run }
    return run.finally(() => {
      if (hydrateInFlight !== null && hydrateInFlight.promise === run) hydrateInFlight = null
    })
  },

  flush: (projectPath) => {
    if (!projectPath) return Promise.resolve()
    // B14：在飞守卫下沉到 store —— 轮询 / 视图「立即落盘」/ 退出补写共用同一次写盘。
    if (flushInFlight !== null) return flushInFlight

    const run = (async () => {
      // B5：先回填再写。整文件覆盖写会在未回填时抹掉上一次会话的快照。
      if (get().hydratedFor !== projectPath) await get().hydrate(projectPath)
      // 回填没成功（无路径/被切走）→ 绝不覆盖写。
      if (get().hydratedFor !== projectPath) return

      const state = get()
      if (state.pendingSinceFlush === 0) return
      const now = Date.now()
      const saved = await saveHeatSnapshot(projectPath, state.sessionStartedAt, state.hits, now)
      if (saved) set({ lastFlushAt: now, pendingSinceFlush: 0 })
    })()
    flushInFlight = run
    return run.finally(() => {
      if (flushInFlight === run) flushInFlight = null
    })
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
/** 本轮 tick 是否在飞（回填 + 落盘串行完成前不再叠加新 tick）。 */
let ticking = false

/**
 * 启动 app 级落盘轮询：热力落盘不再依赖热力图视图挂载。
 *
 * 每个 tick 做「醒来 → 回填 → 问 shouldFlushHeat → flush」：
 * - **先回填**（B5）：冷启动未开热力图页时，第一次写盘也必须是「旧窗口 + 新命中」；
 *   没等回填就写会用本次会话窗口整文件覆盖，把上一次会话的快照抹掉。
 * - 节流窗口/批量阈值仍由纯函数 `shouldFlushHeat` 判定，不在这里另写一套节流。
 * - 在飞守卫已在 store 的 `flush` 内部（B14），此处只需避免 tick 自身堆叠。
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
    if (ticking) return
    const projectPath = resolveProjectPath()
    if (!projectPath) return
    ticking = true
    void (async () => {
      // B5：回填必须早于任何覆盖写；失败/无快照也先把 hydratedFor 定下来，不会压掉旧快照。
      await useModuleHeatStore.getState().hydrate(projectPath)
      const state = useModuleHeatStore.getState()
      if (!shouldFlushHeat(state, Date.now())) return
      await state.flush(projectPath)
    })().finally(() => {
      ticking = false
    })
  }, tickMs)
  flushTimer = timer
  return () => {
    clearInterval(timer)
    if (flushTimer === timer) flushTimer = null
  }
}
