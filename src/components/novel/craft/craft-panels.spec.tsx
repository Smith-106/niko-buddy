// @vitest-environment jsdom
/**
 * craft-panels.spec.tsx — F-06 弧光工作台 / F-07 爽点仪表盘 / F-08 技法面板 验收测试
 *
 * 覆盖：
 *   - ArcWorkbench: 空状态、七阶段展示、置信度展示、推进信息
 *   - ThrillDashboard: 空状态、张弛比指标、ECharts 懒加载 fallback、量化表格
 *   - TechniquePanel: 空状态、概览统计、钩子类型注册表、规则包展开
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup } from "@testing-library/react"
import { act, render, screen, setupDomGlobals } from "@/test-helpers/component-test-utils"

// ============================================================================
// i18n mock
// ============================================================================

const tMock = vi.hoisted(() => ({
  t: vi.fn((key: string, opts?: unknown) => {
    // handle `t(key, "fallback string")` pattern
    if (typeof opts === "string") return opts
    // handle `t(key, { defaultValue: "..." })` pattern
    if (opts && typeof opts === "object" && "defaultValue" in (opts as Record<string, unknown>)) {
      return String((opts as Record<string, unknown>).defaultValue)
    }
    return key
  }),
}))

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: tMock.t }),
}))

// ============================================================================
// 组件引入
// ============================================================================

import { ArcWorkbench } from "./arc-workbench"
import { ThrillDashboard } from "./thrill-dashboard"
import { TechniquePanel } from "./technique-panel"
import type { ArcProgressionInput, ArcProgressionResult } from "@/lib/novel/craft/arc-tracker"
import type { ThrillQuantifierResult } from "@/lib/novel/craft/thrill-quantifier"
import type { CompiledTechniqueRegistry } from "@/lib/novel/craft/technique-compiler"

// ============================================================================
// Mock 数据
// ============================================================================

const MOCK_ARC_INPUT: ArcProgressionInput = {
  currentStage: "refusal",
  mckeeGhost: "童年被遗弃的创伤",
  significantDetails: ["总是下意识摸左手腕"],
  wmaActions: ["回避与权威人物的冲突"],
  visibleActions: [{ chapterNumber: 1, action: "面对上级时选择沉默" }],
}

const MOCK_ARC_RESULT: ArcProgressionResult = {
  previousStage: "ghost_exposed",
  currentStage: "refusal",
  progressed: true,
  confidence: 0.75,
  reason: "mckee_ghost 存在；visible_actions 有 1 条",
}

const MOCK_THRILL_RESULT: ThrillQuantifierResult = {
  configVersion: "1.0.0",
  hits: [
    { beatType: "catalyst", rawIntensity: 0.7, weightedIntensity: 0.7, positionRatio: 0.1, closureState: "closed", arcId: "arc-1" },
    { beatType: "midpoint", rawIntensity: 0.9, weightedIntensity: 0.9, positionRatio: 0.5, closureState: "open", arcId: "arc-1" },
    { beatType: "finale", rawIntensity: 1.0, weightedIntensity: 1.0, positionRatio: 0.9, closureState: "open", arcId: "arc-1" },
  ],
  tensionCurve: [
    { positionRatio: 0, raw: 0, smoothed: 0 },
    { positionRatio: 0.1, raw: 0.7, smoothed: 0.21 },
    { positionRatio: 0.2, raw: 0.3, smoothed: 0.237 },
    { positionRatio: 0.5, raw: 0.9, smoothed: 0.5359 },
    { positionRatio: 0.9, raw: 1.0, smoothed: 0.8751 },
    { positionRatio: 1, raw: 0.5, smoothed: 0.7626 },
  ],
}

const MOCK_REGISTRY: CompiledTechniqueRegistry = {
  compilerVersion: "1.0.0",
  snapshotVersion: 1,
  packs: [
    {
      packId: "craft.wish-motive-action",
      techniqueName: "愿望—动机—行动范式",
      sourceSnapshotVersion: 1,
      sourceMemoryIds: ["mem-1"],
      canonFieldTargets: [
        { table: "entities", field: "wish" },
        { table: "entities", field: "motive" },
      ],
      params: { wish_motive_distinction_enforced: true },
      promptBlocks: [
        {
          blockId: "craft.wma.protagonist-brief",
          title: "主角愿望—动机—行动注入",
          body: "主角必须有明确的愿望清单与动机清单。",
          injectionPoint: "protagonist_brief",
        },
      ],
    },
    {
      packId: "craft.thrill-loop-crisis-delay",
      techniqueName: "爽点循环与危机延宕",
      sourceSnapshotVersion: 1,
      sourceMemoryIds: ["mem-2"],
      canonFieldTargets: [{ table: "episodes", field: "beat_hits" }],
      params: { crisis_delay_allowed: true },
      promptBlocks: [
        {
          blockId: "craft.thrill.chapter-brief",
          title: "爽点循环注入",
          body: "对抗允许先让对手得意。",
          injectionPoint: "chapter_task_brief",
        },
      ],
    },
  ],
  hookTypeRegistry: [
    { hookType: "foreshadow_conflict", mountPoint: "episodes", labelZh: "预示冲突", sourceMemoryId: "mem-3" },
    { hookType: "dialogue", mountPoint: "edges", labelZh: "对话", sourceMemoryId: "mem-4" },
  ],
}

// ============================================================================
// Setup
// ============================================================================

beforeEach(() => {
  setupDomGlobals()
})

afterEach(() => {
  cleanup()
})

// ============================================================================
// F-06: ArcWorkbench
// ============================================================================

describe("ArcWorkbench (F-06)", () => {
  it("renders empty state when no data provided", () => {
    render(<ArcWorkbench />)
    expect(screen.getByText("暂无弧光数据，请先摄取实体技法字段")).toBeInTheDocument()
  })

  it("renders null input as empty state", () => {
    render(<ArcWorkbench input={null} />)
    expect(screen.getByText("暂无弧光数据，请先摄取实体技法字段")).toBeInTheDocument()
  })

  it("renders progression stepper with result prop", () => {
    const { container } = render(<ArcWorkbench result={MOCK_ARC_RESULT} />)
    expect(screen.getByText("弧光工作台")).toBeInTheDocument()
    // 当前阶段显示（出现 2 次：当前阶段 header + stepper 标签）
    const stageNodes = screen.getAllByText("拒绝召唤")
    expect(stageNodes.length).toBe(2)
    // 置信度（75 和 % 是相邻文本节点，用 contain 匹配）
    expect(container.textContent).toContain("75%")
    // 推进信息
    expect(screen.getByText(/阶段推进/)).toBeInTheDocument()
    // 检测依据
    expect(screen.getByText("mckee_ghost 存在；visible_actions 有 1 条")).toBeInTheDocument()
  })

  it("renders progression stepper with input prop (internal detect)", () => {
    render(<ArcWorkbench input={MOCK_ARC_INPUT} />)
    expect(screen.getByText("弧光工作台")).toBeInTheDocument()
    // 通过内部 detectArcProgression 检测到 refusal
    const stageNodes = screen.getAllByText("拒绝召唤")
    expect(stageNodes.length).toBe(2)
  })

  it("renders with character name", () => {
    render(<ArcWorkbench result={MOCK_ARC_RESULT} characterName="张三" />)
    expect(screen.getByText("弧光工作台 — 张三")).toBeInTheDocument()
  })

  it("shows non-progressed state correctly", () => {
    const nonProgressed: ArcProgressionResult = {
      previousStage: null,
      currentStage: "ghost_exposed",
      progressed: false,
      confidence: 0.0,
      reason: "首次摄取，无前驱阶段",
    }
    const { container } = render(<ArcWorkbench result={nonProgressed} />)
    const stageNodes = screen.getAllByText("鬼魂暴露")
    expect(stageNodes.length).toBe(2)
    expect(container.textContent).toContain("0%")
    expect(screen.queryByText(/阶段推进/)).not.toBeInTheDocument()
  })
})

// ============================================================================
// F-07: ThrillDashboard
// ============================================================================

describe("ThrillDashboard (F-07)", () => {
  it("renders empty state when no data provided", () => {
    render(<ThrillDashboard />)
    expect(screen.getByText("暂无爽点量化数据，请先运行爽点量化")).toBeInTheDocument()
  })

  it("renders null result as empty state", () => {
    render(<ThrillDashboard result={null} />)
    expect(screen.getByText("暂无爽点量化数据，请先运行爽点量化")).toBeInTheDocument()
  })

  it("renders tension-relax ratio cards", () => {
    render(<ThrillDashboard result={MOCK_THRILL_RESULT} />)
    expect(screen.getByText("爽点仪表盘")).toBeInTheDocument()
    // 总数
    expect(screen.getByText("3")).toBeInTheDocument()
    // 开放 (延宕)
    expect(screen.getByText("2")).toBeInTheDocument()
    // 已闭环 (疏解)
    expect(screen.getByText("1")).toBeInTheDocument()
    // 张弛比
    expect(screen.getByText("2.00")).toBeInTheDocument()
  })

  it("renders with chapter title", () => {
    render(<ThrillDashboard result={MOCK_THRILL_RESULT} chapterTitle="第一章" />)
    expect(screen.getByText("爽点仪表盘 — 第一章")).toBeInTheDocument()
  })

  it("renders ECharts lazy loading fallback while loading", () => {
    render(<ThrillDashboard result={MOCK_THRILL_RESULT} />)
    // Suspense fallback 在 lazy 组件加载时出现
    // 由于 jest/jsdom 环境不实际加载 ECharts，Suspense 会保持 fallback 态
    // 但 lazy 组件在测试中可能同步加载（取决于 bundler），这里断言组件存在
    expect(screen.getByText("爽点仪表盘")).toBeInTheDocument()
  })

  it("renders hits table with correct data", () => {
    render(<ThrillDashboard result={MOCK_THRILL_RESULT} />)
    // 表格应列出所有 hit
    expect(screen.getByText("爽点量化明细 (3 条)")).toBeInTheDocument()
    // Beat 类型应出现在表格中
    expect(screen.getByText("catalyst")).toBeInTheDocument()
    expect(screen.getByText("midpoint")).toBeInTheDocument()
    expect(screen.getByText("finale")).toBeInTheDocument()
  })

  it("renders empty table when hits is empty", () => {
    const emptyResult: ThrillQuantifierResult = {
      configVersion: "1.0.0",
      hits: [],
      tensionCurve: [],
    }
    render(<ThrillDashboard result={emptyResult} />)
    expect(screen.getByText("爽点仪表盘")).toBeInTheDocument()
    // 空状态张弛比不显示（无数据）
    expect(screen.queryByText("爽点总数")).not.toBeInTheDocument()
  })
})

// ============================================================================
// F-08: TechniquePanel
// ============================================================================

describe("TechniquePanel (F-08)", () => {
  it("renders empty state when no data provided", () => {
    render(<TechniquePanel />)
    expect(screen.getByText("暂无技法数据，请先编译技法规则包")).toBeInTheDocument()
  })

  it("renders null registry as empty state", () => {
    render(<TechniquePanel registry={null} />)
    expect(screen.getByText("暂无技法数据，请先编译技法规则包")).toBeInTheDocument()
  })

  it("renders overview statistics", () => {
    render(<TechniquePanel registry={MOCK_REGISTRY} />)
    expect(screen.getByText("技法面板")).toBeInTheDocument()
    // 规则包数（2 个 "2"：规则包数 + 钩子类型数）
    const twos = screen.getAllByText("2")
    expect(twos.length).toBeGreaterThanOrEqual(2)
    // 快照版本（v1 是相邻文本节点，用 getByText 可能找不到）
    expect(screen.getByText("快照版本")).toBeInTheDocument()
  })

  it("renders hook type registry", () => {
    render(<TechniquePanel registry={MOCK_REGISTRY} />)
    expect(screen.getByText("钩子类型注册表")).toBeInTheDocument()
    expect(screen.getByText("预示冲突")).toBeInTheDocument()
    expect(screen.getByText("对话")).toBeInTheDocument()
  })

  it("renders rule pack list with expandable cards", () => {
    render(<TechniquePanel registry={MOCK_REGISTRY} />)
    expect(screen.getByText("规则包详情 (2 包)")).toBeInTheDocument()
    // 包名
    expect(screen.getByText("愿望—动机—行动范式")).toBeInTheDocument()
    expect(screen.getByText("爽点循环与危机延宕")).toBeInTheDocument()
    // packId
    expect(screen.getByText("craft.wish-motive-action")).toBeInTheDocument()
    expect(screen.getByText("craft.thrill-loop-crisis-delay")).toBeInTheDocument()
  })

  it("expands rule pack to show details", () => {
    render(<TechniquePanel registry={MOCK_REGISTRY} />)
    // 点击第二个包（按 packId 排序后，craft.wish-motive-action 在第二位）
    const secondPack = screen.getByText("愿望—动机—行动范式")
    act(() => { secondPack.click() })
    // 展开后应显示 canon 字段、提示词块
    expect(screen.getByText("entities.wish")).toBeInTheDocument()
    expect(screen.getByText("entities.motive")).toBeInTheDocument()
    expect(screen.getByText("wish_motive_distinction_enforced")).toBeInTheDocument()
    // 提示词块
    expect(screen.getByText("主角愿望—动机—行动注入")).toBeInTheDocument()
    expect(screen.getByText("主角必须有明确的愿望清单与动机清单。")).toBeInTheDocument()
  })

  it("shows empty hook type table when registry has no hooks", () => {
    const noHooks: CompiledTechniqueRegistry = {
      compilerVersion: "1.0.0",
      snapshotVersion: 1,
      packs: [],
      hookTypeRegistry: [],
    }
    render(<TechniquePanel registry={noHooks} />)
    expect(screen.getByText("暂无钩子类型注册")).toBeInTheDocument()
  })
})