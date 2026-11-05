/**
 * module-heatmap-view.spec — 运动热力图视图（jsdom）。
 * 覆盖：统计条渲染 / 主链泳道渲染 / 未接线清单 / 节点下钻 / 支撑泳道折叠切换 /
 * 会话日志与调用热度着色。
 */
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"

const mocks = vi.hoisted(() => ({
  writeFile: vi.fn(async () => undefined),
  // B8：快照盘写走原子命令（temp+fsync+rename），视图侧同样不能触达非原子 writeFile。
  writeFileAtomic: vi.fn(async () => undefined),
  readFile: vi.fn(async () => ""),
  createDirectory: vi.fn(async () => undefined),
}))

vi.mock("@/commands/fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/commands/fs")>()
  return { ...actual, ...mocks }
})

const { ModuleHeatmapView } = await import("./module-heatmap-view")
const { recordModuleHit, setModuleHeatSink, MODULE_ATLAS, moduleLabel, listUnwiredModules } =
  await import("@/lib/novel")
const { useModuleHeatStore } = await import("@/stores/module-heat-store")

beforeEach(() => {
  setModuleHeatSink(null)
  useModuleHeatStore.getState().reset()
  useModuleHeatStore.setState({ installed: false })
  mocks.readFile.mockClear()
  mocks.writeFile.mockClear()
  mocks.writeFileAtomic.mockClear()
  mocks.createDirectory.mockClear()
})

afterEach(() => cleanup())

describe("ModuleHeatmapView", () => {
  it("渲染统计条与主链泳道", () => {
    render(<ModuleHeatmapView />)
    expect(screen.getByTestId("module-heatmap-view")).toBeTruthy()
    expect(screen.getByTestId("heatmap-stats")).toBeTruthy()
    expect(screen.getByTestId("heatmap-lanes")).toBeTruthy()
    // 主链泳道至少覆盖孵化 / 起草 / 门控三段
    expect(screen.getByTestId("heatmap-lane-incubate")).toBeTruthy()
    expect(screen.getByTestId("heatmap-lane-draft")).toBeTruthy()
    expect(screen.getByTestId("heatmap-lane-gate")).toBeTruthy()
    // 门控泳道标出返工回路
    expect(screen.getByTestId("heatmap-rework-gate")).toBeTruthy()
  })

  it("芯片状态图例齐备：虚线=未接线、红点=调用出错", () => {
    render(<ModuleHeatmapView />)
    expect(screen.getByTestId("heatmap-legend-unwired").textContent).toContain("未接线")
    expect(screen.getByTestId("heatmap-legend-error").textContent).toContain("出错")
  })

  it("泳道被截断时显式告知隐藏数量（不静默丢模块）", () => {
    render(<ModuleHeatmapView />)
    // 主链泳道单条上限 MAIN_NODE_LIMIT=12，真实 atlas 下必有泳道超出；
    // 无此提示时用户会误以为模块就这么少。
    const hidden = document.querySelectorAll('[data-testid^="heatmap-hidden-"]')
    expect(hidden.length).toBeGreaterThan(0)
    expect(hidden[0].textContent).toMatch(/\d+/)
  })

  it("支撑泳道默认折叠，点击后展开", () => {
    render(<ModuleHeatmapView />)
    expect(screen.queryByTestId("heatmap-support-lanes")).toBeNull()
    fireEvent.click(screen.getByTestId("heatmap-toggle-support"))
    expect(screen.getByTestId("heatmap-support-lanes")).toBeTruthy()
    expect(screen.getByTestId("heatmap-lane-agent")).toBeTruthy()
  })

  it("未接线清单按体量给出前若干项", () => {
    render(<ModuleHeatmapView />)
    const panel = screen.getByTestId("heatmap-unwired")
    const expected = listUnwiredModules(MODULE_ATLAS)[0]
    expect(expected).toBeTruthy()
    expect(panel.textContent).toContain(moduleLabel(expected.path))
  })

  it("点击节点后下钻显示路径与接线信息", () => {
    render(<ModuleHeatmapView />)
    const target = MODULE_ATLAS.modules.find((m) => m.p === "src/lib/novel/campaign-runner.ts")
    expect(target).toBeTruthy()
    fireEvent.click(screen.getByTestId(`heatmap-node-${moduleLabel("src/lib/novel/campaign-runner.ts")}`))
    const drill = screen.getByTestId("heatmap-drill")
    expect(drill.textContent).toContain("src/lib/novel/campaign-runner.ts")
  })

  it("埋点后会话日志出现记录且节点显示调用次数", () => {
    const store = useModuleHeatStore.getState()
    store.install()
    recordModuleHit({
      path: "src/lib/novel/campaign-runner.ts",
      at: Date.now(),
      ok: true,
      ms: 12,
      detail: "巡航第1章 ready",
    })
    render(<ModuleHeatmapView />)
    const log = screen.getByTestId("heatmap-session-log")
    expect(log.textContent).toContain("campaign-runner")
    expect(log.textContent).toContain("巡航第1章 ready")
    expect(log.textContent).toContain("12ms")
    expect(screen.getByTestId("heatmap-node-campaign-runner").textContent).toContain("1")
    // 最近命中 → 泳道进入「当前路径」
    expect(screen.getByTestId("heatmap-lane-draft").getAttribute("data-active")).toBe("true")
  })

  it("泳道间流向边带上下游文案零命中时静止", () => {
    render(<ModuleHeatmapView />)
    const flow = screen.getByTestId("heatmap-flow-plan")
    expect(flow.getAttribute("data-flowing")).toBe("false")
    expect(flow.textContent).toContain("→")
    expect(screen.queryByTestId("heatmap-now")).toBeNull()
    expect(screen.getByTestId("heatmap-lightup")).toBeTruthy()
  })

  it("命中后下游流向边呼吸并出现当前进行一句话", async () => {
    const store = useModuleHeatStore.getState()
    store.install()
    recordModuleHit({
      path: "src/lib/novel/campaign-runner.ts",
      at: Date.now(),
      ok: true,
    })
    render(<ModuleHeatmapView />)
    expect(screen.getByTestId("heatmap-flow-plan").getAttribute("data-flowing")).toBe("true")
    const now = screen.getByTestId("heatmap-now")
    expect(now.textContent?.length).toBeGreaterThan(0)
    expect(screen.queryByTestId("heatmap-lightup")).toBeNull()
  })

  it("空态点亮按钮一切到主控", async () => {
    const { useWikiStore } = await import("@/stores/wiki-store")
    const before = useWikiStore.getState().activeView
    render(<ModuleHeatmapView />)
    fireEvent.click(screen.getByTestId("heatmap-lightup"))
    expect(useWikiStore.getState().activeView).toBe("mainControl")
    useWikiStore.getState().setActiveView(before)
  })

  it("过滤框可按路径缩小模块集合", () => {
    render(<ModuleHeatmapView />)
    fireEvent.change(screen.getByTestId("heatmap-search"), { target: { value: "campaign-runner" } })
    expect(screen.getByTestId("heatmap-node-campaign-runner")).toBeTruthy()
    expect(screen.queryByTestId("heatmap-node-incubator")).toBeNull()
  })

  // TASK-006：快照此前只写不读（loadHeatSnapshot 零调用方）。视图挂载时必须回填。
  it("挂载时回填磁盘快照：冷启动不再空图", async () => {
    const { useWikiStore } = await import("@/stores/wiki-store")
    useWikiStore.setState({ project: { id: "p1", name: "proj", path: "/proj" } })
    mocks.readFile.mockResolvedValueOnce(
      JSON.stringify({
        fileVersion: 1,
        sessionStartedAt: 1,
        savedAt: 2,
        hits: [
          { path: "src/lib/novel/campaign-runner.ts", at: Date.now(), ok: true, ms: 7 },
        ],
      }),
    )
    try {
      render(<ModuleHeatmapView />)
      await waitFor(() => {
        expect(screen.getByTestId("heatmap-node-campaign-runner").textContent).toContain("1")
      })
      expect(mocks.readFile).toHaveBeenCalledWith("/proj/.novel/telemetry/module-heat.json")
      expect(screen.getByTestId("heatmap-session-log").textContent).toContain("campaign-runner")
    } finally {
      useWikiStore.setState({ project: null })
    }
  })

  // B6：hydratedFor 是 per-project —— 切项目后视图必须重新回填，且不显示上一项目的命中。
  it("切项目后重新回填新项目快照，旧项目命中不残留", async () => {
    const { useWikiStore } = await import("@/stores/wiki-store")
    useWikiStore.setState({ project: { id: "p1", name: "projA", path: "/projA" } })
    mocks.readFile.mockResolvedValueOnce(
      JSON.stringify({
        fileVersion: 1,
        sessionStartedAt: 1,
        savedAt: 2,
        hits: [{ path: "src/lib/novel/campaign-runner.ts", at: Date.now(), ok: true, ms: 3 }],
      }),
    )
    try {
      render(<ModuleHeatmapView />)
      await waitFor(() => {
        expect(mocks.readFile).toHaveBeenCalledWith("/projA/.novel/telemetry/module-heat.json")
      })
      await waitFor(() => {
        expect(screen.getByTestId("heatmap-session-log").textContent).toContain("campaign-runner")
      })

      mocks.readFile.mockResolvedValueOnce(
        JSON.stringify({
          fileVersion: 1,
          sessionStartedAt: 1,
          savedAt: 2,
          hits: [{ path: "src/lib/novel/autonomous-incubator.ts", at: Date.now(), ok: true, ms: 4 }],
        }),
      )
      act(() => {
        useWikiStore.setState({ project: { id: "p2", name: "projB", path: "/projB" } })
      })
      await waitFor(() => {
        expect(mocks.readFile).toHaveBeenCalledWith("/projB/.novel/telemetry/module-heat.json")
      })
      await waitFor(() => {
        expect(screen.getByTestId("heatmap-session-log").textContent).toContain("incubator")
      })
      // A 项目的命中窗口不得残留在 B 项目里
      expect(screen.getByTestId("heatmap-session-log").textContent).not.toContain("campaign-runner")
    } finally {
      useWikiStore.setState({ project: null })
    }
  })

  // B8/B14：手动「立即落盘」与 app 轮询共用 store.flush —— 原子写、先回填、单飞。
  it("手动「立即落盘」走原子写并回显落盘时间", async () => {
    const { useWikiStore } = await import("@/stores/wiki-store")
    useWikiStore.setState({ project: { id: "p1", name: "proj", path: "/proj" } })
    try {
      const store = useModuleHeatStore.getState()
      store.install()
      recordModuleHit({ path: "src/lib/novel/campaign-runner.ts", at: Date.now(), ok: true })
      render(<ModuleHeatmapView />)
      await waitFor(() => {
        expect(mocks.readFile).toHaveBeenCalledWith("/proj/.novel/telemetry/module-heat.json")
      })
      fireEvent.click(screen.getByTestId("heatmap-flush"))
      await waitFor(() => {
        expect(mocks.writeFileAtomic).toHaveBeenCalledTimes(1)
      })
      expect(mocks.writeFile).not.toHaveBeenCalled()
      await waitFor(() => {
        expect(screen.getByTestId("heatmap-flushed")).toBeTruthy()
      })
    } finally {
      useWikiStore.setState({ project: null })
    }
  })

  it("无项目路径时视图不读盘（不造假数据）", () => {
    render(<ModuleHeatmapView />)
    expect(mocks.readFile).not.toHaveBeenCalled()
  })
})

describe("ModuleHeatmapView 分支覆盖补齐", () => {
  const heatStore = () => useModuleHeatStore.getState()

  it("未知路径命中不崩：stageOf miss 与 activeLanes 跳过未知", () => {
    heatStore().install()
    recordModuleHit({ path: "src/unknown/fake-module.ts", at: Date.now(), ok: true })
    render(<ModuleHeatmapView />)
    expect(screen.getByTestId("module-heatmap-view")).toBeTruthy()
    // 未知路径仍进会话日志（label 回退 basename），但不点亮任何泳道
    expect(screen.getByTestId("heatmap-session-log").textContent).toContain("fake-module")
    expect(screen.getByTestId("heatmap-lane-draft").getAttribute("data-active")).toBe("false")
  })

  it("跨泳道命中：prev 链与分步计数同时覆盖", () => {
    heatStore().install()
    recordModuleHit({ path: "src/lib/novel/campaign-runner.ts", at: Date.now() - 1000, ok: true })
    recordModuleHit({ path: "src/lib/novel/chapter-pipeline.ts", at: Date.now(), ok: true })
    render(<ModuleHeatmapView />)
    // 最新命中在 plan（draft 为上一步），两条泳道都进入当前路径
    expect(screen.getByTestId("heatmap-now")).toBeTruthy()
    expect(screen.getByTestId("heatmap-flow-plan").getAttribute("data-flowing")).toBe("true")
    expect(screen.getByTestId("heatmap-lane-plan").getAttribute("data-active")).toBe("true")
    expect(screen.getByTestId("heatmap-lane-draft").getAttribute("data-active")).toBe("true")
  })

  it("全部未知命中时不渲染 nowStep", () => {
    heatStore().install()
    recordModuleHit({ path: "src/unknown/a.ts", at: Date.now() - 1000, ok: true })
    recordModuleHit({ path: "src/unknown/b.ts", at: Date.now(), ok: true })
    render(<ModuleHeatmapView />)
    expect(screen.queryByTestId("heatmap-now")).toBeNull()
    const logText = screen.getByTestId("heatmap-session-log").textContent ?? ""
    expect(logText).toContain("✓")
    expect(logText).toMatch(/[ab]/)
  })

  it("60 秒前命中不计入当前路径", () => {
    heatStore().install()
    recordModuleHit({ path: "src/lib/novel/campaign-runner.ts", at: Date.now() - 120_000, ok: true })
    render(<ModuleHeatmapView />)
    expect(screen.getByTestId("heatmap-lane-draft").getAttribute("data-active")).toBe("false")
    expect(screen.getByTestId("heatmap-flow-plan").getAttribute("data-flowing")).toBe("false")
    // 旧命中仍在日志里（只是不算当前路径）
    expect(screen.getByTestId("heatmap-session-log").textContent).toContain("campaign-runner")
  })

  it("出错命中显示错误红点与失败符号", () => {
    heatStore().install()
    recordModuleHit({ path: "src/lib/novel/campaign-runner.ts", at: Date.now(), ok: false, ms: 5, detail: "boom" })
    render(<ModuleHeatmapView />)
    const log = screen.getByTestId("heatmap-session-log")
    expect(log.textContent).toContain("✗")
    expect(log.textContent).toContain("boom")
    const node = screen.getByTestId("heatmap-node-campaign-runner")
    expect(node.querySelector(".bg-destructive")).toBeTruthy()
  })

  it("支撑泳道命中走 nowStepSupport 分支", () => {
    heatStore().install()
    recordModuleHit({ path: "src/lib/agent/activity-trace.ts", at: Date.now(), ok: true })
    render(<ModuleHeatmapView />)
    expect(screen.getByTestId("heatmap-now")).toBeTruthy()
    fireEvent.click(screen.getByTestId("heatmap-toggle-support"))
    expect(screen.getByTestId("heatmap-lane-agent").getAttribute("data-active")).toBe("true")
  })

  it("无项目时点立即落盘不写盘", async () => {
    const { useWikiStore } = await import("@/stores/wiki-store")
    useWikiStore.setState({ project: null })
    render(<ModuleHeatmapView />)
    fireEvent.click(screen.getByTestId("heatmap-flush"))
    expect(mocks.writeFileAtomic).not.toHaveBeenCalled()
    expect(screen.queryByTestId("heatmap-flushed")).toBeNull()
  })

  it("下钻无入边模块：零引用回退/未接线标记/混合日志符号", () => {
    heatStore().install()
    const target = "src/components/briefing/BriefingPanel.tsx"
    recordModuleHit({ path: target, at: Date.now() - 1000, ok: true, ms: 3 })
    recordModuleHit({ path: target, at: Date.now(), ok: false, detail: "err-detail" })
    render(<ModuleHeatmapView />)
    // BriefingPanel 在 ui 支撑泳道（默认折叠），先展开再下钻
    fireEvent.click(screen.getByTestId("heatmap-toggle-support"))
    fireEvent.click(screen.getByTestId(`heatmap-node-${moduleLabel(target)}`))
    const drill = screen.getByTestId("heatmap-drill")
    expect(drill.textContent).toContain(target)
    expect(drill.textContent).toContain("err-detail")
    // 无入边 -> importsIn 回退 0；未接线（x 标记）-> data-unwired true
    expect(drill.textContent).toContain("0")
    expect(screen.getByTestId(`heatmap-node-${moduleLabel(target)}`).getAttribute("data-unwired")).toBe("true")
    const drillLog = screen.getByTestId("heatmap-drill-log")
    expect(drillLog.textContent).toContain("✓")
    expect(drillLog.textContent).toContain("✗")
    expect(drillLog.textContent).toContain("err-detail")
  })
})
