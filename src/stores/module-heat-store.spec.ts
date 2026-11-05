import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  writeFile: vi.fn(async () => undefined),
  // B8：快照盘写必须走原子命令（Rust temp+fsync+rename），不走非原子的 writeFile。
  // 显式声明入参，否则 vi.fn 推导出空元组，`mock.calls[0][0]` 在类型层不可访问。
  writeFileAtomic: vi.fn(async (_path: string, _contents: string) => undefined),
  readFile: vi.fn(async () => ""),
  createDirectory: vi.fn(async () => undefined),
}))

vi.mock("@/commands/fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/commands/fs")>()
  return { ...actual, ...mocks }
})

const { useModuleHeatStore, shouldFlushHeat, startModuleHeatFlushLoop, FLUSH_TICK_MS } =
  await import("./module-heat-store")
const { recordModuleHit, setModuleHeatSink, heatTotals, MODULE_ATLAS, toHeatLog, moduleLabel } =
  await import("@/lib/novel")

/** 手工放行的 promise 闸门：用来把「回填读盘」「写盘」卡在中间，观察中途状态。 */
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

beforeEach(() => {
  setModuleHeatSink(null)
  useModuleHeatStore.getState().reset()
  useModuleHeatStore.setState({ installed: false })
  mocks.writeFile.mockClear()
  mocks.writeFileAtomic.mockClear()
  mocks.writeFileAtomic.mockImplementation(async () => undefined)
  mocks.writeFile.mockImplementation(async () => undefined)
  mocks.readFile.mockReset()
  mocks.readFile.mockImplementation(async () => "")
  mocks.createDirectory.mockClear()
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
    // B6：回填标记是 per-project 的项目路径，不再是全局布年。
    expect(state.hydratedFor).toBe("/proj")
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
    expect(useModuleHeatStore.getState().hydratedFor).toBeNull()

    mocks.readFile.mockResolvedValueOnce("")
    await useModuleHeatStore.getState().hydrate("/proj")
    expect(useModuleHeatStore.getState().hits).toEqual([])

    useModuleHeatStore.getState().reset()
    mocks.readFile.mockResolvedValueOnce('{"fileVersion":9}')
    await useModuleHeatStore.getState().hydrate("/proj")
    expect(useModuleHeatStore.getState().hits).toEqual([])
  })

  // A-04 回归：快照是用户磁盘状态，可能含历史版本/手工编辑/部分写留下的非法元素。
  // 只校验容器时，一条非 ModuleHit 会经 hydrate 进 live store，渲染 toHeatLog →
  // moduleLabel(undefined).replace 抛 TypeError 被 ErrorBoundary 接住 —— 热力图视图
  // 从此渲染不出来且不自愈。此处断言读盘侧逐条过滤：坏条目丢弃，好条目保留。
  it("A-04：hydrate 逐条过滤非法命中，坏数据不让整份快照失效", async () => {
    const dirty = [
      "chapter.write",
      null,
      42,
      { at: 1, ok: true },
      { path: "", at: 2, ok: true },
      { path: "no-at.ts", ok: true },
      { path: "nan-at.ts", at: Number.NaN, ok: true },
      { path: "inf-at.ts", at: Number.POSITIVE_INFINITY, ok: true },
      { path: "good-a.ts", at: 10, ok: true },
      { path: "good-b.ts", at: 11, ok: false, ms: 3, detail: "d" },
    ]
    mocks.readFile.mockResolvedValueOnce(
      JSON.stringify({ fileVersion: 1, sessionStartedAt: 1, savedAt: 2, hits: dirty }),
    )
    await useModuleHeatStore.getState().hydrate("/proj")
    expect(useModuleHeatStore.getState().hits.map((h) => h.path)).toEqual([
      "good-a.ts",
      "good-b.ts",
    ])
  })

  it("A-04：过滤后仍能正常出日志（不抛 moduleLabel 的 undefined.replace）", async () => {
    mocks.readFile.mockResolvedValueOnce(
      JSON.stringify({
        fileVersion: 1,
        sessionStartedAt: 1,
        savedAt: 2,
        hits: ["bogus", { path: "src/lib/novel/module-heat.ts", at: 5, ok: true }],
      }),
    )
    await useModuleHeatStore.getState().hydrate("/proj")
    expect(() => toHeatLog(useModuleHeatStore.getState().hits, moduleLabel)).not.toThrow()
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
    expect(mocks.writeFileAtomic).not.toHaveBeenCalled()
    expect(mocks.writeFile).not.toHaveBeenCalled()
  })

  it("flush 写入 .novel/telemetry 快照并清零待写计数", async () => {
    const store = useModuleHeatStore.getState()
    store.install()
    recordModuleHit({ path: "a.ts", at: 1, ok: true })
    await useModuleHeatStore.getState().flush("/proj")
    expect(mocks.createDirectory).toHaveBeenCalledWith("/proj/.novel/telemetry")
    expect(mocks.writeFileAtomic).toHaveBeenCalledTimes(1)
    const [path, payload] = mocks.writeFileAtomic.mock.calls[0] as unknown as [string, string]
    expect(path).toBe("/proj/.novel/telemetry/module-heat.json")
    expect(JSON.parse(payload).hits).toHaveLength(1)
    expect(useModuleHeatStore.getState().pendingSinceFlush).toBe(0)
  })

  // B8：写盘必须原子 —— 非原子 writeFile 直接覆盖，进程被杀会留半写 JSON
  // （下次 loadHeatSnapshot 判为损坏 → 上一次会话窗口静默丢失）。
  it("写盘走原子命令（temp+rename），不用非原子 writeFile", async () => {
    const store = useModuleHeatStore.getState()
    store.install()
    recordModuleHit({ path: "a.ts", at: 1, ok: true })
    await useModuleHeatStore.getState().flush("/proj")
    expect(mocks.writeFileAtomic).toHaveBeenCalledTimes(1)
    expect(mocks.writeFile).not.toHaveBeenCalled()
    // 写入目标就是最终路径（temp 文件名由 Rust 侧生成，TS 层不直接写快照路径）
    expect(mocks.writeFileAtomic.mock.calls[0][0]).toBe("/proj/.novel/telemetry/module-heat.json")
    // 半写防护：写入内容必须是一次完整的 JSON，可被 loadHeatSnapshot 直接解析
    expect(() => JSON.parse(mocks.writeFileAtomic.mock.calls[0][1] as string)).not.toThrow()
  })

  it("写盘失败不影响窗口（best-effort）", async () => {
    mocks.writeFileAtomic.mockRejectedValueOnce(new Error("disk"))
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
      expect(mocks.writeFileAtomic).not.toHaveBeenCalled()
      // 越过窗口 → 写一次
      await vi.advanceTimersByTimeAsync(10_000)
      expect(mocks.writeFileAtomic).toHaveBeenCalledTimes(1)
      // 无新命中 → 后续心跳不再重复覆盖写
      await vi.advanceTimersByTimeAsync(120_000)
      expect(mocks.writeFileAtomic).toHaveBeenCalledTimes(1)
      // 新命中再次触发
      recordModuleHit({ path: "b.ts", at: 2, ok: true })
      await vi.advanceTimersByTimeAsync(20_000)
      expect(mocks.writeFileAtomic).toHaveBeenCalledTimes(2)
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
      expect(mocks.writeFileAtomic).not.toHaveBeenCalled()
      projectPath = "/proj"
      await vi.advanceTimersByTimeAsync(2_000)
      expect(mocks.writeFileAtomic).toHaveBeenCalledTimes(1)
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
      expect(mocks.writeFileAtomic).toHaveBeenCalledTimes(1)
      stopSecond()
      stopFirst()
      recordModuleHit({ path: "b.ts", at: 2, ok: true })
      await vi.advanceTimersByTimeAsync(60_000)
      expect(mocks.writeFileAtomic).toHaveBeenCalledTimes(1)
    } finally {
      stopFirst()
      stopSecond()
      vi.useRealTimers()
    }
  })

  // ── B5：整文件覆盖写前必须先回填 ────────────────────────────────────────────
  // 回归场景：冷启动未开热力图页 → 做过写作 → 第一次 flush 用本次会话窗口整文件覆盖，
  // 上一次会话的快照被抹掉（使 loadHeatSnapshot 回填的价值归零）。
  it("B5：tick 先回填再落盘——回填完成前绝不做整文件覆盖写", async () => {
    vi.useFakeTimers()
    const gate = deferred<string>()
    mocks.readFile.mockImplementationOnce(() => gate.promise)
    const stop = startModuleHeatFlushLoop(() => "/proj", { tickMs: 1000 })
    try {
      useModuleHeatStore.getState().install()
      recordModuleHit({ path: "new.ts", at: 20, ok: true })
      // 越过 15s 节流窗口：tick 已醒来，但快照还挂在读盘上
      await vi.advanceTimersByTimeAsync(20_000)
      expect(mocks.readFile).toHaveBeenCalledTimes(1)
      // 关键断言：回填未完成 ⇒ 一次覆盖写都不许发生（否则上次会话快照被抹）
      expect(mocks.writeFileAtomic).not.toHaveBeenCalled()
      // 放行回填：上一次会话的窗口在盘上
      gate.resolve(
        JSON.stringify({
          fileVersion: 1,
          sessionStartedAt: 1,
          savedAt: 2,
          hits: [{ path: "prior.ts", at: 5, ok: true }],
        }),
      )
      await vi.advanceTimersByTimeAsync(5_000)
      expect(mocks.writeFileAtomic).toHaveBeenCalledTimes(1)
      const payload = JSON.parse(mocks.writeFileAtomic.mock.calls[0][1] as string) as {
        hits: Array<{ path: string }>
      }
      // 上一次会话窗口仍在 ⇒ 这次写盘没有抹掉旧快照
      expect(payload.hits.map((hit) => hit.path)).toEqual(["prior.ts", "new.ts"])
    } finally {
      stop()
      vi.useRealTimers()
    }
  })

  it("B5：直接调用 flush 同样先回填，回填挂起期间不写盘", async () => {
    const gate = deferred<string>()
    mocks.readFile.mockImplementationOnce(() => gate.promise)
    const store = useModuleHeatStore.getState()
    store.install()
    recordModuleHit({ path: "new.ts", at: 20, ok: true })
    const flushing = useModuleHeatStore.getState().flush("/proj")
    expect(mocks.readFile).toHaveBeenCalledTimes(1)
    expect(mocks.writeFileAtomic).not.toHaveBeenCalled()
    gate.resolve(
      JSON.stringify({
        fileVersion: 1,
        sessionStartedAt: 1,
        savedAt: 2,
        hits: [{ path: "prior.ts", at: 5, ok: true }],
      }),
    )
    await flushing
    expect(mocks.writeFileAtomic).toHaveBeenCalledTimes(1)
    const payload = JSON.parse(mocks.writeFileAtomic.mock.calls[0][1] as string) as {
      hits: Array<{ path: string }>
    }
    expect(payload.hits.map((hit) => hit.path)).toEqual(["prior.ts", "new.ts"])
    expect(useModuleHeatStore.getState().hydratedFor).toBe("/proj")
  })

  // ── B6：hydratedFor 是 per-project 而不是全局布尔 ───────────────────────────
  it("B6：切项目重新回填，且丢弃上一项目的命中窗口", async () => {
    mocks.readFile.mockResolvedValueOnce(
      JSON.stringify({
        fileVersion: 1,
        sessionStartedAt: 1,
        savedAt: 2,
        hits: [{ path: "a-snapshot.ts", at: 10, ok: true }],
      }),
    )
    mocks.readFile.mockResolvedValueOnce(
      JSON.stringify({
        fileVersion: 1,
        sessionStartedAt: 1,
        savedAt: 3,
        hits: [{ path: "b-snapshot.ts", at: 11, ok: true }],
      }),
    )
    const store = useModuleHeatStore.getState()
    store.install()
    recordModuleHit({ path: "a-live.ts", at: 20, ok: true })
    await useModuleHeatStore.getState().hydrate("/projA")
    expect(useModuleHeatStore.getState().hydratedFor).toBe("/projA")
    expect(useModuleHeatStore.getState().hits.map((hit) => hit.path)).toEqual([
      "a-snapshot.ts",
      "a-live.ts",
    ])

    // 同一项目再问一次：不重复读盘
    await useModuleHeatStore.getState().hydrate("/projA")
    expect(mocks.readFile).toHaveBeenCalledTimes(1)

    // 切到项目 B：必须重新回填（旧实现这里是全局布尔，直接早退 → B 永远空窗口）
    await useModuleHeatStore.getState().hydrate("/projB")
    expect(mocks.readFile).toHaveBeenCalledTimes(2)
    expect(mocks.readFile).toHaveBeenLastCalledWith("/projB/.novel/telemetry/module-heat.json")
    expect(useModuleHeatStore.getState().hydratedFor).toBe("/projB")
    // A 的命中窗口不得带进 B（否则会把 A 的旧窗口写进 B 的快照文件）
    expect(useModuleHeatStore.getState().hits.map((hit) => hit.path)).toEqual(["b-snapshot.ts"])
    expect(useModuleHeatStore.getState().pendingSinceFlush).toBe(0)

    // B 的落盘内容里不能出现 A 的命中
    recordModuleHit({ path: "b-live.ts", at: 30, ok: true })
    await useModuleHeatStore.getState().flush("/projB")
    const payload = JSON.parse(mocks.writeFileAtomic.mock.calls[0][1] as string) as {
      hits: Array<{ path: string }>
    }
    expect(payload.hits.map((hit) => hit.path)).toEqual(["b-snapshot.ts", "b-live.ts"])
  })

  it("B6：回填在飞时项目被切走，旧项目的快照结果作废（不写 hydratedFor）", async () => {
    const gateA = deferred<string>()
    mocks.readFile.mockImplementationOnce(() => gateA.promise)
    mocks.readFile.mockResolvedValueOnce(
      JSON.stringify({
        fileVersion: 1,
        sessionStartedAt: 1,
        savedAt: 2,
        hits: [{ path: "b-snapshot.ts", at: 10, ok: true }],
      }),
    )
    useModuleHeatStore.getState().install()
    const hydrationA = useModuleHeatStore.getState().hydrate("/projA")
    // 首轮回填还在飞时先写一条「属于 A 项目」的实时命中
    recordModuleHit({ path: "a-live.ts", at: 30, ok: true })
    await useModuleHeatStore.getState().hydrate("/projB")
    expect(useModuleHeatStore.getState().hydratedFor).toBe("/projB")
    gateA.resolve(
      JSON.stringify({
        fileVersion: 1,
        sessionStartedAt: 1,
        savedAt: 2,
        hits: [{ path: "a-snapshot.ts", at: 10, ok: true }],
      }),
    )
    await hydrationA
    // A 的迟到结果不得覆盖当前项目标记，也不得把 A 的 hits（快照或实时命中）混进窗口
    expect(useModuleHeatStore.getState().hydratedFor).toBe("/projB")
    expect(useModuleHeatStore.getState().hits.map((hit) => hit.path)).toEqual(["b-snapshot.ts"])
    expect(useModuleHeatStore.getState().pendingSinceFlush).toBe(0)
  })

  // ── B14：在飞守卫下沉进 store.flush ──────────────────────────────────────
  it("B14：并发 flush 只真正写一次（视图按钮与轮询共用同一份在飞任务）", async () => {
    const gate = deferred<void>()
    mocks.writeFileAtomic.mockImplementationOnce(async () => {
      await gate.promise
    })
    const store = useModuleHeatStore.getState()
    store.install()
    recordModuleHit({ path: "a.ts", at: 1, ok: true })
    const first = useModuleHeatStore.getState().flush("/proj")
    const second = useModuleHeatStore.getState().flush("/proj")
    const third = useModuleHeatStore.getState().flush("/proj")
    gate.resolve()
    await Promise.all([first, second, third])
    expect(mocks.writeFileAtomic).toHaveBeenCalledTimes(1)
    // 三个入口都观察到完成：待写计数已清零
    expect(useModuleHeatStore.getState().pendingSinceFlush).toBe(0)
  })

  it("B14：轮询与视图手动落盘并发时也只写一次", async () => {
    vi.useFakeTimers()
    const gate = deferred<void>()
    mocks.writeFileAtomic.mockImplementationOnce(async () => {
      await gate.promise
    })
    const stop = startModuleHeatFlushLoop(() => "/proj", { tickMs: 1000 })
    try {
      useModuleHeatStore.getState().install()
      recordModuleHit({ path: "a.ts", at: 1, ok: true })
      // 越过节流窗口 → tick 进入落盘并卡在写盘上
      await vi.advanceTimersByTimeAsync(20_000)
      expect(mocks.writeFileAtomic).toHaveBeenCalledTimes(1)
      // 此时用户点「立即落盘」→ 复用同一份在飞写盘，不叠加第二次覆盖写
      const manual = useModuleHeatStore.getState().flush("/proj")
      expect(mocks.writeFileAtomic).toHaveBeenCalledTimes(1)
      gate.resolve()
      await manual
      await vi.advanceTimersByTimeAsync(20_000)
      expect(mocks.writeFileAtomic).toHaveBeenCalledTimes(1)
    } finally {
      stop()
      vi.useRealTimers()
    }
  })

  it("默认心跳间隔为 5s（与旧视图定时器一致，节流窗口不变）", () => {
    expect(FLUSH_TICK_MS).toBe(5000)
  })

  // ── 回填单飞（同项目）───────────────────────────────────────────────────
  it("hydrate 在飞时同项目复用同一份 promise：不重复读盘，也不提前标记已回填", async () => {
    const gate = deferred<string>()
    mocks.readFile.mockImplementationOnce(() => gate.promise)
    const store = useModuleHeatStore.getState()
    store.install()
    recordModuleHit({ path: "live.ts", at: 20, ok: true })

    const first = useModuleHeatStore.getState().hydrate("/proj")
    const second = useModuleHeatStore.getState().hydrate("/proj")
    // 第二条路径必须复用在飞任务，而不是再读一次盘。
    expect(mocks.readFile).toHaveBeenCalledTimes(1)
    // 后来者不得在快照读完前就认为“已回填”（否则 flush 会提前覆盖写）。
    expect(useModuleHeatStore.getState().hydratedFor).toBeNull()

    gate.resolve(
      JSON.stringify({
        fileVersion: 1,
        sessionStartedAt: 1,
        savedAt: 2,
        hits: [{ path: "prior.ts", at: 5, ok: true }],
      }),
    )
    await Promise.all([first, second])

    expect(mocks.readFile).toHaveBeenCalledTimes(1)
    expect(useModuleHeatStore.getState().hydratedFor).toBe("/proj")
    expect(useModuleHeatStore.getState().hits.map((hit) => hit.path)).toEqual([
      "prior.ts",
      "live.ts",
    ])
  })

  // ── flush 的“回填没落到目标项目”早退 ──────────────────────────────────
  it("flush：回填期间项目被切走时放弃写盘（绝不把 A 项目的窗口写进 B）", async () => {
    const gateA = deferred<string>()
    mocks.readFile.mockImplementationOnce(() => gateA.promise)
    mocks.readFile.mockResolvedValueOnce(
      JSON.stringify({
        fileVersion: 1,
        sessionStartedAt: 1,
        savedAt: 2,
        hits: [{ path: "b-snapshot.ts", at: 10, ok: true }],
      }),
    )
    const store = useModuleHeatStore.getState()
    store.install()
    recordModuleHit({ path: "a-live.ts", at: 20, ok: true })

    const flushingA = useModuleHeatStore.getState().flush("/projA")
    expect(mocks.readFile).toHaveBeenCalledTimes(1)
    // 回填还挂在读盘上时切到 B：A 的回填结果会因代际作废。
    await useModuleHeatStore.getState().hydrate("/projB")
    expect(useModuleHeatStore.getState().hydratedFor).toBe("/projB")

    gateA.resolve(
      JSON.stringify({
        fileVersion: 1,
        sessionStartedAt: 1,
        savedAt: 2,
        hits: [{ path: "a-snapshot.ts", at: 5, ok: true }],
      }),
    )
    await flushingA

    // A 的 flush 发现 hydratedFor 不是自己 → 一次覆盖写都不许发生。
    expect(mocks.writeFileAtomic).not.toHaveBeenCalled()
    expect(useModuleHeatStore.getState().hydratedFor).toBe("/projB")
    expect(useModuleHeatStore.getState().hits.map((hit) => hit.path)).toEqual(["b-snapshot.ts"])
  })

  it("flush 在无项目路径时静默跳过", async () => {
    const store = useModuleHeatStore.getState()
    store.install()
    recordModuleHit({ path: "a.ts", at: 1, ok: true })
    await expect(useModuleHeatStore.getState().flush(null)).resolves.toBeUndefined()
    expect(mocks.readFile).not.toHaveBeenCalled()
    expect(mocks.writeFileAtomic).not.toHaveBeenCalled()
    // 命中仍留在窗口里，等路径就绪后再落盘
    expect(useModuleHeatStore.getState().pendingSinceFlush).toBe(1)
  })

  it("不传 options 时轮询按默认 5s 心跳醒来", async () => {
    vi.useFakeTimers()
    const stop = startModuleHeatFlushLoop(() => "/proj")
    try {
      // 默认 5000ms：4999ms 内不 tick（回填尚未开始）
      await vi.advanceTimersByTimeAsync(4_999)
      expect(mocks.readFile).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(1)
      expect(mocks.readFile).toHaveBeenCalledTimes(1)
      expect(mocks.readFile).toHaveBeenCalledWith("/proj/.novel/telemetry/module-heat.json")
    } finally {
      stop()
      vi.useRealTimers()
    }
  })

  it("真实地图可统计（未调用时覆盖率为 0）", () => {
    const totals = heatTotals(MODULE_ATLAS, useModuleHeatStore.getState().heatMap())
    expect(totals.modules).toBeGreaterThan(500)
    expect(totals.calledModules).toBe(0)
    expect(totals.coverage).toBe(0)
  })
})
