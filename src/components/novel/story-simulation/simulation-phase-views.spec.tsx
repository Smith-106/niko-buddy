// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup } from "@testing-library/react"
import { fireEvent, render, screen } from "@/test-helpers/component-test-utils"
import {
  DraftPhaseView,
  ReportPhaseCenter,
  branchProbabilityWidth,
  scoreBarWidth,
} from "./simulation-phase-views"
import { useStorySimulationStore } from "@/stores/story-simulation-store"
import type {
  NovelAgent,
  RumorEvent,
  SimulationDebugTrace,
  SimulationReport,
  StoryBranch,
  StoryDraft,
  TimelineEvent,
} from "@/lib/novel"

function makeEvent(overrides: Partial<TimelineEvent> = {}): TimelineEvent {
  return {
    id: `e-${Math.random().toString(36).slice(2, 8)}`,
    round: 1,
    nodeIndex: 0,
    actorId: "a1",
    actorName: "林越",
    actionType: "speak",
    content: "阶段视图事件 UNIQUE-PV-1",
    observableBy: [],
    impacts: [],
    timestamp: "2026-10-30T11:21:00.000Z",
    ...overrides,
  }
}

function makeBranch(overrides: Partial<StoryBranch> = {}): StoryBranch {
  return {
    title: "分支走向 UNIQUE-BR-1",
    summary: "摘要",
    keyEvents: [],
    probability: "high",
    pros: "利",
    cons: "弊",
    recommendation: true,
    ...overrides,
  }
}

function makeReport(overrides: Partial<SimulationReport> = {}): SimulationReport {
  return {
    frameworkId: "fw1",
    mode: "event-driven",
    characterAnalyses: [
      {
        characterId: "c1",
        name: "林越",
        behaviors: [],
        stateChanges: [],
        consistencyScore: 88.6,
      },
    ],
    branches: [makeBranch()],
    recommendation: "建议",
    createdAt: "2026-10-30T11:21:00.000Z",
    ...overrides,
  }
}

function makeDraft(): StoryDraft {
  return {
    branchId: "b1",
    frameworkId: "fw1",
    chapters: [{ title: "第一章 UNIQUE-DRAFT-2", content: "正文", correspondingNode: 0 }],
    totalWords: 100,
    createdAt: "2026-10-30T11:21:00.000Z",
  }
}

function reportProps(overrides: Record<string, unknown> = {}) {
  return {
    tab: "report" as const,
    onTabChange: vi.fn(),
    currentReport: null,
    timelineEvents: [] as TimelineEvent[],
    debugTraces: [] as SimulationDebugTrace[],
    currentRumors: [] as RumorEvent[],
    currentAgents: new Map<string, NovelAgent>(),
    hasDraft: false,
    onResimulate: vi.fn(),
    onGenerateDraft: vi.fn(),
    onInterviewAgent: vi.fn(),
    onViewDraft: vi.fn(),
    onViewInterviewHistory: vi.fn(),
    onExtractConflictsToDraft: vi.fn(),
    ...overrides,
  }
}

function draftProps(overrides: Record<string, unknown> = {}) {
  return {
    tab: "draft" as const,
    onTabChange: vi.fn(),
    timelineEvents: [] as TimelineEvent[],
    debugTraces: [] as SimulationDebugTrace[],
    currentRumors: [] as RumorEvent[],
    currentAgents: new Map<string, NovelAgent>(),
    hasDraft: false,
    onBack: vi.fn(),
    onResimulate: vi.fn(),
    onGenerateDraft: vi.fn(),
    onInterviewAgent: vi.fn(),
    onViewDraft: vi.fn(),
    onViewInterviewHistory: vi.fn(),
    ...overrides,
  }
}

beforeEach(() => {
  document.body.innerHTML = ""
  useStorySimulationStore.getState().reset()
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  useStorySimulationStore.getState().reset()
})

describe("scoreBarWidth", () => {
  it("NaN 与 Infinity 回 0", () => {
    expect(scoreBarWidth(NaN)).toBe(0)
    expect(scoreBarWidth(Infinity)).toBe(0)
  })

  it("钳制越界：负数→0，超 100→100", () => {
    expect(scoreBarWidth(-5)).toBe(0)
    expect(scoreBarWidth(150)).toBe(100)
  })

  it("四舍五入取整", () => {
    expect(scoreBarWidth(88.6)).toBe(89)
    expect(scoreBarWidth(88.4)).toBe(88)
    expect(scoreBarWidth(70)).toBe(70)
  })
})

describe("branchProbabilityWidth", () => {
  it("high→100，medium→60，low→30", () => {
    expect(branchProbabilityWidth("high")).toBe(100)
    expect(branchProbabilityWidth("medium")).toBe(60)
    expect(branchProbabilityWidth("low")).toBe(30)
  })
})

describe("ReportPhaseCenter Tab 切换", () => {
  it("五个 Tab 点击透出 onTabChange", () => {
    const props = reportProps()
    render(<ReportPhaseCenter {...props} />)
    fireEvent.click(screen.getByText("时间线"))
    expect(props.onTabChange).toHaveBeenCalledWith("timeline")
    fireEvent.click(screen.getByText("概览"))
    expect(props.onTabChange).toHaveBeenCalledWith("overview")
    fireEvent.click(screen.getByText("传闻"))
    expect(props.onTabChange).toHaveBeenCalledWith("rumors")
    fireEvent.click(screen.getByText("线索"))
    expect(props.onTabChange).toHaveBeenCalledWith("clues")
    fireEvent.click(screen.getByText("推演报告"))
    expect(props.onTabChange).toHaveBeenCalledWith("report")
  })

  it("无报告时不渲染人设评分区", () => {
    render(<ReportPhaseCenter {...reportProps()} />)
    expect(screen.queryByTestId("sim-score-overview")).toBeNull()
  })

  it("空 characterAnalyses 时不渲染评分区", () => {
    render(<ReportPhaseCenter {...reportProps({ currentReport: makeReport({ characterAnalyses: [] }) })} />)
    expect(screen.queryByTestId("sim-score-overview")).toBeNull()
  })
})

describe("ReportPhaseCenter 报告 Tab 评分区", () => {
  it("渲染人设一致性评分条（四舍五入宽度）", () => {
    render(<ReportPhaseCenter {...reportProps({ currentReport: makeReport() })} />)
    expect(screen.getByTestId("sim-score-overview")).toBeTruthy()
    const bar = screen.getByTestId("sim-score-bar-c1")
    expect(bar.style.width).toBe("89%")
    expect(screen.getByText("88.6")).toBeTruthy()
  })

  it("有分支时渲染分支概率条；无分支时不渲染", () => {
    const { unmount } = render(<ReportPhaseCenter {...reportProps({ currentReport: makeReport() })} />)
    expect(screen.getByTestId("sim-branch-bar-0").style.width).toBe("100%")
    expect(screen.getByText("high")).toBeTruthy()
    unmount()
    render(
      <ReportPhaseCenter {...reportProps({ currentReport: makeReport({ branches: [] }) })} />,
    )
    expect(screen.queryByTestId("sim-branch-bar-0")).toBeNull()
    expect(screen.getByTestId("sim-score-overview")).toBeTruthy()
  })

  it("medium/low 概率映射到 60/30 宽度", () => {
    render(
      <ReportPhaseCenter
        {...reportProps({
          currentReport: makeReport({
            branches: [
              makeBranch({ title: "中概率分支 UNIQUE-BR-M", probability: "medium" }),
              makeBranch({ title: "低概率分支 UNIQUE-BR-L", probability: "low" }),
            ],
          }),
        })}
      />,
    )
    expect(screen.getByTestId("sim-branch-bar-0").style.width).toBe("60%")
    expect(screen.getByTestId("sim-branch-bar-1").style.width).toBe("30%")
  })
})

describe("ReportPhaseCenter 报告 Tab 回调透传", () => {
  it("经 SimulationReportView 触发 onGenerateDraft 与 onInterviewAgent", () => {
    useStorySimulationStore.setState({ currentReport: makeReport() })
    const props = reportProps({ currentReport: makeReport() })
    render(<ReportPhaseCenter {...props} />)
    fireEvent.click(screen.getByText("生成草稿"))
    expect(props.onGenerateDraft).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByText("与 林越 对话"))
    expect(props.onInterviewAgent).toHaveBeenCalledWith("c1", "林越")
  })
})

describe("ReportPhaseCenter 时间线 Tab", () => {
  it("渲染事件计数、一键提取按钮与事件卡片", () => {
    const props = reportProps({ tab: "timeline" as const, timelineEvents: [makeEvent()] })
    render(<ReportPhaseCenter {...props} />)
    expect(screen.getByText("共 1 条事件")).toBeTruthy()
    fireEvent.click(screen.getByTestId("sim-extract-conflicts"))
    expect(props.onExtractConflictsToDraft).toHaveBeenCalledTimes(1)
    expect(screen.getByText("阶段视图事件 UNIQUE-PV-1")).toBeTruthy()
    expect(screen.getByText("林越")).toBeTruthy()
  })

  it("空事件显示暂无事件", () => {
    render(<ReportPhaseCenter {...reportProps({ tab: "timeline" as const })} />)
    expect(screen.getByText("暂无事件")).toBeTruthy()
  })

  it("缺 actorName 回退系统、缺 content 回退无内容", () => {
    render(
      <ReportPhaseCenter
        {...reportProps({
          tab: "timeline" as const,
          timelineEvents: [makeEvent({ actorName: "", content: "" })],
        })}
      />,
    )
    expect(screen.getByText("系统")).toBeTruthy()
    expect(screen.getByText("(无内容)")).toBeTruthy()
  })
})

describe("ReportPhaseCenter 概览/传闻/线索 Tab", () => {
  it("概览挂载过程观察空态", () => {
    render(<ReportPhaseCenter {...reportProps({ tab: "overview" as const })} />)
    expect(screen.getByText("等待推演过程数据...")).toBeTruthy()
  })

  it("传闻/线索挂载对应空态", () => {
    const { unmount } = render(<ReportPhaseCenter {...reportProps({ tab: "rumors" as const })} />)
    expect(screen.getByText("暂无传闻数据")).toBeTruthy()
    unmount()
    render(<ReportPhaseCenter {...reportProps({ tab: "clues" as const })} />)
    expect(screen.getByText("暂无线索数据，开始推演后会自动生成")).toBeTruthy()
  })
})

describe("DraftPhaseView 报告 Tab 回调透传", () => {
  it("经 SimulationReportView 触发 onGenerateDraft 与 onInterviewAgent", () => {
    useStorySimulationStore.setState({ currentReport: makeReport() })
    const props = draftProps({ tab: "report" as const })
    render(<DraftPhaseView {...props} />)
    fireEvent.click(screen.getByText("生成草稿"))
    expect(props.onGenerateDraft).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByText("与 林越 对话"))
    expect(props.onInterviewAgent).toHaveBeenCalledWith("c1", "林越")
  })
})

describe("DraftPhaseView", () => {
  it("六个 Tab 点击透出 onTabChange", () => {
    const props = draftProps()
    render(<DraftPhaseView {...props} />)
    for (const [label, tab] of [
      ["故事草稿", "draft"],
      ["推演报告", "report"],
      ["时间线", "timeline"],
      ["过程观察", "overview"],
      ["传闻", "rumors"],
      ["线索", "clues"],
    ] as const) {
      fireEvent.click(screen.getByText(label))
      expect(props.onTabChange).toHaveBeenCalledWith(tab)
    }
  })

  it("草稿 Tab 无草稿时渲染空（StoryDraftView null）", () => {
    render(<DraftPhaseView {...draftProps()} />)
    expect(screen.queryByTitle("返回")).toBeNull()
  })

  it("草稿 Tab 有草稿时渲染内容且返回按钮触发 onBack", () => {
    useStorySimulationStore.setState({ currentDraft: makeDraft() })
    const props = draftProps()
    render(<DraftPhaseView {...props} />)
    expect(screen.getByText("第一章 UNIQUE-DRAFT-2")).toBeTruthy()
    fireEvent.click(screen.getByTitle("返回"))
    expect(props.onBack).toHaveBeenCalledTimes(1)
  })

  it("报告 Tab 无 store 报告时渲染空", () => {
    const { container } = render(<DraftPhaseView {...draftProps({ tab: "report" as const })} />)
    expect(container.textContent ?? "").not.toContain("第一章 UNIQUE-DRAFT-2")
  })

  it("时间线 Tab 渲染事件、无提取按钮、空态", () => {
    const { unmount } = render(
      <DraftPhaseView {...draftProps({ tab: "timeline" as const, timelineEvents: [makeEvent()] })} />,
    )
    expect(screen.getByText("共 1 条事件")).toBeTruthy()
    expect(screen.getByText("阶段视图事件 UNIQUE-PV-1")).toBeTruthy()
    expect(screen.queryByTestId("sim-extract-conflicts")).toBeNull()
    unmount()
    render(<DraftPhaseView {...draftProps({ tab: "timeline" as const })} />)
    expect(screen.getByText("暂无事件")).toBeTruthy()
  })

  it("时间线缺 actorName/content 回退分支", () => {
    render(
      <DraftPhaseView
        {...draftProps({
          tab: "timeline" as const,
          timelineEvents: [makeEvent({ actorName: "", content: "" })],
        })}
      />,
    )
    expect(screen.getByText("系统")).toBeTruthy()
    expect(screen.getByText("(无内容)")).toBeTruthy()
  })

  it("概览/传闻/线索 Tab 内容", () => {
    const { unmount } = render(<DraftPhaseView {...draftProps({ tab: "overview" as const })} />)
    expect(screen.getByText("等待推演过程数据...")).toBeTruthy()
    unmount()
    const r2 = render(<DraftPhaseView {...draftProps({ tab: "rumors" as const })} />)
    expect(r2.getByText("暂无传闻数据")).toBeTruthy()
    r2.unmount()
    render(<DraftPhaseView {...draftProps({ tab: "clues" as const })} />)
    expect(screen.getByText("暂无线索数据，开始推演后会自动生成")).toBeTruthy()
  })
})
