// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, fireEvent, render, screen } from "@/test-helpers/component-test-utils"
import { cleanup } from "@testing-library/react"
import { SimulationReportView } from "./simulation-report-view"
import { useStorySimulationStore } from "@/stores/story-simulation-store"
import { useWikiStore } from "@/stores/wiki-store"
import * as novelModule from "@/lib/novel"
import type {
  SimulationReport,
  StoryBranch,
  StoryFramework,
  TimelineEvent,
} from "@/lib/novel"
import type { AgentActionType, CharacterAnalysis } from "@/lib/novel"
import zh from "@/i18n/zh.json"

const t = zh.storySimulation as unknown as Record<string, string>
const withName = (tpl: string, name: string) => tpl.replace("{{name}}", name)

function makeEvent(overrides: Partial<TimelineEvent> = {}): TimelineEvent {
  return {
    id: `e-${Math.random().toString(36).slice(2, 8)}`,
    round: 0,
    nodeIndex: 0,
    actorId: "c1",
    actorName: "阿离",
    actionType: "speak",
    content: "今夜子时动手。",
    observableBy: [],
    impacts: [],
    timestamp: "2026-10-30T11:21:00.000Z",
    ...overrides,
  }
}

function makeChar(overrides: Partial<CharacterAnalysis> = {}): CharacterAnalysis {
  return {
    characterId: "c1",
    name: "阿离",
    behaviors: [{ node: "第一章", action: "拔刀相助", motivation: "护主" }],
    stateChanges: ["心境由疑转信"],
    consistencyScore: 80,
    ...overrides,
  }
}

function makeBranch(overrides: Partial<StoryBranch> = {}): StoryBranch {
  return {
    title: "主线推进",
    summary: "稳扎稳打，先稳后快。",
    keyEvents: ["夜袭粮仓", "结盟王城"],
    probability: "high",
    pros: "节奏稳",
    cons: "缺少惊喜",
    recommendation: true,
    ...overrides,
  }
}

function makeReport(overrides: Partial<SimulationReport> = {}): SimulationReport {
  return {
    frameworkId: "fw1",
    mode: "event-driven",
    characterAnalyses: [
      makeChar(),
      makeChar({
        characterId: "c2",
        name: "军师",
        behaviors: [],
        stateChanges: [],
        consistencyScore: 70,
      }),
    ],
    branches: [
      makeBranch(),
      makeBranch({
        title: "暗线反转",
        summary: "另辟蹊径。",
        keyEvents: [],
        probability: "medium",
        pros: "",
        cons: "风险高",
        recommendation: false,
      }),
      makeBranch({
        title: "孤注一掷",
        summary: "破釜沉舟。",
        keyEvents: ["火烧连营"],
        probability: "low",
        pros: "",
        cons: "",
        recommendation: false,
      }),
    ],
    recommendation: "建议走主线推进，先稳后快。",
    createdAt: "2026-10-30T11:21:00.000Z",
    ...overrides,
  }
}

function makeFramework(overrides: Partial<StoryFramework> = {}): StoryFramework {
  const phases = ["起", "承", "转", "合"] as const
  return {
    id: "fw1",
    title: "群侠传",
    premise: "江湖风云",
    targetWords: 10000,
    simulationMode: "event-driven",
    sourceChapters: 3,
    nodes: phases.map((phase, index) => ({
      index,
      phase,
      title: `第${index + 1}幕`,
      coreConflict: "冲突",
      involvedCharacters: ["阿离"],
      goal: "目标",
      causeFromPrev: "承接",
      expectedOutcome: "结局",
    })),
    createdAt: "2026-10-30T00:00:00.000Z",
    ...overrides,
  }
}

const baseProps = () => ({
  onResimulate: vi.fn(),
  onGenerateDraft: vi.fn(),
  onInterviewAgent: vi.fn(),
  onViewDraft: vi.fn(),
  onViewInterviewHistory: vi.fn(),
})

function resetStores() {
  useStorySimulationStore.setState({
    currentReport: null,
    currentFramework: null,
    timelineEvents: [],
    savedResults: [],
    error: null,
    infoMessage: null,
  })
  useWikiStore.setState({ project: null })
}

beforeEach(() => {
  resetStores()
  document.body.innerHTML = ""
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe("SimulationReportView 空态", () => {
  it("无报告且无历史结果时渲染 null", () => {
    const { container } = render(<SimulationReportView {...baseProps()} />)
    expect(container.innerHTML).toBe("")
  })
})

describe("SimulationReportView 基础渲染", () => {
  it("渲染报告标题与重推按钮，点击重推回调", () => {
    const props = baseProps()
    useStorySimulationStore.setState({
      currentReport: makeReport(),
      timelineEvents: [makeEvent()],
      currentFramework: makeFramework(),
    })
    render(<SimulationReportView {...props} />)
    expect(screen.getByText(t.reportTitle)).toBeTruthy()
    fireEvent.click(screen.getByText(t.resimulate))
    expect(props.onResimulate).toHaveBeenCalledTimes(1)
  })

  it("角色分析区：名字/一致度/行为/状态变化与采访按钮", () => {
    const props = baseProps()
    useStorySimulationStore.setState({
      currentReport: makeReport(),
      timelineEvents: [],
      currentFramework: makeFramework(),
    })
    render(<SimulationReportView {...props} />)
    expect(screen.getByText(t.characterAnalysis)).toBeTruthy()
    expect(screen.getAllByText("阿离").length).toBeGreaterThan(0)
    // 一致度文案含分数
    expect(screen.getByText(t.consistency.replace("{{score}}", "80"))).toBeTruthy()
    expect(screen.getByText(t.consistency.replace("{{score}}", "70"))).toBeTruthy()
  })

  it("采访按钮调用 onInterviewAgent(角色ID, 角色名)", () => {
    const props = baseProps()
    useStorySimulationStore.setState({
      currentReport: makeReport(),
      timelineEvents: [],
      currentFramework: makeFramework(),
    })
    render(<SimulationReportView {...props} />)
    const chatBtn = screen.getByText(withName(t.chatWith, "阿离"))
    fireEvent.click(chatBtn)
    expect(props.onInterviewAgent).toHaveBeenCalledWith("c1", "阿离")
  })

  it("走向分支区：标题/高中低概率/推荐徽章/优劣/关键事件/生成草稿", () => {
    const props = baseProps()
    useStorySimulationStore.setState({
      currentReport: makeReport(),
      timelineEvents: [],
      currentFramework: makeFramework(),
    })
    render(<SimulationReportView {...props} />)
    expect(screen.getByText(t.branchSection)).toBeTruthy()
    expect(screen.getByText("主线推进")).toBeTruthy()
    expect(screen.getByText("暗线反转")).toBeTruthy()
    expect(screen.getByText("孤注一掷")).toBeTruthy()
    // 推荐徽章只出现在 recommendation=true 的分支
    expect(screen.getAllByText(t.recommended)).toHaveLength(1)
    // pros/cons：b1 两者都有，b2 只有 cons，b3 都没有
    expect(screen.getByText("节奏稳")).toBeTruthy()
    expect(screen.getByText("风险高")).toBeTruthy()
    expect(screen.getByText("缺少惊喜")).toBeTruthy()
    // 概率标签高中低各一
    const probLabel = (v: string) => t.probabilityLabel.replace("{{value}}", v)
    expect(screen.getByText(probLabel(t.probabilityHigh))).toBeTruthy()
    expect(screen.getByText(probLabel(t.probabilityMedium))).toBeTruthy()
    expect(screen.getByText(probLabel(t.probabilityLow))).toBeTruthy()
    // 关键事件只渲染非空分支的
    expect(screen.getByText("夜袭粮仓")).toBeTruthy()
    expect(screen.getByText("火烧连营")).toBeTruthy()
    expect(screen.getAllByText(t.keyEvents)).toHaveLength(2)
    // 生成草稿按钮
    const draftBtns = screen.getAllByText(t.generateDraft)
    expect(draftBtns).toHaveLength(3)
    fireEvent.click(draftBtns[0])
    expect(props.onGenerateDraft).toHaveBeenCalledTimes(1)
    expect(props.onGenerateDraft.mock.calls[0][0].title).toBe("主线推进")
  })

  it("未知概率回退到低概率文案", () => {
    useStorySimulationStore.setState({
      currentReport: makeReport({
        branches: [makeBranch({ probability: "ultra" as never })],
        characterAnalyses: [],
      }),
      timelineEvents: [],
      currentFramework: makeFramework(),
    })
    render(<SimulationReportView {...baseProps()} />)
    const probLabel = t.probabilityLabel.replace("{{value}}", t.probabilityLow)
    expect(screen.getByText(probLabel)).toBeTruthy()
  })

  it("纯文本推荐直接渲染；空推荐不渲染推荐区", () => {
    useStorySimulationStore.setState({
      currentReport: makeReport({ recommendation: "建议走主线。" }),
      timelineEvents: [],
      currentFramework: makeFramework(),
    })
    const { unmount } = render(<SimulationReportView {...baseProps()} />)
    expect(screen.getByText(t.overallRecommendation)).toBeTruthy()
    expect(screen.getByText("建议走主线。")).toBeTruthy()
    unmount()
    cleanup()
    useStorySimulationStore.setState({
      currentReport: makeReport({ recommendation: "   " }),
      timelineEvents: [],
      currentFramework: makeFramework(),
    })
    render(<SimulationReportView {...baseProps()} />)
    expect(screen.queryByText(t.overallRecommendation)).toBeNull()
  })

  it("最小报告：无角色/无分支/无时间线时各区缺席但推荐仍在", () => {
    useStorySimulationStore.setState({
      currentReport: makeReport({ characterAnalyses: [], branches: [] }),
      timelineEvents: [],
      currentFramework: makeFramework(),
    })
    render(<SimulationReportView {...baseProps()} />)
    expect(screen.queryByText(t.characterAnalysis)).toBeNull()
    expect(screen.queryByText(t.branchSection)).toBeNull()
    expect(screen.queryByText(t.keyPlotEvents)).toBeNull()
    expect(screen.getByText(t.overallRecommendation)).toBeTruthy()
  })

  it("hasDraft 且传入 onViewDraft 时显示查看草稿；历史结果下隐藏", () => {
    const props = baseProps()
    useStorySimulationStore.setState({
      currentReport: makeReport(),
      timelineEvents: [],
      currentFramework: makeFramework(),
      savedResults: [],
    })
    const { unmount } = render(<SimulationReportView {...props} hasDraft />)
    const viewBtn = screen.getByText(t.viewDraft)
    fireEvent.click(viewBtn)
    expect(props.onViewDraft).toHaveBeenCalledTimes(1)
    unmount()
    cleanup()
    // 未传 onViewDraft → 不显示
    resetStores()
    useStorySimulationStore.setState({
      currentReport: makeReport(),
      timelineEvents: [],
      currentFramework: makeFramework(),
    })
    const { onViewDraft: _omit, ...noDraftProps } = baseProps()
    render(<SimulationReportView {...noDraftProps} hasDraft />)
    expect(screen.queryByText(t.viewDraft)).toBeNull()
  })

  it("采访历史按钮回调", () => {
    const props = baseProps()
    useStorySimulationStore.setState({
      currentReport: makeReport(),
      timelineEvents: [],
      currentFramework: makeFramework(),
    })
    render(<SimulationReportView {...props} />)
    fireEvent.click(screen.getByText(t.interviewHistory))
    expect(props.onViewInterviewHistory).toHaveBeenCalledTimes(1)
  })
})

describe("SimulationReportView actionLabel 全类型", () => {
  const cases: Array<[AgentActionType, string]> = [
    ["evaluate", t.actionEvaluate],
    ["pushPlot", t.actionPushPlot],
    ["observe", t.actionObserve],
    ["react", t.actionReact],
    ["speak", t.actionSpeak],
    ["ally", t.actionAlly],
    ["confront", t.actionConfront],
    ["conceal", t.actionConceal],
    ["investigate", t.actionInvestigate],
  ]
  it("九种新引擎 actionType 各自映射到对应文案", () => {
    const events = cases.map(([type,], i) =>
      makeEvent({ id: `a${i}`, actionType: type, nodeIndex: 0, content: `内容${i}` }),
    )
    useStorySimulationStore.setState({
      currentReport: makeReport(),
      timelineEvents: events,
      currentFramework: makeFramework(),
    })
    render(<SimulationReportView {...baseProps()} />)
    for (const [, label] of cases) {
      expect(screen.getByText(label)).toBeTruthy()
    }
  })

  it("未知 actionType 回退到 fallback 文案", () => {
    useStorySimulationStore.setState({
      currentReport: makeReport(),
      timelineEvents: [
        // 刻意构造类型系统不允许的取值，验证运行期对未知 actionType 的回退
        makeEvent({ actionType: "timeTravel" as unknown as AgentActionType }),
      ],
      currentFramework: makeFramework(),
    })
    render(<SimulationReportView {...baseProps()} />)
    expect(screen.getByText(t.actionFallback)).toBeTruthy()
  })
})

describe("SimulationReportView 时间线分组", () => {
  it("按节点分组渲染阶段徽章与标题，折叠/展开切换", () => {
    useStorySimulationStore.setState({
      currentReport: makeReport(),
      timelineEvents: [
        makeEvent({ id: "n0a", nodeIndex: 0, round: 0, content: "开场事件" }),
        makeEvent({ id: "n1a", nodeIndex: 1, round: 1, content: "承接事件" }),
      ],
      currentFramework: makeFramework(),
    })
    render(<SimulationReportView {...baseProps()} />)
    expect(screen.getByText(t.keyPlotEvents)).toBeTruthy()
    expect(screen.getByText(t.phaseQi)).toBeTruthy()
    expect(screen.getByText(t.phaseChen)).toBeTruthy()
    expect(screen.getByText("开场事件")).toBeTruthy()
    // R 轮次徽章
    expect(screen.getByText("R1")).toBeTruthy()
    expect(screen.getByText("R2")).toBeTruthy()
    // 点击节点标题折叠
    const header = screen.getByText(/第1幕/).closest("button") as HTMLButtonElement
    fireEvent.click(header)
    expect(screen.queryByText("开场事件")).toBeNull()
    expect(screen.getByText("承接事件")).toBeTruthy()
    fireEvent.click(header)
    expect(screen.getByText("开场事件")).toBeTruthy()
  })

  it("全部折叠/全部展开按钮", () => {
    useStorySimulationStore.setState({
      currentReport: makeReport(),
      timelineEvents: [
        makeEvent({ id: "n0a", nodeIndex: 0, content: "开场事件" }),
        makeEvent({ id: "n1a", nodeIndex: 1, content: "承接事件" }),
      ],
      currentFramework: makeFramework(),
    })
    render(<SimulationReportView {...baseProps()} />)
    fireEvent.click(screen.getByText(t.collapseAll))
    expect(screen.queryByText("开场事件")).toBeNull()
    expect(screen.queryByText("承接事件")).toBeNull()
    fireEvent.click(screen.getByText(t.expandAll))
    expect(screen.getByText("开场事件")).toBeTruthy()
    expect(screen.getByText("承接事件")).toBeTruthy()
  })

  it("无框架时节点标题回退到默认模板，未知阶段原样显示", () => {
    useStorySimulationStore.setState({
      currentReport: makeReport(),
      timelineEvents: [makeEvent({ nodeIndex: 2, content: "无框架事件" })],
      currentFramework: null,
    })
    render(<SimulationReportView {...baseProps()} />)
    expect(screen.getByText("无框架事件")).toBeTruthy()
    // 默认节点标题模板前缀（"节点 " 去掉插值部分）
    const prefix = t.nodeTitle.split("{{index}}")[0]
    const headers = screen.getAllByText((_, el) => {
      const txt = el?.textContent ?? ""
      return (el?.tagName === "SPAN" || el?.tagName === "BUTTON") && txt.includes(prefix) && txt.includes("3")
    })
    expect(headers.length).toBeGreaterThan(0)
  })

  it("演员按钮可发起采访；目标名经 targetId 与 nameToId 解析；未知目标不回调", () => {
    const props = baseProps()
    useStorySimulationStore.setState({
      currentReport: makeReport(),
      timelineEvents: [
        makeEvent({ id: "w1", actorId: "c1", actorName: "阿离", content: "对话", targetId: "c9", targetName: "老九" }),
        makeEvent({ id: "w2", actorId: "c2", actorName: "军师", content: "谋划", targetName: "阿离" }),
        makeEvent({ id: "w3", actorId: "c1", actorName: "阿离", content: "独白", targetName: "路人甲" }),
        makeEvent({ id: "w4", actorId: "c1", actorName: "阿离", content: "无目标事件" }),
      ],
      currentFramework: makeFramework(),
    })
    render(<SimulationReportView {...props} />)
    // targetId 直连
    fireEvent.click(screen.getByText("老九"))
    expect(props.onInterviewAgent).toHaveBeenCalledWith("c9", "老九")
    // nameToId 解析（军师事件的目标"阿离"→c1）
    const aliTargets = screen.getAllByText("阿离").filter((el) => el.tagName === "BUTTON")
    fireEvent.click(aliTargets[0])
    expect(props.onInterviewAgent).toHaveBeenCalledWith("c1", "阿离")
    // 未知目标点击不产生新回调
    const callsBefore = props.onInterviewAgent.mock.calls.length
    fireEvent.click(screen.getByText("路人甲"))
    expect(props.onInterviewAgent.mock.calls.length).toBe(callsBefore)
  })
})

describe("SimulationReportView recommendation 清洗", () => {
  const setup = (recommendation: string) => {
    resetStores()
    useStorySimulationStore.setState({
      currentReport: makeReport({ recommendation }),
      timelineEvents: [],
      currentFramework: makeFramework(),
    })
    render(<SimulationReportView {...baseProps()} />)
  }

  it("JSON 对象按 recommendation/text/content/summary/建议优先级提取", () => {
    setup(JSON.stringify({ content: "内容字段", summary: "摘要字段" }))
    expect(screen.getByText("内容字段")).toBeTruthy()
    expect(screen.queryByText("摘要字段")).toBeNull()
    cleanup()
    setup(JSON.stringify({ text: "文本字段" }))
    expect(screen.getByText("文本字段")).toBeTruthy()
    cleanup()
    setup(JSON.stringify({ recommendation: "推荐字段", text: "文本字段" }))
    expect(screen.getByText("推荐字段")).toBeTruthy()
    cleanup()
    setup(JSON.stringify({ 建议: "中文建议" }))
    expect(screen.getByText("中文建议")).toBeTruthy()
  })

  it("JSON 字符串（含引号）不满足花括号守卫，原样显示", () => {
    setup(JSON.stringify("只是一段话"))
    expect(screen.getByText('"只是一段话"')).toBeTruthy()
  })

  it("JSON 对象无已知字段时显示无推荐文案", () => {
    setup(JSON.stringify({ unknown: "x" }))
    expect(screen.getByText(t.noRecommendation)).toBeTruthy()
  })

  it("JSON 对象已知字段为空时显示无推荐文案", () => {
    setup(JSON.stringify({ text: "   " }))
    expect(screen.getByText(t.noRecommendation)).toBeTruthy()
  })

  it("非法 JSON 回退显示原文", () => {
    setup("{broken json}")
    expect(screen.getByText("{broken json}")).toBeTruthy()
  })

  it("JSON 数组渲染为徽章组：字符串/对象/数字混合，空串被过滤", () => {
    setup(JSON.stringify(["纯文本", { text: "对象文本" }, { content: "内容文本" }, 42, "", {}]))
    expect(screen.getByText("纯文本")).toBeTruthy()
    expect(screen.getByText("对象文本")).toBeTruthy()
    expect(screen.getByText("内容文本")).toBeTruthy()
    expect(screen.getByText("42")).toBeTruthy()
  })

  it("空数组清洗为空串，推荐区整体隐藏", () => {
    setup(JSON.stringify([]))
    expect(screen.queryByText(t.overallRecommendation)).toBeNull()
  })
})

describe("SimulationReportView 对比模式", () => {
  const reportA = () =>
    makeReport({
      characterAnalyses: [
        makeChar({ characterId: "c1", name: "阿离", consistencyScore: 80 }),
        makeChar({ characterId: "c2", name: "军师", consistencyScore: 70 }),
      ],
      branches: [
        makeBranch({ title: "主线推进", probability: "high" }),
        makeBranch({ title: "暗线反转", probability: "medium" }),
      ],
      recommendation: "建议走主线推进，先稳后快。",
    })
  const reportB = () =>
    makeReport({
      frameworkId: "fw1",
      mode: "event-driven",
      characterAnalyses: [
        makeChar({ characterId: "c1", name: "阿离", consistencyScore: 95 }),
        makeChar({ characterId: "c9", name: "老陈", consistencyScore: 60 }),
      ],
      branches: [
        makeBranch({ title: "主线推进", probability: "low" }),
        makeBranch({ title: "全新分支", probability: "high" }),
      ],
      recommendation: "建议走暗线出奇制胜。",
      createdAt: "2026-10-29T10:00:00.000Z",
    })

  function setupCompare() {
    resetStores()
    useStorySimulationStore.setState({
      currentReport: reportA(),
      timelineEvents: [
        makeEvent({ id: "a1", nodeIndex: 0, content: "A事件一", actorName: "阿离" }),
        makeEvent({ id: "a2", nodeIndex: 0, content: "A事件二", actorName: "阿离" }),
        makeEvent({ id: "a3", nodeIndex: 1, content: "A事件三", actorName: "军师" }),
      ],
      currentFramework: makeFramework(),
      savedResults: [
        {
          id: "r-b",
          frameworkId: "fw1",
          report: reportB(),
          timelineEvents: [makeEvent({ id: "b1", nodeIndex: 0, content: "B事件", actorName: "老陈" })],
          createdAt: "2026-10-29T10:00:00.000Z",
        },
        {
          id: "r-c",
          frameworkId: "fw1",
          report: reportA(),
          timelineEvents: [],
          createdAt: "2026-10-28T10:00:00.000Z",
        },
      ],
    })
    const props = baseProps()
    render(<SimulationReportView {...props} />)
    return props
  }

  it("历史下拉切换查看结果；进入对比后双栏/差异横幅/高亮与退出", () => {
    setupCompare()
    // 历史下拉存在
    const historySelect = screen.getByText(t.latestResult).closest("select") as HTMLSelectElement
    expect(historySelect).toBeTruthy()
    // 进入对比
    fireEvent.click(screen.getByText(t.compareResults))
    // 双栏标题
    expect(screen.getByText(t.resultALatest)).toBeTruthy()
    const bTitlePrefix = t.resultB.split("{{date}}")[0]
    expect(
      screen.getAllByText((_, el) => (el?.textContent ?? "").startsWith(bTitlePrefix)).length,
    ).toBeGreaterThan(0)
    // 事件数对比横幅
    expect(screen.getByText(t.eventCountCompare)).toBeTruthy()
    // 分数差异标注 (B: 95)
    expect(screen.getByText("(B: 95)")).toBeTruthy()
    // 推荐差异徽章
    expect(screen.getByText(t.hasDiff)).toBeTruthy()
    // 退出对比
    const exitBtn = document.querySelector("button svg") as unknown as Element
    expect(exitBtn).toBeTruthy()
    // 通过 title 列退出：找到对比下拉旁的 ghost 按钮（只有一个 svg 子节点的按钮）
    const buttons = Array.from(document.querySelectorAll("button"))
    const xBtn = buttons.find((b) => b.textContent === "" && b.querySelector("svg"))
    expect(xBtn).toBeTruthy()
    fireEvent.click(xBtn as HTMLButtonElement)
    expect(screen.queryByText(t.resultALatest)).toBeNull()
  })

  it("对比模式 compact：隐藏采访区与生成草稿按钮；B 列演员为纯文本", () => {
    setupCompare()
    // 单栏时有采访与草稿按钮
    expect(screen.getAllByText(t.generateDraft).length).toBeGreaterThan(0)
    fireEvent.click(screen.getByText(t.compareResults))
    // compact 后两者都消失
    expect(screen.queryByText(withName(t.chatWith, "阿离"))).toBeNull()
    expect(screen.queryByText(t.generateDraft)).toBeNull()
    // B 列演员"老陈"全部为非按钮
    const laochen = screen.getAllByText("老陈")
    expect(laochen.length).toBeGreaterThan(0)
    for (const el of laochen) {
      expect(el.tagName).not.toBe("BUTTON")
    }
  })

  it("对比下拉可切换；切空后退回单栏", () => {
    setupCompare()
    fireEvent.click(screen.getByText(t.compareResults))
    const selects = document.querySelectorAll("select")
    expect(selects.length).toBe(2)
    const compareSelect = selects[1] as HTMLSelectElement
    // 切换到另一份结果
    fireEvent.change(compareSelect, { target: { value: "r-c" } })
    expect(screen.getByText(t.resultALatest)).toBeTruthy()
    // 切空 → 退回单栏
    fireEvent.change(compareSelect, { target: { value: "" } })
    expect(screen.queryByText(t.resultALatest)).toBeNull()
    expect(screen.getByText(t.overallRecommendation)).toBeTruthy()
  })

  it("切换历史结果会退出对比并排除当前查看项", () => {
    setupCompare()
    fireEvent.click(screen.getByText(t.compareResults))
    expect(screen.getByText(t.resultALatest)).toBeTruthy()
    const historySelect = screen.getByText(t.latestResult).closest("select") as HTMLSelectElement
    fireEvent.change(historySelect, { target: { value: "r-b" } })
    // 退出对比
    expect(screen.queryByText(t.resultALatest)).toBeNull()
    // 当前查看结果徽章出现，对比按钮仍在（还有 r-c 可比）
    expect(screen.getByText(t.compareResults)).toBeTruthy()
  })

  it("对比方推荐为空时整段标异；对比方非法 JSON 按原文比对", () => {
    resetStores()
    useStorySimulationStore.setState({
      currentReport: makeReport({ recommendation: "甲建议。" }),
      timelineEvents: [makeEvent()],
      currentFramework: makeFramework(),
      savedResults: [
        {
          id: "r-empty",
          frameworkId: "fw1",
          report: makeReport({ recommendation: "" }),
          timelineEvents: [],
          createdAt: "2026-10-29T10:00:00.000Z",
        },
      ],
    })
    render(<SimulationReportView {...baseProps()} />)
    fireEvent.click(screen.getByText(t.compareResults))
    expect(screen.getByText(t.hasDiff)).toBeTruthy()
    // 对比段按句号切分后逐段补"。"，原文已带句号时会多一个
    expect(screen.getByText("甲建议。。")).toBeTruthy()
    cleanup()
    // 对比方非法 JSON：清洗 catch 后按原文逐段比对
    resetStores()
    useStorySimulationStore.setState({
      currentReport: makeReport({ recommendation: "甲建议。" }),
      timelineEvents: [makeEvent()],
      currentFramework: makeFramework(),
      savedResults: [
        {
          id: "r-bad",
          frameworkId: "fw1",
          report: makeReport({ recommendation: "{oops}" }),
          timelineEvents: [],
          createdAt: "2026-10-29T10:00:00.000Z",
        },
      ],
    })
    render(<SimulationReportView {...baseProps()} />)
    fireEvent.click(screen.getByText(t.compareResults))
    expect(screen.getByText(t.hasDiff)).toBeTruthy()
  })

  it("对比方 JSON 推荐同样被清洗；无已知字段时整段标异", () => {
    resetStores()
    useStorySimulationStore.setState({
      currentReport: makeReport({ recommendation: "甲建议。" }),
      timelineEvents: [makeEvent()],
      currentFramework: makeFramework(),
      savedResults: [
        {
          id: "r-json",
          frameworkId: "fw1",
          report: makeReport({ recommendation: JSON.stringify({ text: "乙方案更稳" }) }),
          timelineEvents: [],
          createdAt: "2026-10-29T10:00:00.000Z",
        },
      ],
    })
    render(<SimulationReportView {...baseProps()} />)
    fireEvent.click(screen.getByText(t.compareResults))
    expect(screen.getByText(t.hasDiff)).toBeTruthy()
    // JSON 对比方清洗后逐句号切分比对：甲乙各一段且不同
    expect(screen.getByText("甲建议。")).toBeTruthy()
    // B 列无对比方，原样渲染无补句号
    expect(screen.getByText("乙方案更稳")).toBeTruthy()
    cleanup()
    // 对比方 JSON 无已知字段 → 清洗为空 → 整段标异
    resetStores()
    useStorySimulationStore.setState({
      currentReport: makeReport({ recommendation: "甲建议。" }),
      timelineEvents: [makeEvent()],
      currentFramework: makeFramework(),
      savedResults: [
        {
          id: "r-json2",
          frameworkId: "fw1",
          report: makeReport({ recommendation: JSON.stringify({ foo: 1 }) }),
          timelineEvents: [],
          createdAt: "2026-10-29T10:00:00.000Z",
        },
      ],
    })
    render(<SimulationReportView {...baseProps()} />)
    fireEvent.click(screen.getByText(t.compareResults))
    expect(screen.getByText(t.hasDiff)).toBeTruthy()
  })
})

describe("SimulationReportView 导出", () => {
  function setupExportable() {
    resetStores()
    const framework = makeFramework()
    const report = makeReport()
    const events = [makeEvent()]
    useStorySimulationStore.setState({
      currentReport: report,
      timelineEvents: events,
      currentFramework: framework,
    })
    useWikiStore.setState({ project: { id: "p1", name: "P", path: "/tmp/proj" } })
    render(<SimulationReportView {...baseProps()} />)
    return { framework, report, events }
  }

  it("无项目路径时点击导出不调用", () => {
    const spy = vi.spyOn(novelModule, "exportReport").mockResolvedValue("/x.md")
    useStorySimulationStore.setState({
      currentReport: makeReport(),
      timelineEvents: [makeEvent()],
      currentFramework: makeFramework(),
    })
    render(<SimulationReportView {...baseProps()} />)
    fireEvent.click(screen.getByText(t.exportReport))
    expect(spy).not.toHaveBeenCalled()
  })

  it("无框架时点击导出不调用", () => {
    const spy = vi.spyOn(novelModule, "exportReport").mockResolvedValue("/x.md")
    useStorySimulationStore.setState({
      currentReport: makeReport(),
      timelineEvents: [makeEvent()],
      currentFramework: null,
    })
    useWikiStore.setState({ project: { id: "p1", name: "P", path: "/tmp/proj" } })
    render(<SimulationReportView {...baseProps()} />)
    fireEvent.click(screen.getByText(t.exportReport))
    expect(spy).not.toHaveBeenCalled()
  })

  it("导出成功：传参正确，导出中禁用，成功提示 5s 后清除", async () => {
    vi.useFakeTimers()
    let resolveExport!: (v: string) => void
    const gate = new Promise<string>((res) => {
      resolveExport = res
    })
    const spy = vi.spyOn(novelModule, "exportReport").mockReturnValue(gate)
    const { framework, report, events } = setupExportable()
    const btn = screen.getByText(t.exportReport).closest("button") as HTMLButtonElement
    fireEvent.click(btn)
    expect(spy).toHaveBeenCalledWith("/tmp/proj", framework, report, events)
    // 导出中状态
    expect(screen.getByText(t.exporting)).toBeTruthy()
    expect((screen.getByText(t.exporting).closest("button") as HTMLButtonElement).disabled).toBe(true)
    await act(async () => {
      resolveExport("/tmp/proj/报告.md")
    })
    expect(useStorySimulationStore.getState().infoMessage).toContain("/tmp/proj/报告.md")
    act(() => {
      vi.advanceTimersByTime(5000)
    })
    expect(useStorySimulationStore.getState().infoMessage).toBeNull()
  })

  it("导出失败：错误上屏，5s 后清除", async () => {
    vi.useFakeTimers()
    vi.spyOn(novelModule, "exportReport").mockRejectedValue(new Error("disk full"))
    setupExportable()
    fireEvent.click(screen.getByText(t.exportReport).closest("button") as HTMLButtonElement)
    await act(async () => {})
    await act(async () => {})
    expect(useStorySimulationStore.getState().error).toBeTruthy()
    act(() => {
      vi.advanceTimersByTime(5000)
    })
    expect(useStorySimulationStore.getState().error).toBeNull()
  })
})

describe("SimulationReportView 分支覆盖补齐：对比清洗/历史查看/未知阶段", () => {
  function setupTwoResults() {
    resetStores()
    useStorySimulationStore.setState({
      currentReport: makeReport({ recommendation: "甲建议。" }),
      timelineEvents: [makeEvent({ id: "cur1", content: "当前事件", actorName: "阿离", targetName: "神秘人" })],
      currentFramework: makeFramework(),
      savedResults: [
        {
          id: "r-b",
          frameworkId: "fw1",
          report: makeReport({ recommendation: "乙建议。" }),
          timelineEvents: [makeEvent({ id: "b1", content: "B事件", actorName: "老陈", targetName: "神秘人" })],
          createdAt: "2026-10-29T10:00:00.000Z",
        },
        {
          id: "r-c",
          frameworkId: "fw1",
          report: makeReport({ recommendation: "丙建议。" }),
          timelineEvents: [],
          createdAt: "2026-10-28T10:00:00.000Z",
        },
      ],
    })
    const props = baseProps()
    render(<SimulationReportView {...props} />)
    return props
  }

  it("对比方数组 JSON 推荐 → endsWith ] 右侧 + B 列徽章渲染", () => {
    resetStores()
    useStorySimulationStore.setState({
      currentReport: makeReport({ recommendation: "甲建议。" }),
      timelineEvents: [],
      currentFramework: makeFramework(),
      savedResults: [
        {
          id: "r-arr",
          frameworkId: "fw1",
          report: makeReport({ recommendation: JSON.stringify(["乙方案一", "乙方案二"]) }),
          timelineEvents: [],
          createdAt: "2026-10-29T10:00:00.000Z",
        },
      ],
    })
    render(<SimulationReportView {...baseProps()} />)
    fireEvent.click(screen.getByText(t.compareResults))
    expect(screen.getByText(t.hasDiff)).toBeTruthy()
    expect(screen.getByText("乙方案一")).toBeTruthy()
    expect(screen.getByText("乙方案二")).toBeTruthy()
  })

  it("查看历史结果后对比：A 栏标题用结果 A 日期 + 采访/目标按钮全部隐藏", () => {
    setupTwoResults()
    const historySelect = screen.getByText(t.latestResult).closest("select") as HTMLSelectElement
    fireEvent.change(historySelect, { target: { value: "r-b" } })
    // 当前查看徽章出现（currentResult 已设置）
    expect(screen.getByText(t.compareResults)).toBeTruthy()
    fireEvent.click(screen.getByText(t.compareResults))
    // A 栏标题不再是 latest，而是带日期的结果 A
    expect(screen.queryByText(t.resultALatest)).toBeNull()
    const aPrefix = (t.resultA as string).split("{{date}}")[0]
    expect(
      screen.getAllByText((_, el) => (el?.textContent ?? "").startsWith(aPrefix)).length,
    ).toBeGreaterThan(0)
    // onInterviewAgent/onGenerateDraft 传 undefined：无采访与草稿按钮
    expect(screen.queryByText(withName(t.chatWith, "阿离"))).toBeNull()
    expect(screen.queryByText(t.generateDraft)).toBeNull()
    // A 栏目标名（无处理器）渲染为纯文本 span
    const mystery = screen.getByText("神秘人")
    expect(mystery.tagName).not.toBe("BUTTON")
  })

  it("查看中的历史结果被删除 → 回退最新报告（find undefined 取 null）", () => {
    setupTwoResults()
    const historySelect = screen.getByText(t.latestResult).closest("select") as HTMLSelectElement
    fireEvent.change(historySelect, { target: { value: "r-b" } })
    expect(historySelect.value).toBe("r-b")
    act(() => {
      useStorySimulationStore.setState({ savedResults: [] })
    })
    expect(screen.getByText(t.reportTitle)).toBeTruthy()
    expect(screen.queryByText(t.latestResult)).toBeNull()
  })

  it("历史下拉切回最新 → viewingResultId 清空", () => {
    setupTwoResults()
    const historySelect = screen.getByText(t.latestResult).closest("select") as HTMLSelectElement
    fireEvent.change(historySelect, { target: { value: "r-b" } })
    expect(historySelect.value).toBe("r-b")
    fireEvent.change(historySelect, { target: { value: "" } })
    expect(historySelect.value).toBe("")
    expect(screen.getByText(t.reportTitle)).toBeTruthy()
  })

  it("唯一历史结果正在查看 → 无可比项，对比按钮隐藏", () => {
    resetStores()
    useStorySimulationStore.setState({
      currentReport: makeReport(),
      timelineEvents: [],
      currentFramework: makeFramework(),
      savedResults: [
        {
          id: "r-only",
          frameworkId: "fw1",
          report: makeReport(),
          timelineEvents: [],
          createdAt: "2026-10-29T10:00:00.000Z",
        },
      ],
    })
    render(<SimulationReportView {...baseProps()} />)
    const historySelect = screen.getByText(t.latestResult).closest("select") as HTMLSelectElement
    fireEvent.change(historySelect, { target: { value: "r-only" } })
    expect(screen.queryByText(t.compareResults)).toBeNull()
    expect(screen.getByText(t.reportTitle)).toBeTruthy()
  })

  it("对比方缺 timelineEvents → 双栏照常渲染（两侧 ?? [] 右侧）", () => {
    resetStores()
    useStorySimulationStore.setState({
      currentReport: makeReport({ recommendation: "甲建议。" }),
      timelineEvents: [makeEvent({ id: "cur1", content: "当前事件" })],
      currentFramework: makeFramework(),
      savedResults: [
        {
          id: "r-nt",
          frameworkId: "fw1",
          report: makeReport({ recommendation: "乙建议。" }),
          createdAt: "2026-10-29T10:00:00.000Z",
        },
      ],
    })
    render(<SimulationReportView {...baseProps()} />)
    fireEvent.click(screen.getByText(t.compareResults))
    expect(screen.getByText(t.resultALatest)).toBeTruthy()
    const bPrefix = (t.resultB as string).split("{{date}}")[0]
    expect(
      screen.getAllByText((_, el) => (el?.textContent ?? "").startsWith(bPrefix)).length,
    ).toBeGreaterThan(0)
  })

  it("未知阶段标签 → phaseLabel 回退原文", () => {
    const framework = makeFramework({
      nodes: [
        {
          index: 0,
          phase: "前传" as unknown as "起",
          title: "序幕",
          coreConflict: "冲突",
          involvedCharacters: [],
          goal: "目标",
          causeFromPrev: "承接",
          expectedOutcome: "结局",
        },
      ],
    })
    useStorySimulationStore.setState({
      currentReport: makeReport(),
      timelineEvents: [makeEvent({ nodeIndex: 0 })],
      currentFramework: framework,
    })
    render(<SimulationReportView {...baseProps()} />)
    expect(screen.getByText("前传")).toBeTruthy()
  })
})

describe("SimulationReportView statements 缺口论证（第十五批）", () => {
  it("历史结果 createdAt 非法 → 展示 Invalid Date 且正文照常（formatDate catch 为防御守卫）", () => {
    resetStores()
    useStorySimulationStore.setState({
      currentReport: makeReport(),
      currentFramework: makeFramework(),
      timelineEvents: [],
      savedResults: [
        {
          id: "r-bad",
          frameworkId: "fw1",
          report: makeReport({ createdAt: "not-a-date" }),
          timelineEvents: [],
          createdAt: "not-a-date",
        },
      ],
    })
    render(<SimulationReportView {...baseProps()} />)
    const historySelect = screen.getByText(t.latestResult).closest("select") as HTMLSelectElement
    // 选项标签经 formatDate：非法时间串不会抛（Date#toLocaleString 对 Invalid Date 返回固定串）。
    expect(historySelect.textContent).toContain("Invalid Date")
    fireEvent.change(historySelect, { target: { value: "r-bad" } })
    // 头部日期徽标同样渲染 "Invalid Date"，报告正文不受影响。
    expect(screen.getByText("Invalid Date")).toBeTruthy()
    expect(screen.getByText(t.reportTitle)).toBeTruthy()
    expect(screen.getAllByText("主线推进").length).toBeGreaterThan(0)
  })
})
