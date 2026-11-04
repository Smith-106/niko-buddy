import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  writeFile: vi.fn(async () => undefined),
  readFile: vi.fn(async () => ""),
  createDirectory: vi.fn(async () => undefined),
}))

vi.mock("@/commands/fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/commands/fs")>()
  return { ...actual, ...mocks }
})

const { useModuleHeatStore, shouldFlushHeat, startModuleHeatFlushLoop, FLUSH_TICK_MS } =
  await import("./module-heat-store")
const { recordModuleHit, setModuleHeatSink, heatTotals, MODULE_ATLAS } = await import(
  "@/lib/novel"
)

beforeEach(() => {
  setModuleHeatSink(null)
  useModuleHeatStore.getState().reset()
  useModuleHeatStore.setState({ installed: false })
  mocks.writeFile.mockClear()
  mocks.createDirectory.mockClear()
  mocks.readFile.mockClear()
})

describe("module-heat-store", () => {
  it("install 后 recordModuleHit 落入会话窗口", () => {
    useModuleHeatStore.getState().install()
    recordModuleHit({ path: "src/lib/novel/campaign-runner.ts", at: 1, ok: true })
    recordModuleHit({ path: "src/lib/novel/campaign-runner.ts", at: 2, ok: false, detail: "x" })
    expect(useModuleHeatStore.getState().hits).toHaveLength(2)
    const heat = useModuleHeatStore.getState().heatMap()
    expect(heat.get("src/lib/novel/campaign-runner.ts")).toMatchObject({ count: 2, errors: 1 })
  })

  it("install 幂等，重复调用不会重复注册", () => {
    useModuleHeatStore.getState().install()
    useModuleHeatStore.getState().install()
    recordModuleHit({ path: "a.ts", at: 1, ok: true })
    expect(useModuleHeatStore.getState().hits).toHaveLength(1)
  })

  // TASK-006 回归：sink 只在热力图视图里装 → 未开该页时编排层埋点全 no-op。
  // 启动即装（main.tsx）后，任何未挂载视图的时刻埋点都必须落到会话窗口。
  it("启动即 install：不挂载任何视图也能收到埋点（幂等）", () => {
    useModuleHeatStore.getState().install()
    useModuleHeatStore.getState().install()
    useModuleHeatStore.getState().install()
    recordModuleHit({ path: "src/lib/novel/campaign-runner.ts", at: 1, ok: true })
    recordModuleHit({ path: "src/lib/novel/autonomous-incubator.ts", at: 2, ok: false })
    const state = useModuleHeatStore.getState()
    expect(state.installed).toBe(true)
    expect(state.hits).toHaveLength(2)
    expect(state.pendingSinceFlush).toBe(2)
  })

  // TASK-006 回归：loadHeatSnapshot 此前零调用方，快照写了没人读。
  it("hydrate 回填上一次会话窗口（快照被消费）", async () => {
    mocks.readFile.mockResolvedValueOnce(
      JSON.stringify({
        fileVersion: 1,
        sessionStartedAt: 1,
        savedAt: 2,
        hits: [{ path: "src/lib/novel/campaign-runner.ts", at: 10, ok: true, ms: 5 }],
      }),
    )
    useModuleHeatStore.getState().install()
    recordModuleHit({ path: "src/lib/novel/autonomous-incubator.ts", at: 20, ok: true })
    await useModuleHeatStore.getState().hydrate("/proj")
    expect(mocks.readFile).toHaveBeenCalledWith("/proj/.novel/telemetry/module-heat.json")
    const state = useModuleHeatStore.getState()
    expect(state.hydrated).toBe(true)
    expect(state.hits.map((hit) => hit.path)).toEqual([
      "src/lib/novel/campaign-runner.ts",
      "src/lib/novel/autonomous-incubator.ts",
    ])
    // 快照本来就在盘上，不算「未落盘命中」
    expect(state.pendingSinceFlush).toBe(1)
  })

  it("hydrate 幂等：一个会话只读一次盘", async () => {
    mocks.readFile.mockResolvedValueOnce(
      JSON.stringify({
        fileVersion: 1,
        sessionStartedAt: 1,
        savedAt: 2,
        hits: [{ path: "a.ts", at: 10, ok: true }],
      }),
    )
    await useModuleHeatStore.getState().hydrate("/proj")
    await useModuleHeatStore.getState().hydrate("/proj")
    await useModuleHeatStore.getState().hydrate("/proj")
    expect(mocks.readFile).toHaveBeenCalledTimes(1)
    expect(useModuleHeatStore.getState().hits).toHaveLength(1)
  })

  it("hydrate 在无路径/无快照/快照损坏时静默跳过", async () => {
    await useModuleHeatStore.getState().hydrate(null)
    expect(mocks.readFile).not.toHaveBeenCalled()
    // 路径未知时保持「未回填」，等路径就绪再读
    expect(useModuleHeatStore.getState().hydrated).toBe(false)

    mocks.readFile.mockResolvedValueOnce("")
    await useModuleHeatStore.getState().hydrate("/proj")
    expect(useModuleHeatStore.getState().hits).toEqual([])

    useModuleHeatStore.getState().reset()
    mocks.readFile.mockResolvedValueOnce('{"fileVersion":9}')
    await useModuleHeatStore.getState().hydrate("/proj")
    expect(useModuleHeatStore.getState().hits).toEqual([])
  })

  it("hydrate 合并后仍受环形缓冲上限约束", async () => {
    const old = Array.from({ length: 1500 }, (_, i) => ({ path: "old.ts", at: i, ok: true }))
    mocks.readFile.mockResolvedValueOnce(
      JSON.stringify({ fileVersion: 1, sessionStartedAt: 1, savedAt: 2, hits: old }),
    )
    useModuleHeatStore.getState().install()
    for (let i = 0; i < 1500; i += 1) {
      recordModuleHit({ path: "new.ts", at: 10_000 + i, ok: true })
    }
    await useModuleHeatStore.getState().hydrate("/proj")
    const hits = useModuleHeatStore.getState().hits
    expect(hits).toHaveLength(2000)
    expect(hits[hits.length - 1].path).toBe("new.ts")
    expect(hits[0].at).toBe(1000)
  })

  it("flush 在无新命中时跳过写盘", async () => {
    await useModuleHeatStore.getState().flush("/proj")
    expect(mocks.writeFile).not.toHaveBeenCalled()
  })

  it("flush 写入 .novel/telemetry 快照并清零待写计数", async () => {
    const store = useModuleHeatStore.getState()
    store.install()
    recordModuleHit({ path: "a.ts", at: 1, ok: true })
    await useModuleHeatStore.getState().flush("/proj")
    expect(mocks.createDirectory).toHaveBeenCalledWith("/proj/.novel/telemetry")
    expect(mocks.writeFile).toHaveBeenCalledTimes(1)
    const [path, payload] = mocks.writeFile.mock.calls[0] as unknown as [string, string]
    expect(path).toBe("/proj/.novel/telemetry/module-heat.json")
    expect(JSON.parse(payload).hits).toHaveLength(1)
    expect(useModuleHeatStore.getState().pendingSinceFlush).toBe(0)
  })

  it("写盘失败不影响窗口（best-effort）", async () => {
    mocks.writeFile.mockRejectedValueOnce(new Error("disk"))
    const store = useModuleHeatStore.getState()
    store.install()
    recordModuleHit({ path: "a.ts", at: 1, ok: true })
    await expect(useModuleHeatStore.getState().flush("/proj")).resolves.toBeUndefined()
    expect(useModuleHeatStore.getState().hits).toHaveLength(1)
    expect(useModuleHeatStore.getState().pendingSinceFlush).toBe(1)
  })

  it("reset 清空窗口", () => {
    const store = useModuleHeatStore.getState()
    store.install()
    recordModuleHit({ path: "a.ts", at: 1, ok: true })
    useModuleHeatStore.getState().reset()
    expect(useModuleHeatStore.getState().hits).toEqual([])
  })

  it("shouldFlushHeat 按条数或时间窗口触发", () => {
    expect(shouldFlushHeat({ pendingSinceFlush: 0, lastFlushAt: 0 }, 10_000_000)).toBe(false)
    expect(shouldFlushHeat({ pendingSinceFlush: 100, lastFlushAt: 0 }, 1)).toBe(true)
    expect(shouldFlushHeat({ pendingSinceFlush: 1, lastFlushAt: 0 }, 15_001)).toBe(true)
  })

  // TASK-006 回归：落盘触发器此前只活在热力图视图的 setInterval 里，不开页永不落盘。
  // 这里全程不 render 任何视图，直接验证 app 级轮询自己会把窗口写盘。
  it("落盘触发器 app 级：不依赖视图挂载也按节流窗口写盘", async () => {
    vi.useFakeTimers()
    const stop = startModuleHeatFlushLoop(() => "/proj", { tickMs: 1000 })
    try {
      useModuleHeatStore.getState().install()
      recordModuleHit({ path: "a.ts", at: 1, ok: true })
      // 节流窗口（15s）未到 → 心跳再多次也不写盘
      await vi.advanceTimersByTimeAsync(10_000)
      expect(mocks.writeFile).not.toHaveBeenCalled()
      // 越过窗口 → 写一次
      await vi.advanceTimersByTimeAsync(10_000)
      expect(mocks.writeFile).toHaveBeenCalledTimes(1)
      // 无新命中 → 后续心跳不再重复覆盖写
      await vi.advanceTimersByTimeAsync(120_000)
      expect(mocks.writeFile).toHaveBeenCalledTimes(1)
      // 新命中再次触发
      recordModuleHit({ path: "b.ts", at: 2, ok: true })
      await vi.advanceTimersByTimeAsync(20_000)
      expect(mocks.writeFile).toHaveBeenCalledTimes(2)
    } finally {
      stop()
      vi.useRealTimers()
    }
  })

  it("落盘轮询：项目路径未知时跳过，路径就绪后照常落盘", async () => {
    vi.useFakeTimers()
    let projectPath: string | null = null
    const stop = startModuleHeatFlushLoop(() => projectPath, { tickMs: 1000 })
    try {
      useModuleHeatStore.getState().install()
      recordModuleHit({ path: "a.ts", at: 1, ok: true })
      await vi.advanceTimersByTimeAsync(20_000)
      expect(mocks.writeFile).not.toHaveBeenCalled()
      projectPath = "/proj"
      await vi.advanceTimersByTimeAsync(2_000)
      expect(mocks.writeFile).toHaveBeenCalledTimes(1)
    } finally {
      stop()
      vi.useRealTimers()
    }
  })

  it("落盘轮询重复启动不叠加定时器，stop 后不再写盘", async () => {
    vi.useFakeTimers()
    const stopFirst = startModuleHeatFlushLoop(() => "/proj", { tickMs: 1000 })
    const stopSecond = startModuleHeatFlushLoop(() => "/proj", { tickMs: 1000 })
    try {
      useModuleHeatStore.getState().install()
      recordModuleHit({ path: "a.ts", at: 1, ok: true })
      await vi.advanceTimersByTimeAsync(20_000)
      expect(mocks.writeFile).toHaveBeenCalledTimes(1)
      stopSecond()
      stopFirst()
      recordModuleHit({ path: "b.ts", at: 2, ok: true })
      await vi.advanceTimersByTimeAsync(60_000)
      expect(mocks.writeFile).toHaveBeenCalledTimes(1)
    } finally {
      stopFirst()
      stopSecond()
      vi.useRealTimers()
    }
  })

  it("默认心跳间隔为 5s（与旧视图定时器一致，节流窗口不变）", () => {
    expect(FLUSH_TICK_MS).toBe(5000)
  })

  it("真实地图可统计（未调用时覆盖率为 0）", () => {
    const totals = heatTotals(MODULE_ATLAS, useModuleHeatStore.getState().heatMap())
    expect(totals.modules).toBeGreaterThan(500)
    expect(totals.calledModules).toBe(0)
    expect(totals.coverage).toBe(0)
  })
})
