// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup } from "@testing-library/react"
import { fireEvent, render, screen } from "@/test-helpers/component-test-utils"
import {
  DebugAgentList,
  DebugStat,
  PROGRESS_PHASES,
  ProcessDebugPanel,
  SimulatingTimelinePanel,
} from "./simulation-debug-panels"
import { useStorySimulationStore } from "@/stores/story-simulation-store"
import type {
  SimulationBranch,
  SimulationDebugTrace,
  StoryFramework,
  TimelineEvent,
} from "@/lib/novel"

function makeEvent(overrides: Partial<TimelineEvent> = {}): TimelineEvent {
  return {
    id: `e-${Math.random().toString(36).slice(2, 8)}`,
    round: 0,
    nodeIndex: 0,
    actorId: "a1",
    actorName: "林越",
    actionType: "speak",
    content: "调试面板事件内容 UNIQUE-EVT-1",
    observableBy: [],
    impacts: [],
    timestamp: "2026-10-30T11:21:00.000Z",
    ...overrides,
  }
}

function makeTrace(overrides: Partial<SimulationDebugTrace> = {}): SimulationDebugTrace {
  return {
    id: `t-${Math.random().toString(36).slice(2, 8)}`,
    type: "round-plan",
    nodeIndex: 0,
    nodeTitle: "开端",
    round: 0,
    strategy: "all-agents",
    candidateAgents: [{ agentId: "a1", agentName: "林越", reason: "在场" }],
    selectedAgents: [{ agentId: "a1", agentName: "林越", reason: "发言" }],
    blackboard: {
      allAgentCount: 2,
      activeAgentCount: 1,
      totalEventCount: 5,
      publicEventCount: 4,
      rumorCount: 1,
    },
    visibilityByAgent: [
      {
        agentId: "a1",
        agentName: "林越",
        visibleEventCount: 3,
        recentEvents: [
          { id: "vis-1", actorName: "林越", actionType: "speak", content: "可见", round: 0, nodeIndex: 0 },
        ],
      },
    ],
    latestEvent: {
      id: "le-1",
      actorName: "林越",
      actionType: "speak",
      content: "最近事件内容 UNIQUE-LATEST-9",
      round: 0,
      nodeIndex: 0,
    },
    rumors: [],
    activeAgents: new Map(),
    timestamp: "2026-10-30T11:21:00.000Z",
    ...overrides,
  }
}

function makeFramework(): StoryFramework {
  return {
    nodes: [
      { index: 0, title: "山寨议事", phase: "起" },
      { index: 1, title: "夜探商队", phase: "承" },
    ],
  } as unknown as StoryFramework
}

function baseProps(overrides: Record<string, unknown> = {}) {
  return {
    progress: 42,
    label: "正在推演 UNIQUE-LABEL-7",
    events: [] as TimelineEvent[],
    debugTraces: [] as SimulationDebugTrace[],
    framework: null,
    onInterviewAgent: undefined,
    onCancel: undefined,
    cancelling: false,
    branches: [] as SimulationBranch[],
    activeBranchId: null,
    compareBranchIds: [] as string[],
    isCompareMode: false,
    onSaveBranch: vi.fn(),
    onDeleteBranch: vi.fn(),
    onRenameBranch: vi.fn(),
    onSwitchBranch: vi.fn(),
    onToggleCompareBranch: vi.fn(),
    onSetCompareMode: vi.fn(),
    onClearCompareSelection: vi.fn(),
    ...overrides,
  }
}

function clickTab(name: string): void {
  fireEvent.click(screen.getByText(name))
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

describe("PROGRESS_PHASES", () => {
  it("包含推演五阶段且顺序固定", () => {
    expect([...PROGRESS_PHASES]).toEqual([
      "extracting",
      "framework-generating",
      "simulating",
      "report-generating",
      "draft-generating",
    ])
  })
})

describe("SimulatingTimelinePanel 进度与取消", () => {
  it("渲染 label 与进度百分比", () => {
    render(<SimulatingTimelinePanel {...baseProps()} />)
    expect(screen.getByText("正在推演 UNIQUE-LABEL-7")).toBeTruthy()
    expect(screen.getByText("42%")).toBeTruthy()
  })

  it("进度钳制到 0-100（超限与负数）", () => {
    const { unmount } = render(<SimulatingTimelinePanel {...baseProps({ progress: 150 })} />)
    expect(screen.getByText("100%")).toBeTruthy()
    unmount()
    render(<SimulatingTimelinePanel {...baseProps({ progress: -20 })} />)
    expect(screen.getByText("0%")).toBeTruthy()
  })

  it("无 onCancel 时不渲染取消按钮", () => {
    render(<SimulatingTimelinePanel {...baseProps()} />)
    expect(screen.queryByText("取消推演")).toBeNull()
  })

  it("点击取消按钮触发 onCancel；cancelling 时禁用并显示取消中", () => {
    const onCancel = vi.fn()
    const { unmount } = render(<SimulatingTimelinePanel {...baseProps({ onCancel })} />)
    fireEvent.click(screen.getByText("取消推演"))
    expect(onCancel).toHaveBeenCalledTimes(1)
    unmount()
    render(<SimulatingTimelinePanel {...baseProps({ onCancel, cancelling: true })} />)
    const btn = screen.getByText("正在取消...").closest("button") as HTMLButtonElement
    expect(btn.disabled).toBe(true)
  })
})

describe("SimulatingTimelinePanel 时间线筛选与折叠", () => {
  it("无事件时显示等待提示", () => {
    render(<SimulatingTimelinePanel {...baseProps()} />)
    expect(screen.getByText("等待角色行动...")).toBeTruthy()
  })

  it("事件按节点分组渲染并显示计数", () => {
    render(
      <SimulatingTimelinePanel
        {...baseProps({
          framework: makeFramework(),
          events: [
            makeEvent({ id: "e1", nodeIndex: 0 }),
            makeEvent({ id: "e2", nodeIndex: 1, actorName: "沈清秋", content: "第二节点事件 UNIQUE-EVT-2" }),
          ],
        })}
      />,
    )
    expect(screen.getByText(/山寨议事/)).toBeTruthy()
    expect(screen.getByText(/夜探商队/)).toBeTruthy()
    expect(screen.getByText("第二节点事件 UNIQUE-EVT-2")).toBeTruthy()
    expect(screen.getByText("显示 2/2 条")).toBeTruthy()
  })

  it("未知 phase 原样输出（phaseLabel 回退分支）", () => {
    const fw = {
      nodes: [{ index: 0, title: "终章", phase: "终" }],
    } as unknown as StoryFramework
    render(
      <SimulatingTimelinePanel
        {...baseProps({ framework: fw, events: [makeEvent({ id: "e8" })] })}
      />,
    )
    expect(screen.getByText("终")).toBeTruthy()
  })

  it("同节点多事件归入同一分组", () => {
    render(
      <SimulatingTimelinePanel
        {...baseProps({
          events: [
            makeEvent({ id: "e-s1", nodeIndex: 0 }),
            makeEvent({ id: "e-s2", nodeIndex: 0, actorName: "沈清秋", content: "同组第二条 UNIQUE-EVT-8" }),
          ],
        })}
      />,
    )
    expect(screen.getByText("同组第二条 UNIQUE-EVT-8")).toBeTruthy()
    expect(screen.getByText("2 条事件")).toBeTruthy()
  })

  it("无 framework 时回退到默认节点标题并原样输出未知 phase", () => {
    render(
      <SimulatingTimelinePanel
        {...baseProps({ events: [makeEvent({ id: "e9", nodeIndex: 2 })] })}
      />,
    )
    // 节点 3：节点 3（标题回退），phase 回退为"起"
    expect(screen.getByText(/节点 3/)).toBeTruthy()
  })

  it("按角色筛选后可清除筛选；无匹配显示空态", () => {
    render(
      <SimulatingTimelinePanel
        {...baseProps({
          events: [
            makeEvent({ id: "e1", actorName: "林越", actionType: "speak" }),
            makeEvent({ id: "e2", actorName: "沈清秋", actionType: "observe", content: "观察事件 UNIQUE-EVT-3" }),
          ],
        })}
      />,
    )
    const selects = screen.getAllByRole("combobox")
    expect(selects).toHaveLength(2)
    fireEvent.change(selects[0], { target: { value: "林越" } })
    expect(screen.queryByText("观察事件 UNIQUE-EVT-3")).toBeNull()
    expect(screen.getByText("调试面板事件内容 UNIQUE-EVT-1")).toBeTruthy()
    fireEvent.click(screen.getByText("清除筛选"))
    expect(screen.getByText("观察事件 UNIQUE-EVT-3")).toBeTruthy()
  })

  it("按行为类型筛选", () => {
    render(
      <SimulatingTimelinePanel
        {...baseProps({
          events: [
            makeEvent({ id: "e1", actionType: "speak" }),
            makeEvent({ id: "e2", actionType: "observe", content: "观察事件 UNIQUE-EVT-4" }),
          ],
        })}
      />,
    )
    const selects = screen.getAllByRole("combobox")
    fireEvent.change(selects[1], { target: { value: "observe" } })
    expect(screen.queryByText("调试面板事件内容 UNIQUE-EVT-1")).toBeNull()
    expect(screen.getByText("观察事件 UNIQUE-EVT-4")).toBeTruthy()
    expect(screen.getByText("显示 1/2 条")).toBeTruthy()
  })

  it("筛选到零结果显示无匹配空态", () => {
    render(
      <SimulatingTimelinePanel
        {...baseProps({ events: [makeEvent({ id: "e1", actorName: "林越" })] })}
      />,
    )
    const selects = screen.getAllByRole("combobox")
    fireEvent.change(selects[0], { target: { value: "不存在的角色" } })
    expect(screen.getByText("没有符合筛选条件的事件")).toBeTruthy()
  })

  it("全部折叠隐藏事件、全部展开展示事件；点击节点标题切换折叠", () => {
    render(
      <SimulatingTimelinePanel
        {...baseProps({ events: [makeEvent({ id: "e1" })] })}
      />,
    )
    fireEvent.click(screen.getByText("全部折叠"))
    expect(screen.queryByText("调试面板事件内容 UNIQUE-EVT-1")).toBeNull()
    fireEvent.click(screen.getByText("全部展开"))
    expect(screen.getByText("调试面板事件内容 UNIQUE-EVT-1")).toBeTruthy()
    fireEvent.click(screen.getByText(/节点 1/))
    expect(screen.queryByText("调试面板事件内容 UNIQUE-EVT-1")).toBeNull()
    fireEvent.click(screen.getByText(/节点 1/))
    expect(screen.getByText("调试面板事件内容 UNIQUE-EVT-1")).toBeTruthy()
  })
})

describe("SimulatingTimelinePanel 角色访谈入口", () => {
  it("有 onInterviewAgent 时 actor 与 target 均为按钮并回调对应 id", () => {
    const onInterviewAgent = vi.fn()
    render(
      <SimulatingTimelinePanel
        {...baseProps({
          onInterviewAgent,
          events: [
            makeEvent({ id: "e1", actorId: "a1", actorName: "林越", targetId: "a2", targetName: "沈清秋" }),
          ],
        })}
      />,
    )
    fireEvent.click(screen.getByRole("button", { name: "林越" }))
    expect(onInterviewAgent).toHaveBeenCalledWith("a1", "林越")
    fireEvent.click(screen.getByRole("button", { name: "沈清秋" }))
    expect(onInterviewAgent).toHaveBeenCalledWith("a2", "沈清秋")
  })

  it("无 onInterviewAgent 时 actor/target 渲染为纯文本且无按钮", () => {
    const { container } = render(
      <SimulatingTimelinePanel
        {...baseProps({
          events: [
            makeEvent({ id: "e1", actorName: "林越", targetId: "a2", targetName: "沈清秋" }),
          ],
        })}
      />,
    )
    const actorSpans = screen.getAllByText("林越").filter((el) => el.tagName === "SPAN")
    expect(actorSpans.length).toBeGreaterThan(0)
    expect(screen.queryByRole("button", { name: "林越" })).toBeNull()
    expect(container.querySelectorAll("button").length).toBeGreaterThan(0)
    // 时间线事件区内没有可点击的人名按钮（只有 Tab 与折叠按钮）
    const eventText = screen.getByText("调试面板事件内容 UNIQUE-EVT-1")
    expect(eventText).toBeTruthy()
  })

  it("有 target 但无 onInterviewAgent 时走 actionTypePhrase 文案分支", () => {
    render(
      <SimulatingTimelinePanel
        {...baseProps({
          events: [
            makeEvent({ id: "e1", actionType: "speak", targetName: "沈清秋" }),
          ],
        })}
      />,
    )
    // actionTypePhrase(speak, 沈清秋) 渲染目标名文案而非按钮
    expect(screen.getByText(/沈清秋/)).toBeTruthy()
  })
})

describe("SimulatingTimelinePanel 视图切换", () => {
  it("过程观察无 trace 显示等待文案；有 trace 显示统计", () => {
    render(<SimulatingTimelinePanel {...baseProps()} />)
    clickTab("过程观察")
    expect(screen.getByText("等待推演过程数据...")).toBeTruthy()
  })

  it("过程观察有 trace 时渲染黑板统计", () => {
    render(<SimulatingTimelinePanel {...baseProps({ debugTraces: [makeTrace()] })} />)
    clickTab("过程观察")
    expect(screen.getByText("全量角色")).toBeTruthy()
    expect(screen.getByText("轮次计划")).toBeTruthy()
  })

  it("传闻/线索 Tab 挂载对应面板空态", () => {
    render(<SimulatingTimelinePanel {...baseProps()} />)
    clickTab("传闻")
    expect(screen.getByText("暂无传闻数据")).toBeTruthy()
    clickTab("线索")
    expect(screen.getByText("暂无线索数据，开始推演后会自动生成")).toBeTruthy()
  })

  it("分支管理 Tab 渲染空态并可透出创建回调", () => {
    const props = baseProps()
    render(<SimulatingTimelinePanel {...props} />)
    clickTab("分支管理")
    expect(screen.getByText("暂无保存的分支")).toBeTruthy()
    const input = screen.getByPlaceholderText("输入分支名称...")
    fireEvent.change(input, { target: { value: "面板内建分支 UNIQUE-BR-5" } })
    fireEvent.click(screen.getByText("创建分支"))
    expect(props.onSaveBranch).toHaveBeenCalledWith("面板内建分支 UNIQUE-BR-5")
  })

  it("多主角织网 Tab 渲染织网视图", () => {
    render(<SimulatingTimelinePanel {...baseProps()} />)
    clickTab("多主角织网")
    expect(screen.getByText("多主角并行织网视图 (Multi-POV Mesh)")).toBeTruthy()
  })

  it("非时间线视图下事件更新不触碰滚动（logRef 为空分支）", () => {
    const props = baseProps({ events: [makeEvent({ id: "e-log-1" })] })
    const view = render(<SimulatingTimelinePanel {...props} />)
    clickTab("过程观察")
    view.rerender(
      <SimulatingTimelinePanel
        {...props}
        events={[makeEvent({ id: "e-log-1" }), makeEvent({ id: "e-log-2", content: "后台新增 UNIQUE-EVT-LOG" })]}
      />,
    )
    expect(screen.getByText("等待推演过程数据...")).toBeTruthy()
    clickTab("时间线")
    expect(screen.getByText("后台新增 UNIQUE-EVT-LOG")).toBeTruthy()
  })

  it("切回时间线保留事件列表", () => {
    render(<SimulatingTimelinePanel {...baseProps({ events: [makeEvent({ id: "e1" })] })} />)
    clickTab("过程观察")
    clickTab("时间线")
    expect(screen.getByText("调试面板事件内容 UNIQUE-EVT-1")).toBeTruthy()
  })
})

describe("ProcessDebugPanel", () => {
  it("空 trace 显示等待文案", () => {
    render(<ProcessDebugPanel debugTraces={[]} />)
    expect(screen.getByText("等待推演过程数据...")).toBeTruthy()
  })

  it("渲染黑板四项统计与 trace 元信息", () => {
    render(<ProcessDebugPanel debugTraces={[makeTrace()]} />)
    expect(screen.getByText("全量角色")).toBeTruthy()
    expect(screen.getByText("本轮行动 Agent")).toBeTruthy()
    expect(screen.getByText(/节点 1：开端/)).toBeTruthy()
    expect(screen.getByText(/最近事件内容 UNIQUE-LATEST-9/)).toBeTruthy()
  })

  it("event-recorded 类型显示事件写入标签", () => {
    render(<ProcessDebugPanel debugTraces={[makeTrace({ type: "event-recorded" })]} />)
    expect(screen.getByText("事件写入")).toBeTruthy()
  })

  it("三种策略标签与缺失策略分支", () => {
    const { unmount } = render(<ProcessDebugPanel debugTraces={[makeTrace({ strategy: "subset" })]} />)
    expect(screen.getByText(/部分角色/)).toBeTruthy()
    unmount()
    const r2 = render(<ProcessDebugPanel debugTraces={[makeTrace({ strategy: "none" })]} />)
    expect(r2.getByText(/无角色/)).toBeTruthy()
    r2.unmount()
    render(<ProcessDebugPanel debugTraces={[makeTrace({ strategy: undefined })]} />)
    expect(screen.queryByText(/策略：/)).toBeNull()
    expect(screen.getByText("轮次计划")).toBeTruthy()
  })

  it("零角色时显示无角色警告；有角色时不显示", () => {
    const { unmount } = render(
      <ProcessDebugPanel
        debugTraces={[makeTrace({ blackboard: { allAgentCount: 0, activeAgentCount: 0, totalEventCount: 0, publicEventCount: 0, rumorCount: 0 } })]}
      />,
    )
    expect(screen.getByText("💡 当前推演没有角色参与")).toBeTruthy()
    unmount()
    render(<ProcessDebugPanel debugTraces={[makeTrace()]} />)
    expect(screen.queryByText("💡 当前推演没有角色参与")).toBeNull()
  })

  it("无 latestEvent 时不渲染最近事件块", () => {
    render(<ProcessDebugPanel debugTraces={[makeTrace({ latestEvent: undefined })]} />)
    expect(screen.queryByText("最近事件：")).toBeNull()
    expect(screen.getByText("轮次计划")).toBeTruthy()
  })

  it("visibility 缺失 visibleEventCount 时回退为 0", () => {
    render(
      <ProcessDebugPanel
        debugTraces={[
          makeTrace({
            visibilityByAgent: [{ agentId: "a3", agentName: "白衣人 UNIQUE-VIS-0" }],
          }),
        ]}
      />,
    )
    expect(screen.getByText(/可见事件 0 条/)).toBeTruthy()
  })

  it("visibility 无 recentEvents 时只显示计数", () => {
    render(
      <ProcessDebugPanel
        debugTraces={[
          makeTrace({
            visibilityByAgent: [{ agentId: "a2", agentName: "沈清秋", visibleEventCount: 0 }],
          }),
        ]}
      />,
    )
    expect(screen.getByText("沈清秋")).toBeTruthy()
    expect(screen.getByText(/可见事件 0 条/)).toBeTruthy()
  })

  it("多条 trace 按倒序只取最近 50 条", () => {
    const traces = Array.from({ length: 3 }, (_, i) =>
      makeTrace({ id: `t-${i}`, nodeTitle: `节点标题-UNIQUE-${i}` }),
    )
    render(<ProcessDebugPanel debugTraces={traces} />)
    // 最新一条（t-2）的黑板统计用于顶部展示
    expect(screen.getByText(/节点标题-UNIQUE-2/)).toBeTruthy()
    expect(screen.getByText(/节点标题-UNIQUE-0/)).toBeTruthy()
  })
})

describe("DebugStat / DebugAgentList", () => {
  it("DebugStat 渲染 label 与 value", () => {
    render(<DebugStat label="全量角色" value={7} />)
    expect(screen.getByText("全量角色")).toBeTruthy()
    expect(screen.getByText("7")).toBeTruthy()
  })

  it("DebugAgentList 空态显示无；非空渲染人名与 reason title", () => {
    const { unmount } = render(<DebugAgentList title="候选 Agent" agents={[]} />)
    expect(screen.getByText("候选 Agent")).toBeTruthy()
    expect(screen.getByText("无")).toBeTruthy()
    unmount()
    render(
      <DebugAgentList
        title="本轮行动 Agent"
        agents={[{ agentId: "a1", agentName: "林越 UNIQUE-AG-3", reason: "首轮发言" }]}
      />,
    )
    const el = screen.getByText("林越 UNIQUE-AG-3")
    expect(el.getAttribute("title")).toBe("首轮发言")
  })
})
