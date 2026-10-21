/**
 * module-heatmap-view.spec — 运动热力图视图（jsdom）。
 * 覆盖：统计条渲染 / 主链泳道渲染 / 未接线清单 / 节点下钻 / 支撑泳道折叠切换 /
 * 会话日志与调用热度着色。
 */
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"

const mocks = vi.hoisted(() => ({
  writeFile: vi.fn(async () => undefined),
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
})
