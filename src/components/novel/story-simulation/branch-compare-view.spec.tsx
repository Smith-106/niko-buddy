// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, fireEvent, render, screen, waitFor, within } from "@/test-helpers/component-test-utils"
import { cleanup } from "@testing-library/react"
import { BranchCompareView } from "./branch-compare-view"
import * as workerMod from "./use-simulation-worker"
import type {
  DirectorEvaluation,
  DirectorScore,
  SimulationBranch,
  TimelineEvent,
} from "@/lib/novel"
import zh from "@/i18n/zh.json"

const t = zh.storySimulation as unknown as Record<string, string>

function makeScore(overrides: Partial<DirectorScore> = {}): DirectorScore {
  return {
    tension: 4,
    pace: 4,
    characterUtilization: 4,
    characterArc: 4,
    infoDensity: 4,
    emotionalResonance: 4,
    logicConsistency: 4,
    ...overrides,
  }
}

function makeEval(scores: DirectorScore): DirectorEvaluation {
  return {
    scores,
    totalScore: 28,
    highlights: [],
    issues: [],
    suggestion: "",
    shouldInjectEvent: false,
    injectEvent: undefined,
  }
}

function makeEvent(overrides: Partial<TimelineEvent> = {}): TimelineEvent {
  return {
    id: `e-${Math.random().toString(36).slice(2, 8)}`,
    round: 0,
    nodeIndex: 0,
    actorId: "a1",
    actorName: "甲角",
    actionType: "speak",
    content: "开场白。",
    observableBy: [],
    impacts: [],
    timestamp: "2026-10-30T11:21:00.000Z",
    ...overrides,
  }
}

function makeBranch(overrides: Partial<SimulationBranch> = {}): SimulationBranch {
  return {
    id: `b-${Math.random().toString(36).slice(2, 8)}`,
    name: "甲线",
    frameworkId: "fw1",
    mode: "event-driven",
    createdAt: "2026-10-30T11:21:00.000Z",
    timelineEvents: [],
    rumors: [],
    finalAgentSnapshots: [],
    directorEvaluations: [],
    overallScore: 80,
    scoreDetails: {
      avgDirectorScore: 7.0,
      eventCount: 1,
      characterDiversity: 0.5,
      plotProgression: 0.5,
    },
    ...overrides,
  }
}

function richBranches(): [SimulationBranch, SimulationBranch] {
  const a = makeBranch({
    id: "b-a",
    name: "甲线",
    overallScore: 90,
    directorEvaluations: [
      makeEval(makeScore({ tension: 4, pace: 5 })),
      makeEval(makeScore({ tension: 5, pace: 3 })),
    ],
    timelineEvents: [
      makeEvent({ id: "a0", round: 0, content: "开场甲。", actorName: "甲角" }),
      makeEvent({ id: "a1", round: 0, content: "铺垫甲。", actorName: "甲角", targetName: "乙角" }),
      makeEvent({ id: "a2", round: 1, content: "发展甲。", actorName: "甲角" }),
    ],
    finalAgentSnapshots: [
      { agentId: "c1", name: "阿离", knownSecrets: [], sentiments: [["好感", 3], ["信任", 5]] },
    ],
  })
  const b = makeBranch({
    id: "b-b",
    name: "乙线",
    overallScore: 80,
    directorEvaluations: [makeEval(makeScore({ tension: 2, pace: 2 }))],
    timelineEvents: [
      makeEvent({ id: "b0", round: 0, content: "开场乙。", actorName: "乙角" }),
      makeEvent({ id: "b1", round: 1, content: "发展乙。", actorName: "乙角" }),
    ],
    finalAgentSnapshots: [
      { agentId: "c1", name: "阿离", knownSecrets: [], sentiments: [["好感", 1], ["信任", 1]] },
      { agentId: "c2", name: "老陈", knownSecrets: [], sentiments: [["好感", 4]] },
    ],
  })
  return [a, b]
}

beforeEach(() => {
  document.body.innerHTML = ""
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe("BranchCompareView 空态与导航", () => {
  it("分支不足 2 个时显示提示：空数组/单分支/未知 id", () => {
    const { unmount } = render(
      <BranchCompareView branches={[]} compareBranchIds={[]} onBack={vi.fn()} />,
    )
    expect(screen.getByText(t.selectAtLeastTwoBranches)).toBeTruthy()
    unmount()
    const [a] = richBranches()
    render(<BranchCompareView branches={[a]} compareBranchIds={["b-a"]} onBack={vi.fn()} />)
    expect(screen.getByText(t.selectAtLeastTwoBranches)).toBeTruthy()
    cleanup()
    render(
      <BranchCompareView branches={[a]} compareBranchIds={["nope", "missing"]} onBack={vi.fn()} />,
    )
    expect(screen.getByText(t.selectAtLeastTwoBranches)).toBeTruthy()
  })

  it("返回按钮回调 onBack；分支徽章展示对比双方", () => {
    const onBack = vi.fn()
    const [a, b] = richBranches()
    render(<BranchCompareView branches={[a, b]} compareBranchIds={["b-a", "b-b"]} onBack={onBack} />)
    fireEvent.click(screen.getByText(t.backToBranchManagement))
    expect(onBack).toHaveBeenCalledTimes(1)
    // 徽章 + 图例 + 表头三处同名
    expect(screen.getAllByText("甲线")).toHaveLength(3)
    expect(screen.getAllByText("乙线")).toHaveLength(3)
  })
})

describe("BranchCompareView 评分对比", () => {
  it("雷达图/图例/维度表/总体行：均值、最大高亮、差异列", () => {
    const [a, b] = richBranches()
    const { container } = render(
      <BranchCompareView branches={[a, b]} compareBranchIds={["b-a", "b-b"]} onBack={vi.fn()} />,
    )
    // 默认就是评分 tab
    expect(screen.getByText(t.tabScoreCompare)).toBeTruthy()
    // 雷达 svg：3 层网格 + 2 个数据多边形
    const radar = container.querySelector('svg[width="360"]') as SVGElement
    expect(radar.querySelectorAll("polygon").length).toBe(5)
    // 数据点 2 分支 × 7 维度（r=3；排除 lucide 时钟图标的 circle）
    expect(radar.querySelectorAll('circle[r="3"]').length).toBe(14)
    // 图例（徽章 + 图例 + 表头三处同名）
    expect(screen.getAllByText("甲线")).toHaveLength(3)
    // 维度标签 7 个：雷达 text + 表格 td 各一
    expect(screen.getAllByText(t.dimensionTension)).toHaveLength(2)
    // tension 均值 (4+5)/2=4.5 vs 2 → 最大值高亮有颜色（限定 tension 行内断言）
    const tensionCell = screen
      .getAllByText(t.dimensionTension)
      .find((el) => el.tagName === "TD") as HTMLElement
    const tensionRow = within(tensionCell.closest("tr") as HTMLElement)
    const maxCell = tensionRow.getByText("4.5").closest("span") as HTMLElement
    expect(maxCell.style.color).not.toBe("")
    const minCell = tensionRow.getByText("2.0").closest("span") as HTMLElement
    expect(minCell.style.color).toBe("")
    // 差异列
    expect(screen.getByText("+2.5")).toBeTruthy()
    // 总体行
    expect(screen.getByText(t.overallScoreLabel)).toBeTruthy()
    expect(screen.getByText("90.0")).toBeTruthy()
    expect(screen.getByText("80.0")).toBeTruthy()
    expect(screen.getByText("+10.0")).toBeTruthy()
  })

  it("无导演评价分支回退 3.0；均值四舍五入；越界分数表格照常显示", () => {
    const a = makeBranch({
      id: "b-a",
      name: "甲线",
      overallScore: 90,
      directorEvaluations: [
        makeEval(makeScore({ tension: 1 })),
        makeEval(makeScore({ tension: 2 })),
        makeEval(makeScore({ tension: 2 })),
      ],
    })
    const b = makeBranch({ id: "b-b", name: "乙线", overallScore: 80, directorEvaluations: [] })
    const c = makeBranch({
      id: "b-c",
      name: "丙线",
      overallScore: 70,
      directorEvaluations: [makeEval(makeScore({ tension: 9, pace: -3 }))],
    })
    render(
      <BranchCompareView
        branches={[a, b, c]}
        compareBranchIds={["b-a", "b-b", "b-c"]}
        onBack={vi.fn()}
      />,
    )
    // (1+2+2)/3 = 1.667 → 1.7
    expect(screen.getByText("1.7")).toBeTruthy()
    // 无评价分支全 3.0（7 个维度，至少出现多次）
    expect(screen.getAllByText("3.0").length).toBeGreaterThanOrEqual(7)
    // 越界值表格照常显示原始值
    expect(screen.getByText("9.0")).toBeTruthy()
    expect(screen.getByText("-3.0")).toBeTruthy()
  })

  it("各维度完全相同时差异列显示 -", () => {
    const a = makeBranch({ id: "b-a", name: "甲线", directorEvaluations: [makeEval(makeScore())] })
    const b = makeBranch({ id: "b-b", name: "乙线", directorEvaluations: [makeEval(makeScore())] })
    render(<BranchCompareView branches={[a, b]} compareBranchIds={["b-a", "b-b"]} onBack={vi.fn()} />)
    expect(screen.getAllByText("-").length).toBeGreaterThanOrEqual(7)
    // 总体差为 0 时显示 +0.0
    expect(screen.getByText("+0.0")).toBeTruthy()
  })
})

describe("BranchCompareView 时间线对比", () => {
  it("按轮次分组：轮标题、事件卡、目标前缀、空分支提示", () => {
    const [a, b] = richBranches()
    const empty = makeBranch({ id: "b-e", name: "空线", overallScore: 60 })
    render(
      <BranchCompareView
        branches={[a, b, empty]}
        compareBranchIds={["b-a", "b-b", "b-e"]}
        onBack={vi.fn()}
      />,
    )
    fireEvent.click(screen.getByText(t.tabTimelineCompare))
    // 轮标题：第 1 轮 · 2 条事件（甲线 round0 有 2 个事件）
    const round1 = t.roundEventsSummary.replace("{{round}}", "1").replace("{{count}}", "2")
    expect(screen.getByText(round1)).toBeTruthy()
    // 事件内容
    expect(screen.getByText("开场甲。")).toBeTruthy()
    expect(screen.getByText("发展乙。")).toBeTruthy()
    // 目标前缀仅出现在有 targetName 的事件上（span 内为"前缀 · 短标签"组合文本）
    const prefixSpans = screen.getAllByText((_, el) => {
      const txt = (el?.textContent ?? "").trim()
      return el?.tagName === "SPAN" && txt.startsWith("对 ") && txt.includes("乙角")
    })
    expect(prefixSpans).toHaveLength(1)
    // 综合分标题
    expect(screen.getByText(t.overallScorePoints.replace("{{score}}", "90.0"))).toBeTruthy()
    // 空分支提示
    expect(screen.getByText(t.noEvents)).toBeTruthy()
  })
})

describe("BranchCompareView 关键差异", () => {
  it("加载态先显示分析中，成功后渲染结论/维度/基础数据/情感/优势", async () => {
    const [a, b] = richBranches()
    render(<BranchCompareView branches={[a, b]} compareBranchIds={["b-a", "b-b"]} onBack={vi.fn()} />)
    fireEvent.click(screen.getByText(t.tabKeyDifferences))
    // 初始加载态
    expect(screen.getByText(t.analyzing)).toBeTruthy()
    // 推荐结论指向最高分
    await waitFor(() =>
      expect(
        screen.getByText(t.recommendationConclusion.replace("{{name}}", "甲线")),
      ).toBeTruthy(),
    )
    // 维度差异：tension 4.5 vs 2.0，甲线领先
    expect(screen.getByText(t.topDimensionDiffs)).toBeTruthy()
    expect(
      screen.getByText(
        t.dimensionLeader.replace("{{branch}}", "甲线").replace("{{max}}", "4.5").replace("{{min}}", "2.0"),
      ),
    ).toBeTruthy()
    // 基础数据
    expect(screen.getByText(t.basicDataCompare)).toBeTruthy()
    // 事件数 3 / 2；角色数 1 / 2；第 1 轮开始分岔（round0 内容不同 → divergenceRound=1）
    expect(screen.getByText(t.divergenceFrom.replace("{{round}}", "1"))).toBeTruthy()
    // 主要优势 3 条 + 事件更丰富（甲 3 >= 乙 2）
    expect(screen.getByText(t.mainAdvantages)).toBeTruthy()
    const moreIdx = 4
    expect(
      screen.getByText(
        t.moreEvents.replace("{{index}}", String(moreIdx)).replace("{{count}}", "3"),
      ),
    ).toBeTruthy()
    // 情感差异：老陈仅乙线有 → 差 4 排第一；阿离 4 vs 1
    expect(screen.getByText(t.topSentimentDiffsTitle)).toBeTruthy()
    expect(
      screen.getByText(
        t.sentimentHighest.replace("{{branch}}", "乙线").replace("{{values}}", "0 / 4"),
      ),
    ).toBeTruthy()
    expect(
      screen.getByText(
        t.sentimentHighest.replace("{{branch}}", "甲线").replace("{{values}}", "4 / 1"),
      ),
    ).toBeTruthy()
  })

  it("完全相同的时间线与评分：无明显分岔、无情感数据", async () => {
    const a = makeBranch({
      id: "b-a",
      name: "甲线",
      overallScore: 90,
      directorEvaluations: [makeEval(makeScore())],
      timelineEvents: [makeEvent({ id: "s0", round: 0, content: "相同开场。" })],
    })
    const b = makeBranch({
      id: "b-b",
      name: "乙线",
      overallScore: 80,
      directorEvaluations: [makeEval(makeScore())],
      timelineEvents: [makeEvent({ id: "s1", round: 0, content: "相同开场。" })],
    })
    render(<BranchCompareView branches={[a, b]} compareBranchIds={["b-a", "b-b"]} onBack={vi.fn()} />)
    fireEvent.click(screen.getByText(t.tabKeyDifferences))
    await waitFor(() =>
      expect(
        screen.getByText(t.recommendationConclusion.replace("{{name}}", "甲线")),
      ).toBeTruthy(),
    )
    expect(screen.getByText(t.noDivergence)).toBeTruthy()
    expect(screen.getByText(t.noData)).toBeTruthy()
  })

  it("最佳分支事件更少时不渲染事件优势行", async () => {
    const x = makeBranch({
      id: "b-x",
      name: "高分支",
      overallScore: 90,
      directorEvaluations: [makeEval(makeScore({ tension: 5 }))],
      timelineEvents: [makeEvent({ id: "x0", round: 0, content: "开场。" })],
      finalAgentSnapshots: [
        { agentId: "c1", name: "阿离", knownSecrets: [], sentiments: [["好感", 5]] },
      ],
    })
    const y = makeBranch({
      id: "b-y",
      name: "低分支",
      overallScore: 80,
      directorEvaluations: [makeEval(makeScore({ tension: 3 }))],
      timelineEvents: [
        makeEvent({ id: "y0", round: 0, content: "开场。" }),
        makeEvent({ id: "y1", round: 0, content: "续幕。" }),
        makeEvent({ id: "y2", round: 1, content: "尾声。" }),
      ],
      finalAgentSnapshots: [
        { agentId: "c1", name: "阿离", knownSecrets: [], sentiments: [["好感", 1]] },
      ],
    })
    render(<BranchCompareView branches={[x, y]} compareBranchIds={["b-x", "b-y"]} onBack={vi.fn()} />)
    fireEvent.click(screen.getByText(t.tabKeyDifferences))
    await waitFor(() =>
      expect(
        screen.getByText(t.recommendationConclusion.replace("{{name}}", "高分支")),
      ).toBeTruthy(),
    )
    // 1 >= 3 为假 → 无事件优势行
    expect(screen.queryByText(/事件数量更丰富/)).toBeNull()
  })

  it("calcBranchDiff 抛错时打印错误并保持分析中", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    const calcBranchDiff = vi.fn().mockRejectedValue(new Error("worker boom"))
    vi.spyOn(workerMod, "useSimulationWorker").mockReturnValue({ calcBranchDiff } as never)
    const [a, b] = richBranches()
    render(<BranchCompareView branches={[a, b]} compareBranchIds={["b-a", "b-b"]} onBack={vi.fn()} />)
    fireEvent.click(screen.getByText(t.tabKeyDifferences))
    await waitFor(() => expect(calcBranchDiff).toHaveBeenCalledTimes(1))
    expect(calcBranchDiff).toHaveBeenCalledWith(a, b)
    await waitFor(() => expect(errSpy).toHaveBeenCalled())
    // 加载失败：仍停留在分析中（diffResult 为 null）
    expect(screen.getByText(t.analyzing)).toBeTruthy()
  })

  it("卸载后迟到的 worker 结果被丢弃（cancelled 护栏）", async () => {
    let resolveDiff!: (v: unknown) => void
    const gate = new Promise<unknown>((res) => {
      resolveDiff = res
    })
    vi.spyOn(workerMod, "useSimulationWorker").mockReturnValue({
      calcBranchDiff: vi.fn().mockReturnValue(gate),
    } as never)
    const [a, b] = richBranches()
    const { unmount } = render(
      <BranchCompareView branches={[a, b]} compareBranchIds={["b-a", "b-b"]} onBack={vi.fn()} />,
    )
    fireEvent.click(screen.getByText(t.tabKeyDifferences))
    expect(screen.getByText(t.analyzing)).toBeTruthy()
    unmount()
    await act(async () => {
      resolveDiff({
        dimensionDiffs: [],
        eventCounts: [1, 1],
        characterCounts: [1, 1],
        topSentimentDiffs: [],
        divergenceRound: -1,
        bestBranchIdx: 0,
      })
    })
    // 无崩溃、无 React 状态更新警告即通过（RTL 容器 div 保留）
    expect(document.body.innerHTML).toBe("<div></div>")
  })

  it("三个 tab 可来回切换", async () => {
    const [a, b] = richBranches()
    render(<BranchCompareView branches={[a, b]} compareBranchIds={["b-a", "b-b"]} onBack={vi.fn()} />)
    fireEvent.click(screen.getByText(t.tabTimelineCompare))
    expect(screen.getByText("开场甲。")).toBeTruthy()
    fireEvent.click(screen.getByText(t.tabKeyDifferences))
    await waitFor(() =>
      expect(
        screen.getByText(t.recommendationConclusion.replace("{{name}}", "甲线")),
      ).toBeTruthy(),
    )
    fireEvent.click(screen.getByText(t.tabScoreCompare))
    expect(screen.getAllByText(t.dimensionTension).length).toBeGreaterThanOrEqual(2)
  })
})
