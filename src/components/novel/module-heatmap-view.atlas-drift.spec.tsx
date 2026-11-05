/**
 * module-heatmap-view.atlas-drift.spec — 生成物漂移下的降级契约（jsdom）。
 *
 * `module-atlas.generated.json` 是 `gen:atlas` 生成的静态产物，视图只做投影。
 * 真实 atlas 里「导入索引越界 / 泳道序号越界 / MAIN_LANES 缺泳道 / 零未接线」
 * 这些状态都不会出现，但视图为它们写了降级分支（不崩、不伪造流动、不空树）。
 * 这里用一份刻意不完整的 atlas 把这些降级分支钉住：断言的是「坏数据下仍然
 * 只显示真实可算的东西」，而不是让视图假装数据完好。
 */
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"

const mocks = vi.hoisted(() => ({
  /** 刻意漂移的 atlas：只有 draft / unmapped 两条泳道，模块里有越界索引与越界泳道。 */
  atlas: {
    schemaVersion: 1,
    generator: "spec-drift",
    stages: [
      { id: "draft", label: "起草" },
      { id: "unmapped", label: "未映射" },
    ],
    stats: {},
    modules: [
      // 出边索引越界：target 不存在 → 跳过（不崩、不计入反向边）
      { p: "src/drift/a.ts", s: 0, l: 10, r: true, o: false, x: false, i: [99] },
      // 泳道序号越界：归 other 兜底；nowStep/activeLanes 里当作未知泳道跳过
      { p: "src/drift/b.ts", s: 9, l: 5, r: false, o: false, x: false, i: [] },
      // 零引用（orphan）
      { p: "src/drift/c.ts", s: 0, l: 4, r: false, o: true, x: false, i: [] },
      // 有引用但入口不可达（unreachable）
      { p: "src/drift/d.ts", s: 0, l: 3, r: false, o: false, x: false, i: [] },
      // 只有测试引用（specOnly）
      { p: "src/drift/e.ts", s: 0, l: 2, r: true, o: false, x: true, i: [] },
    ],
  },
  /** 非 null 时替换未接线清单（用于「全部接线完成」空态）。 */
  unwiredOverride: null as unknown[] | null,
}))

vi.mock("@/commands/fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/commands/fs")>()
  return {
    ...actual,
    readFile: vi.fn(async () => ""),
    writeFile: vi.fn(async () => undefined),
    writeFileAtomic: vi.fn(async () => undefined),
    createDirectory: vi.fn(async () => undefined),
  }
})

vi.mock("@/lib/novel", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/novel")>()
  return {
    ...actual,
    MODULE_ATLAS: mocks.atlas,
    listUnwiredModules: (atlas: Parameters<typeof actual.listUnwiredModules>[0]) =>
      (mocks.unwiredOverride as ReturnType<typeof actual.listUnwiredModules> | null) ??
      actual.listUnwiredModules(atlas),
  }
})

const { ModuleHeatmapView } = await import("./module-heatmap-view")
const { recordModuleHit } = await import("@/lib/novel")
const { useModuleHeatStore } = await import("@/stores/module-heat-store")

beforeEach(() => {
  mocks.unwiredOverride = null
  useModuleHeatStore.getState().reset()
  useModuleHeatStore.setState({ installed: false })
  useModuleHeatStore.getState().install()
})

afterEach(() => cleanup())

describe("ModuleHeatmapView 生成物漂移降级", () => {
  const laneText = (stageId: string): string =>
    screen.getByTestId(`heatmap-lane-${stageId}`).textContent ?? ""

  beforeEach(() => {
    recordModuleHit({ path: "src/drift/b.ts", at: Date.now() - 1000, ok: true })
    recordModuleHit({ path: "src/drift/a.ts", at: Date.now(), ok: true })
  })

  it("泳道缺失/索引越界/序号越界：只渲染可算部分，不崩不伪造", () => {
    render(<ModuleHeatmapView />)
    expect(screen.getByTestId("module-heatmap-view")).toBeTruthy()

    // 已有泳道照常渲染，节点数即 atlas 里落在该泳道的模块数（4）。
    const draft = laneText("draft")
    expect(draft).toContain("起草")
    for (const label of ["a", "c", "d", "e"]) {
      expect(screen.getByTestId(`heatmap-node-${label}`)).toBeTruthy()
    }
    // MAIN_LANES 里缺失的泳道不渲染（不是空泳道壳），下游流向边也不画。
    expect(screen.queryByTestId("heatmap-lane-director")).toBeNull()
    expect(screen.queryByTestId("heatmap-flow-draft")).toBeNull()

    // 序号越界的模块归 other 兜底：展开支撑泳道也不该凭空长出一个泳道/节点。
    fireEvent.click(screen.getByTestId("heatmap-toggle-support"))
    expect(screen.getByTestId("heatmap-support-lanes")).toBeTruthy()
    expect(screen.queryByTestId("heatmap-lane-other")).toBeNull()
    expect(screen.queryByTestId("heatmap-node-b")).toBeNull()
  })

  it("序号越界的命中不算「当前步」，也不编造上一步", () => {
    render(<ModuleHeatmapView />)
    const now = screen.getByTestId("heatmap-now")
    // 最新命中 a.ts 在 draft（MAIN_LANES 第 1 步）；b.ts 的泳道未知 → 上一步回落「起点」。
    expect(now.textContent).toContain("起草")
    expect(now.textContent).toContain("起点")
    expect(now.textContent).not.toContain("未映射")
  })

  it("未接线清单按原因分类展示（零引用/进不去/只有测试在用）", () => {
    render(<ModuleHeatmapView />)
    const panel = screen.getByTestId("heatmap-unwired").textContent ?? ""
    expect(panel).toContain("零引用")
    expect(panel).toContain("进不去")
    expect(panel).toContain("只有测试在用")
    // 清单按体量排序，四条未接线模块都应出现，且不虚构第五条。
    expect(panel).toContain("c")
    expect(panel).toContain("d")
    expect(panel).toContain("e")
  })

  it("全部接线完成（未接线清单为空）→ 显示空态而不是空列表", () => {
    mocks.unwiredOverride = []
    render(<ModuleHeatmapView />)
    const panel = screen.getByTestId("heatmap-unwired").textContent ?? ""
    expect(panel).toContain("全部模块都在用")
    expect(screen.getByTestId("heatmap-unwired").querySelector("ul")).toBeNull()
  })
})
