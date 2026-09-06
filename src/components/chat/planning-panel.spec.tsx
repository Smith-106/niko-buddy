// @vitest-environment jsdom
/**
 * Wave 3 计划模式 — PlanningPanel 组件测试（受控纯展示）。
 * 三类数据只读展示 + degraded 可见标记 + 刷新/开写/关闭动作出口。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup } from "@testing-library/react"
import {
  render,
  screen,
  fireEvent,
  setupDomGlobals,
} from "@/test-helpers/component-test-utils"
import { PlanningPanel, type PlanningPanelProps } from "./planning-panel"
import type { ChapterPlanView } from "@/lib/novel/planning"

const mocks = vi.hoisted(() => ({
  t: vi.fn((key: string, opts?: { defaultValue?: string }) => opts?.defaultValue ?? key),
}))

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: mocks.t }),
}))

function makePlan(overrides: Partial<ChapterPlanView> = {}): ChapterPlanView {
  return {
    chapterNumber: 8,
    generatedAt: "2026-08-18T00:00:00.000Z",
    foreshadowing: {
      status: "ok",
      report: {
        items: [
          {
            id: "f1",
            name: "青铜古戒",
            description: "",
            status: "planted",
            plantedChapter: 2,
            chaptersSincePlanted: 6,
            debtLevel: "critical",
          },
        ],
        totalUnresolved: 1,
        criticalCount: 1,
        warningCount: 0,
        debtScore: 12,
        thresholds: { plantedStale: 5, advancedStale: 10, densityLimit: 5 },
      },
      overdueFindings: [],
    },
    characters: {
      status: "ok",
      items: [
        {
          name: "林动",
          lastSeenChapter: 7,
          inCurrentOutline: true,
          chaptersSinceSeen: 1,
        },
        {
          name: "应欢欢",
          lastSeenChapter: 1,
          inCurrentOutline: false,
          chaptersSinceSeen: 7,
        },
      ],
    },
    threads: {
      status: "ok",
      items: [
        {
          subplotId: "s1",
          title: "宗门大比",
          arcState: "Rising",
          basis: "progress",
        },
      ],
      openCount: 1,
    },
    summary: { debtScore: 12, criticalForeshadowing: 1, openThreads: 1, charactersDue: 0 },
    ...overrides,
  }
}

function makeProps(overrides: Partial<PlanningPanelProps> = {}): PlanningPanelProps {
  return {
    plan: makePlan(),
    loading: false,
    error: null,
    onRefresh: vi.fn(),
    onStartWriting: vi.fn(),
    onClose: vi.fn(),
    ...overrides,
  }
}

describe("PlanningPanel", () => {
  beforeEach(() => {
    setupDomGlobals()
  })
  afterEach(() => {
    cleanup()
  })

  it("渲染三类数据（伏笔债务/角色出场/支线推进）", () => {
    render(<PlanningPanel {...makeProps()} />)
    expect(screen.getByText("青铜古戒")).toBeTruthy()
    expect(screen.getByText("林动")).toBeTruthy()
    expect(screen.getByText("宗门大比")).toBeTruthy()
    expect(screen.getByText("critical")).toBeTruthy()
    expect(screen.getByText("Rising")).toBeTruthy()
  })

  it("loading 时显示骨架而非数据", () => {
    render(<PlanningPanel {...makeProps({ loading: true, plan: null })} />)
    expect(screen.queryByText("青铜古戒")).toBeNull()
  })

  it("error 时显示错误信息", () => {
    render(<PlanningPanel {...makeProps({ plan: null, error: "读取失败" })} />)
    expect(screen.getByText("读取失败")).toBeTruthy()
  })

  it("degraded 维度显示可见标记", () => {
    const plan = makePlan()
    plan.characters.status = "degraded"
    plan.characters.items = []
    render(<PlanningPanel {...makeProps({ plan })} />)
    expect(screen.getAllByText("数据源不可用").length).toBeGreaterThan(0)
  })

  it("刷新/关闭/开写动作出口触发回调", () => {
    const props = makeProps()
    render(<PlanningPanel {...props} />)
    fireEvent.click(screen.getByLabelText("刷新"))
    expect(props.onRefresh).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByLabelText("关闭"))
    expect(props.onClose).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByText("以此计划开写"))
    expect(props.onStartWriting).toHaveBeenCalledTimes(1)
    expect(props.onStartWriting).toHaveBeenCalledWith(props.plan)
  })

  it("空数据（ok 状态）渲染空态文案", () => {
    const plan = makePlan({
      foreshadowing: { status: "ok", report: { items: [], totalUnresolved: 0, criticalCount: 0, warningCount: 0, debtScore: 0, thresholds: { plantedStale: 5, advancedStale: 10, densityLimit: 5 } }, overdueFindings: [] },
      characters: { status: "ok", items: [] },
      threads: { status: "ok", items: [], openCount: 0 },
    })
    render(<PlanningPanel {...makeProps({ plan })} />)
    expect(screen.getAllByText("无未回收伏笔").length).toBeGreaterThan(0)
  })

  it("plan 为 null 且无 loading/error → 不渲染数据区", () => {
    render(<PlanningPanel {...makeProps({ plan: null })} />)
    expect(screen.queryByText("伏笔债务")).toBeNull()
    expect(screen.queryByText("支线推进")).toBeNull()
  })

  it("foreshadowing/threads degraded → 数据源不可用标记", () => {
    const plan = makePlan()
    plan.foreshadowing.status = "degraded"
    plan.threads.status = "degraded"
    render(<PlanningPanel {...makeProps({ plan })} />)
    expect(screen.getAllByText("数据源不可用").length).toBeGreaterThanOrEqual(2)
  })

  it("未知 debtLevel/arcState → 样式回退；已退场/逾期/违规标注", () => {
    const plan = makePlan()
    plan.foreshadowing.report!.items[0] = {
      ...plan.foreshadowing.report!.items[0],
      debtLevel: "unknown" as never,
    }
    plan.characters.items = [
      { name: "林动", lastSeenChapter: 7, inCurrentOutline: true, chaptersSinceSeen: 1, isAlive: false },
      { name: "应欢欢", lastSeenChapter: 1, inCurrentOutline: false, chaptersSinceSeen: 12 },
    ]
    plan.threads.items[0] = {
      ...plan.threads.items[0],
      arcState: "Unknown" as never,
      transitionViolation: "Resolved 后仍有新增进度条目",
    }
    render(<PlanningPanel {...makeProps({ plan })} />)
    expect(screen.getByText("unknown")).toBeTruthy()
    expect(screen.getByText("已退场")).toBeTruthy()
    expect(screen.getByText(/已 .*章未出场/)).toBeTruthy()
    expect(screen.getByText("Unknown")).toBeTruthy()
    expect(screen.getByText("Resolved 后仍有新增进度条目")).toBeTruthy()
  })
})

// ==================== P2-IMP-11 计划面板四新维 ====================

import type { PlanDimensionSlice, ParticlePlanItem, StateDeltaPlanItem } from "@/lib/novel/planning"

function slice<T>(overrides: Partial<PlanDimensionSlice<T>> = {}): PlanDimensionSlice<T> {
  return { status: "ok", items: [] as unknown as T[], text: "", truncated: false, ...overrides }
}

describe("PlanningPanel — P2-IMP-11 四新维", () => {
  beforeEach(() => {
    setupDomGlobals()
  })
  afterEach(() => {
    cleanup()
  })

  it("四维齐备 → 四个 section 标题与条目均渲染（带 POV 标注）", () => {
    const plan = makePlan({
      povCharacter: "林动",
      cognition: slice<string>({ items: ["黑市入口在城西"], text: "黑市入口在城西" }),
      recentStateDeltas: slice<StateDeltaPlanItem>({
        items: [{ chapter: 7, kind: "item", entity: "青铜古戒", change: "归属 → 林动" }],
        text: "第7章 [item] 青铜古戒：归属 → 林动",
      }),
      encounter: slice<string>({ items: ["应欢欢"], text: "应欢欢" }),
      particles: slice<ParticlePlanItem>({
        items: [{ kind: "money", name: "灵石", state: "余额 100" }],
        text: "[money] 灵石 → 余额 100",
      }),
    })
    render(<PlanningPanel {...makeProps({ plan })} />)
    expect(screen.getByText("认知盲区（POV 林动）")).toBeTruthy()
    expect(screen.getByText("近章状态变更")).toBeTruthy()
    expect(screen.getByText("见面边界（POV 林动）")).toBeTruthy()
    expect(screen.getByText("粒子持有（POV 林动）")).toBeTruthy()
    expect(screen.getByText("不知道：黑市入口在城西")).toBeTruthy()
    expect(screen.getByText("第7章 [item] 青铜古戒：归属 → 林动")).toBeTruthy()
    expect(screen.getByText("已见过：应欢欢")).toBeTruthy()
    expect(screen.getByText("money：灵石 → 余额 100")).toBeTruthy()
  })

  it("degraded 新维 → 可见标记 + 降级原因", () => {
    const plan = makePlan({
      cognition: slice<string>({ status: "degraded", reason: "POV 未声明" }),
      recentStateDeltas: slice<StateDeltaPlanItem>({ status: "degraded", reason: "章节摘要数据源不可用" }),
      encounter: slice<string>({ status: "degraded", reason: "POV 未声明" }),
      particles: slice<ParticlePlanItem>({ status: "degraded", reason: "POV 未声明" }),
    })
    render(<PlanningPanel {...makeProps({ plan })} />)
    expect(screen.getAllByText("数据源不可用（POV 未声明）").length).toBe(3)
    expect(screen.getByText("数据源不可用（章节摘要数据源不可用）")).toBeTruthy()
  })

  it("ok 空数据 → 空态文案而非「数据源不可用」（面板可区分两者）", () => {
    const plan = makePlan({
      povCharacter: "林动",
      cognition: slice<string>(),
      encounter: slice<string>(),
      particles: slice<ParticlePlanItem>(),
      recentStateDeltas: slice<StateDeltaPlanItem>(),
    })
    render(<PlanningPanel {...makeProps({ plan })} />)
    expect(screen.getByText("无认知盲区记录")).toBeTruthy()
    expect(screen.getByText("近章无状态变更")).toBeTruthy()
    expect(screen.getByText("无已见面记录")).toBeTruthy()
    expect(screen.getByText("无粒子账本")).toBeTruthy()
    expect(screen.queryByText("数据源不可用")).toBeNull()
  })

  it("truncated → 逐维预算截断标记可见（IC-02）", () => {
    const plan = makePlan({
      povCharacter: "林动",
      cognition: slice<string>({ items: ["盲区一"], text: "盲区一", truncated: true }),
    })
    render(<PlanningPanel {...makeProps({ plan })} />)
    expect(screen.getByText("已按逐维预算截断")).toBeTruthy()
  })

  it("旧 plan（无四新维字段）→ 不渲染新维 section（additive 零回归）", () => {
    render(<PlanningPanel {...makeProps()} />)
    expect(screen.queryByText(/认知盲区/)).toBeNull()
    expect(screen.queryByText(/近章状态变更/)).toBeNull()
    expect(screen.queryByText(/见面边界/)).toBeNull()
    expect(screen.queryByText(/粒子持有/)).toBeNull()
    // 既有三维照旧
    expect(screen.getByText("伏笔债务")).toBeTruthy()
  })
})
