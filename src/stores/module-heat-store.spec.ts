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

const { useModuleHeatStore, shouldFlushHeat } = await import("./module-heat-store")
const { recordModuleHit, setModuleHeatSink, heatTotals, MODULE_ATLAS } = await import(
  "@/lib/novel"
)

beforeEach(() => {
  setModuleHeatSink(null)
  useModuleHeatStore.getState().reset()
  useModuleHeatStore.setState({ installed: false })
  mocks.writeFile.mockClear()
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

  it("真实地图可统计（未调用时覆盖率为 0）", () => {
    const totals = heatTotals(MODULE_ATLAS, useModuleHeatStore.getState().heatMap())
    expect(totals.modules).toBeGreaterThan(500)
    expect(totals.calledModules).toBe(0)
    expect(totals.coverage).toBe(0)
  })
})
