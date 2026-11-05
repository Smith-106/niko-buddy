// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup } from "@testing-library/react"
import { fireEvent, render, screen, waitFor } from "@/test-helpers/component-test-utils"
import { InterviewHistoryView } from "./interview-history-view"
import { useStorySimulationStore } from "@/stores/story-simulation-store"
import { useWikiStore } from "@/stores/wiki-store"
import {
  deleteInterview,
  deserializeSimulationSnapshot,
  exportInterview,
  loadInterviews,
  loadSimulationResults,
} from "@/lib/novel"
import type { NovelAgent, SavedInterview } from "@/lib/novel"
import zh from "@/i18n/zh.json"

vi.mock("@/lib/novel", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/novel")>()
  return {
    ...actual,
    loadInterviews: vi.fn(),
    deleteInterview: vi.fn(),
    exportInterview: vi.fn(),
    deserializeSimulationSnapshot: vi.fn(),
    loadSimulationResults: vi.fn(),
  }
})

vi.mock("@/components/editor/wiki-reader", () => ({
  WikiReader: ({ body }: { body: string }) => <div data-testid="wiki-body">{body}</div>,
}))

const T = zh.storySimulation as unknown as Record<string, string>
const PROJECT = { id: "p1", name: "proj", path: "C:/proj" }

function makeInterview(overrides: Partial<SavedInterview> = {}): SavedInterview {
  return {
    id: "iv-1",
    agentName: "寨主",
    frameworkId: "fw-1",
    frameworkTitle: "夜袭",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-02T03:04:00.000Z",
    session: {
      agentId: "c1",
      agentName: "寨主",
      messages: [
        { id: "m1", role: "user", content: "你是谁", timestamp: "2026-01-02T03:00:00.000Z" },
        { id: "m2", role: "agent", content: "我是寨主", timestamp: "2026-01-02T03:01:00.000Z" },
      ],
    },
    ...overrides,
  }
}

function makeAgent(name: string): NovelAgent {
  return { characterId: `c-${name}`, name } as NovelAgent
}

function showWith(interviews: SavedInterview[], extra: Record<string, unknown> = {}) {
  useWikiStore.setState({ project: PROJECT } as never)
  useStorySimulationStore.setState({
    showInterviewHistory: true,
    savedInterviews: interviews,
    viewingInterview: null,
    error: null,
    infoMessage: null,
    continuingInterviewId: null,
    activeChatAgent: null,
    agentChatMessages: [],
    ...extra,
  } as never)
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.spyOn(window, "confirm").mockReturnValue(true)
  vi.spyOn(console, "error").mockImplementation(() => {})
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  useStorySimulationStore.setState({
    showInterviewHistory: false,
    savedInterviews: [],
    viewingInterview: null,
    error: null,
    infoMessage: null,
    continuingInterviewId: null,
    activeChatAgent: null,
    agentChatMessages: [],
  } as never)
  useWikiStore.setState({ project: null } as never)
})

describe("InterviewHistoryView 隐藏与加载", () => {
  it("showInterviewHistory=false 时渲染 null", () => {
    useWikiStore.setState({ project: PROJECT } as never)
    useStorySimulationStore.setState({ showInterviewHistory: false } as never)
    const { container } = render(<InterviewHistoryView />)
    expect(container.innerHTML).toBe("")
    expect(screen.queryByRole("dialog")).toBeNull()
  })

  it("无 projectPath 时不调用 loadInterviews，直接显示空态", () => {
    useWikiStore.setState({ project: null } as never)
    useStorySimulationStore.setState({
      showInterviewHistory: true,
      savedInterviews: [],
      viewingInterview: null,
    } as never)
    render(<InterviewHistoryView />)
    expect(vi.mocked(loadInterviews)).not.toHaveBeenCalled()
    expect(screen.getByText(T.noInterviews)).toBeTruthy()
    expect(screen.getByText(T.noInterviewsHint)).toBeTruthy()
  })

  it("加载中显示 loading，成功后渲染列表（含徽章、消息数、日期）", async () => {
    const interviews = [makeInterview()]
    let resolveLoad!: (v: SavedInterview[]) => void
    vi.mocked(loadInterviews).mockReturnValue(
      new Promise((res) => {
        resolveLoad = res
      }),
    )
    showWith([])
    render(<InterviewHistoryView />)
    expect(await screen.findByText(T.loading)).toBeTruthy()
    resolveLoad(interviews)
    await waitFor(() => {
      expect(useStorySimulationStore.getState().savedInterviews).toHaveLength(1)
    })
    await waitFor(() => {
      expect(screen.getByText("寨主")).toBeTruthy()
    })
    // 框架徽章、消息数、日期年份都应出现
    expect(screen.getByText("夜袭")).toBeTruthy()
    expect(screen.getByText(T.messageCount.replace("{{count}}", "2"))).toBeTruthy()
    expect(document.body.textContent ?? "").toContain("2026")
  })

  it("加载失败时 console.error 且保持空态", async () => {
    vi.mocked(loadInterviews).mockRejectedValue(new Error("disk boom"))
    showWith([])
    render(<InterviewHistoryView />)
    await waitFor(() => {
      expect(console.error).toHaveBeenCalled()
    })
    await waitFor(() => {
      expect(screen.queryByText(T.loading)).toBeNull()
    })
    expect(screen.getByText(T.noInterviews)).toBeTruthy()
  })

  it("空会话预览显示 emptyConversation；长消息截断 50 字加省略号", async () => {
    const long = "长".repeat(80)
    const interviews = [
      makeInterview({
        id: "empty",
        agentName: "空者",
        frameworkTitle: undefined,
        session: { agentId: "c9", agentName: "空者", messages: [] },
      }),
      makeInterview({ id: "long", agentName: "话痨", session: {
        agentId: "c8",
        agentName: "话痨",
        messages: [{ id: "m9", role: "agent", content: long, timestamp: "2026-01-02T03:01:00.000Z" }],
      } }),
    ]
    vi.mocked(loadInterviews).mockResolvedValue(interviews)
    showWith([])
    render(<InterviewHistoryView />)
    await waitFor(() => {
      expect(screen.getByText("空者")).toBeTruthy()
    })
    expect(screen.getByText(T.emptyConversation)).toBeTruthy()
    expect(screen.getByText(`${"长".repeat(50)}...`)).toBeTruthy()
  })
})

describe("InterviewHistoryView 关闭交互", () => {
  it("点击 X 关闭并清空 viewingInterview", async () => {
    vi.mocked(loadInterviews).mockResolvedValue([])
    showWith([], { viewingInterview: makeInterview() })
    render(<InterviewHistoryView />)
    const dialog = await screen.findByRole("dialog")
    expect(dialog.getAttribute("aria-label")).toContain("寨主")
    const closeBtn = dialog.querySelector("button") as HTMLButtonElement
    fireEvent.click(closeBtn)
    expect(useStorySimulationStore.getState().showInterviewHistory).toBe(false)
    expect(useStorySimulationStore.getState().viewingInterview).toBeNull()
  })

  it("点击背景遮罩关闭，点击内容区不关闭", async () => {
    vi.mocked(loadInterviews).mockResolvedValue([])
    showWith([])
    render(<InterviewHistoryView />)
    const dialog = await screen.findByRole("dialog")
    fireEvent.click(dialog)
    expect(useStorySimulationStore.getState().showInterviewHistory).toBe(false)

    useStorySimulationStore.setState({ showInterviewHistory: true } as never)
    const dialog2 = await screen.findByRole("dialog")
    const inner = dialog2.firstElementChild as HTMLElement
    fireEvent.click(inner)
    expect(useStorySimulationStore.getState().showInterviewHistory).toBe(true)
  })

  it("Escape 关闭；关闭后移除监听（再次 Escape 无影响）", async () => {
    vi.mocked(loadInterviews).mockResolvedValue([])
    showWith([])
    render(<InterviewHistoryView />)
    await screen.findByRole("dialog")
    fireEvent.keyDown(window, { key: "Escape" })
    expect(useStorySimulationStore.getState().showInterviewHistory).toBe(false)
  })
})

describe("InterviewHistoryView 详情视图", () => {
  it("点击列表项进入详情：user 右对齐、agent 显示名、WikiReader 内容", async () => {
    const interviews = [makeInterview()]
    vi.mocked(loadInterviews).mockResolvedValue(interviews)
    showWith(interviews)
    render(<InterviewHistoryView />)
    fireEvent.click(await screen.findByText("寨主"))
    const st = useStorySimulationStore.getState()
    expect(st.viewingInterview?.id).toBe("iv-1")
    expect((await screen.findAllByTestId("wiki-body"))).toHaveLength(2)
    expect(screen.getByText("我是寨主")).toBeTruthy()
    expect(screen.getByText("你是谁")).toBeTruthy()
    // 返回按钮回到列表
    fireEvent.click(screen.getByText(T.backToList))
    expect(useStorySimulationStore.getState().viewingInterview).toBeNull()
  })

  it("详情空消息显示 noMessages；框架前缀显示 frameworkTitle", async () => {
    vi.mocked(loadInterviews).mockResolvedValue([])
    const iv = makeInterview({
      session: { agentId: "c1", agentName: "寨主", messages: [] },
    })
    showWith([], { viewingInterview: iv })
    render(<InterviewHistoryView />)
    expect(await screen.findByText(T.noMessages)).toBeTruthy()
    expect(screen.getByText(T.frameworkPrefix.replace("{{title}}", "夜袭"))).toBeTruthy()
  })
})

describe("InterviewHistoryView 删除", () => {
  it("confirm 取消时不删除", async () => {
    vi.mocked(window.confirm).mockReturnValue(false)
    vi.mocked(loadInterviews).mockResolvedValue([])
    const iv = makeInterview()
    showWith([], { viewingInterview: iv })
    render(<InterviewHistoryView />)
    // 详情视图中的删除按钮
    fireEvent.click(screen.getByText(T.delete))
    expect(vi.mocked(window.confirm)).toHaveBeenCalledWith(
      T.deleteInterviewConfirm.replace("{{name}}", "寨主"),
    )
    expect(vi.mocked(deleteInterview)).not.toHaveBeenCalled()
    expect(useStorySimulationStore.getState().viewingInterview).not.toBeNull()
  })

  it("删除成功：从列表移除、清空正在查看项、提示已删除", async () => {
    const iv = makeInterview()
    const other = makeInterview({ id: "iv-2", agentName: "军师" })
    vi.mocked(loadInterviews).mockResolvedValue([iv, other])
    vi.mocked(deleteInterview).mockResolvedValue(undefined)
    showWith([iv, other], { viewingInterview: iv })
    render(<InterviewHistoryView />)
    fireEvent.click(screen.getByText(T.delete))
    await waitFor(() => {
      expect(vi.mocked(deleteInterview)).toHaveBeenCalledWith("C:/proj", "iv-1")
    })
    await waitFor(() => {
      expect(useStorySimulationStore.getState().savedInterviews.map((i) => i.id)).toEqual(["iv-2"])
    })
    expect(useStorySimulationStore.getState().viewingInterview).toBeNull()
    expect(useStorySimulationStore.getState().infoMessage).toBe(T.interviewDeleted)
  })

  it("删除非正在查看项时保留 viewingInterview；删除失败写 error", async () => {
    const iv = makeInterview()
    const other = makeInterview({ id: "iv-2", agentName: "军师" })
    vi.mocked(loadInterviews).mockResolvedValue([iv, other])
    vi.mocked(deleteInterview).mockRejectedValueOnce(new Error("rm fail"))
    showWith([iv, other], { viewingInterview: other })
    render(<InterviewHistoryView />)
    // 在详情里删的是 other？先切到列表再删第一项：回到列表
    fireEvent.click(screen.getByText(T.backToList))
    const dels = await screen.findAllByTitle(T.delete)
    fireEvent.click(dels[0])
    await waitFor(() => {
      expect(useStorySimulationStore.getState().error).toContain("操作失败")
    })
    // 列表保持不变
    expect(useStorySimulationStore.getState().savedInterviews).toHaveLength(2)
  })

  it("无 projectPath 时删除直接返回", async () => {
    useWikiStore.setState({ project: null } as never)
    useStorySimulationStore.setState({
      showInterviewHistory: true,
      savedInterviews: [makeInterview()],
      viewingInterview: makeInterview(),
    } as never)
    vi.mocked(loadInterviews).mockResolvedValue([])
    render(<InterviewHistoryView />)
    fireEvent.click(await screen.findByText(T.delete))
    expect(vi.mocked(deleteInterview)).not.toHaveBeenCalled()
  })
})

describe("InterviewHistoryView 导出", () => {
  it("导出成功提示路径", async () => {
    vi.mocked(loadInterviews).mockResolvedValue([])
    vi.mocked(exportInterview).mockResolvedValue("/exports/iv.md")
    const iv = makeInterview()
    showWith([], { viewingInterview: iv })
    render(<InterviewHistoryView />)
    fireEvent.click(screen.getByText(T.export))
    await waitFor(() => {
      expect(vi.mocked(exportInterview)).toHaveBeenCalledWith("C:/proj", iv)
    })
    await waitFor(() => {
      expect(useStorySimulationStore.getState().infoMessage).toBe(
        T.interviewExported.replace("{{path}}", "/exports/iv.md"),
      )
    })
  })

  it("导出失败写 error", async () => {
    vi.mocked(loadInterviews).mockResolvedValue([])
    vi.mocked(exportInterview).mockRejectedValue(new Error("write fail"))
    showWith([], { viewingInterview: makeInterview() })
    render(<InterviewHistoryView />)
    fireEvent.click(screen.getByText(T.export))
    await waitFor(() => {
      expect(useStorySimulationStore.getState().error).toContain("操作失败")
    })
  })
})

describe("InterviewHistoryView 继续采访", () => {
  it("agentSnapshot 快照恢复成功：写消息/角色/continuingId 并隐藏面板", async () => {
    vi.mocked(loadInterviews).mockResolvedValue([])
    const agents = [makeAgent("寨主"), makeAgent("军师")]
    vi.mocked(deserializeSimulationSnapshot).mockReturnValue({ agents, state: {} as never })
    const iv = makeInterview({ agentSnapshot: { agents: [], state: {} } as never })
    showWith([], { viewingInterview: iv })
    render(<InterviewHistoryView />)
    fireEvent.click(screen.getByText(T.continueChat))
    await waitFor(() => {
      expect(vi.mocked(deserializeSimulationSnapshot)).toHaveBeenCalled()
    })
    const st = useStorySimulationStore.getState()
    expect(st.agentChatMessages).toHaveLength(2)
    expect(st.activeChatAgent).toEqual({ id: "c-寨主", name: "寨主" })
    expect(st.continuingInterviewId).toBe("iv-1")
    expect(st.showInterviewHistory).toBe(false)
    expect(st.viewingInterview).toBeNull()
    expect(st.infoMessage).toBe(T.interviewResumed)
  })

  it("无快照时从 frameworkId 推演结果回退：跳过无快照条目并命中同名 agent", async () => {
    vi.mocked(loadInterviews).mockResolvedValue([])
    const agents = [makeAgent("寨主")]
    vi.mocked(deserializeSimulationSnapshot).mockReturnValue({ agents, state: {} as never })
    vi.mocked(loadSimulationResults).mockResolvedValue([
      { agentSnapshot: null },
      { agentSnapshot: { agents: [], state: {} } },
    ] as never)
    const iv = makeInterview({ agentSnapshot: undefined })
    showWith([], { viewingInterview: iv })
    render(<InterviewHistoryView />)
    fireEvent.click(screen.getByText(T.continueChat))
    await waitFor(() => {
      expect(vi.mocked(loadSimulationResults)).toHaveBeenCalledWith("C:/proj", "fw-1")
    })
    // 第二条快照命中（deserialize 被调了两次：空快照分支跳过第一次后命中）
    await waitFor(() => {
      expect(useStorySimulationStore.getState().continuingInterviewId).toBe("iv-1")
    })
  })

  it("恢复不到任何 agent 时报错 cannotRestore", async () => {
    vi.mocked(loadInterviews).mockResolvedValue([])
    vi.mocked(deserializeSimulationSnapshot).mockReturnValue({ agents: [], state: {} as never })
    vi.mocked(loadSimulationResults).mockResolvedValue([])
    const iv = makeInterview({ agentSnapshot: undefined })
    showWith([], { viewingInterview: iv })
    render(<InterviewHistoryView />)
    fireEvent.click(screen.getByText(T.continueChat))
    await waitFor(() => {
      expect(useStorySimulationStore.getState().error).toBe(T.cannotRestoreReadonly)
    })
    expect(useStorySimulationStore.getState().showInterviewHistory).toBe(true)
  })

  it("快照 agents 不含目标角色时报错 agentDataNotFound", async () => {
    vi.mocked(loadInterviews).mockResolvedValue([])
    vi.mocked(deserializeSimulationSnapshot).mockReturnValue({
      agents: [makeAgent("路人")],
      state: {} as never,
    })
    const iv = makeInterview({ agentSnapshot: { agents: [], state: {} } as never })
    showWith([], { viewingInterview: iv })
    render(<InterviewHistoryView />)
    fireEvent.click(screen.getByText(T.continueChat))
    await waitFor(() => {
      expect(useStorySimulationStore.getState().error).toBe(
        T.agentDataNotFound.replace("{{name}}", "寨主"),
      )
    })
  })

  it("继续采访抛错写 error", async () => {
    vi.mocked(loadInterviews).mockResolvedValue([])
    vi.mocked(deserializeSimulationSnapshot).mockImplementation(() => {
      throw new Error("bad snapshot")
    })
    const iv = makeInterview({ agentSnapshot: { agents: [], state: {} } as never })
    showWith([], { viewingInterview: iv })
    render(<InterviewHistoryView />)
    fireEvent.click(screen.getByText(T.continueChat))
    await waitFor(() => {
      expect(useStorySimulationStore.getState().error).toContain("操作失败")
    })
  })

  it("无 projectPath 时继续采访直接返回", () => {
    useWikiStore.setState({ project: null } as never)
    useStorySimulationStore.setState({
      showInterviewHistory: true,
      savedInterviews: [],
      viewingInterview: makeInterview(),
    } as never)
    vi.mocked(loadInterviews).mockResolvedValue([])
    render(<InterviewHistoryView />)
    fireEvent.click(screen.getByText(T.continueChat))
    expect(vi.mocked(deserializeSimulationSnapshot)).not.toHaveBeenCalled()
    expect(useStorySimulationStore.getState().continuingInterviewId).toBeNull()
  })

  it("回退时跳过同名不匹配的快照，命中后停止", async () => {
    vi.mocked(loadInterviews).mockResolvedValue([])
    vi.mocked(deserializeSimulationSnapshot)
      .mockReturnValueOnce({ agents: [makeAgent("路人")], state: {} as never })
      .mockReturnValue({ agents: [makeAgent("寨主")], state: {} as never })
    vi.mocked(loadSimulationResults).mockResolvedValue([
      { agentSnapshot: null },
      { agentSnapshot: { agents: [], state: {} } },
      { agentSnapshot: { agents: [], state: {} } },
    ] as never)
    const iv = makeInterview({ agentSnapshot: undefined })
    showWith([], { viewingInterview: iv })
    render(<InterviewHistoryView />)
    fireEvent.click(screen.getByText(T.continueChat))
    await waitFor(() => {
      expect(useStorySimulationStore.getState().continuingInterviewId).toBe("iv-1")
    })
    // 第一个有快照的条目不匹配（some=false 继续），第二个命中（some=true 中断）
    expect(vi.mocked(deserializeSimulationSnapshot)).toHaveBeenCalledTimes(2)
  })
})

describe("InterviewHistoryView 补充覆盖", () => {
  it("删除非正在查看项成功：保留 viewing，列表移除", async () => {
    const iv = makeInterview()
    const other = makeInterview({ id: "iv-2", agentName: "军师" })
    vi.mocked(loadInterviews).mockResolvedValue([iv, other])
    vi.mocked(deleteInterview).mockResolvedValue(undefined)
    showWith([iv, other], { viewingInterview: other })
    render(<InterviewHistoryView />)
    fireEvent.click(screen.getByText(T.backToList))
    const dels = await screen.findAllByTitle(T.delete)
    fireEvent.click(dels[0])
    await waitFor(() => {
      expect(useStorySimulationStore.getState().savedInterviews.map((i) => i.id)).toEqual(["iv-2"])
    })
    // 返回列表时 viewing 已为 null；删除他人不影响（覆盖 viewing 不匹配分支）
    expect(useStorySimulationStore.getState().viewingInterview).toBeNull()
    expect(useStorySimulationStore.getState().infoMessage).toBe(T.interviewDeleted)
  })

  it("无 projectPath 时导出直接返回", () => {
    useWikiStore.setState({ project: null } as never)
    useStorySimulationStore.setState({
      showInterviewHistory: true,
      savedInterviews: [],
      viewingInterview: makeInterview(),
    } as never)
    vi.mocked(loadInterviews).mockResolvedValue([])
    render(<InterviewHistoryView />)
    fireEvent.click(screen.getByText(T.export))
    expect(vi.mocked(exportInterview)).not.toHaveBeenCalled()
  })

  it("列表行导出图标按钮调用导出（stopPropagation 路径）", async () => {
    const iv = makeInterview()
    const other = makeInterview({ id: "iv-2", agentName: "军师" })
    vi.mocked(loadInterviews).mockResolvedValue([iv, other])
    vi.mocked(exportInterview).mockResolvedValue("/x.md")
    showWith([iv, other])
    render(<InterviewHistoryView />)
    const exports = await screen.findAllByTitle(T.export)
    expect(exports).toHaveLength(2)
    fireEvent.click(exports[1])
    await waitFor(() => {
      expect(vi.mocked(exportInterview)).toHaveBeenCalledWith("C:/proj", other)
    })
    // 点击图标不进入详情
    expect(useStorySimulationStore.getState().viewingInterview).toBeNull()
  })

  it("非 Escape 按键不关闭", async () => {
    vi.mocked(loadInterviews).mockResolvedValue([])
    showWith([])
    render(<InterviewHistoryView />)
    await screen.findByRole("dialog")
    fireEvent.keyDown(window, { key: "Enter" })
    expect(useStorySimulationStore.getState().showInterviewHistory).toBe(true)
  })
})

describe("InterviewHistoryView 定时器清理", () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it("删除成功/失败的提示定时清理", async () => {
    const iv = makeInterview()
    vi.mocked(loadInterviews).mockResolvedValue([iv])
    vi.mocked(deleteInterview).mockResolvedValueOnce(undefined)
    showWith([iv], { viewingInterview: iv })
    render(<InterviewHistoryView />)
    // 假时钟下不用 findBy/waitFor：先放行 effect 微任务，再同步查询
    await vi.advanceTimersByTimeAsync(0)
    fireEvent.click(screen.getByText(T.delete))
    await vi.advanceTimersByTimeAsync(0)
    expect(vi.mocked(deleteInterview)).toHaveBeenCalled()
    expect(useStorySimulationStore.getState().infoMessage).toBe(T.interviewDeleted)
    await vi.advanceTimersByTimeAsync(6000)
    expect(useStorySimulationStore.getState().infoMessage).toBeNull()
    expect(useStorySimulationStore.getState().savedInterviews).toHaveLength(0)
    // 失败分支的 error 定时清理
    cleanup()
    vi.mocked(deleteInterview).mockRejectedValueOnce(new Error("rm"))
    showWith([iv], { viewingInterview: iv })
    render(<InterviewHistoryView />)
    await vi.advanceTimersByTimeAsync(0)
    fireEvent.click(screen.getByText(T.delete))
    await vi.advanceTimersByTimeAsync(0)
    expect(useStorySimulationStore.getState().error).toContain("操作失败")
    await vi.advanceTimersByTimeAsync(6000)
    expect(useStorySimulationStore.getState().error).toBeNull()
  })

  it("导出成功/失败的提示定时清理", async () => {
    vi.mocked(loadInterviews).mockResolvedValue([])
    vi.mocked(exportInterview).mockResolvedValueOnce("/e.md")
    showWith([], { viewingInterview: makeInterview() })
    render(<InterviewHistoryView />)
    await vi.advanceTimersByTimeAsync(0)
    fireEvent.click(screen.getByText(T.export))
    await vi.advanceTimersByTimeAsync(0)
    expect(useStorySimulationStore.getState().infoMessage).toBe(
      T.interviewExported.replace("{{path}}", "/e.md"),
    )
    await vi.advanceTimersByTimeAsync(6000)
    expect(useStorySimulationStore.getState().infoMessage).toBeNull()
    // 失败分支
    cleanup()
    vi.mocked(exportInterview).mockRejectedValueOnce(new Error("x"))
    showWith([], { viewingInterview: makeInterview() })
    render(<InterviewHistoryView />)
    await vi.advanceTimersByTimeAsync(0)
    fireEvent.click(screen.getByText(T.export))
    await vi.advanceTimersByTimeAsync(0)
    expect(useStorySimulationStore.getState().error).toContain("操作失败")
    await vi.advanceTimersByTimeAsync(6000)
    expect(useStorySimulationStore.getState().error).toBeNull()
  })

  it("继续采访各分支的提示定时清理", async () => {
    vi.mocked(loadInterviews).mockResolvedValue([])
    // cannotRestore
    vi.mocked(loadSimulationResults).mockResolvedValue([])
    vi.mocked(deserializeSimulationSnapshot).mockReturnValue({ agents: [], state: {} as never })
    showWith([], { viewingInterview: makeInterview({ agentSnapshot: undefined }) })
    render(<InterviewHistoryView />)
    await vi.advanceTimersByTimeAsync(0)
    fireEvent.click(screen.getByText(T.continueChat))
    await vi.advanceTimersByTimeAsync(0)
    expect(useStorySimulationStore.getState().error).toBe(T.cannotRestoreReadonly)
    await vi.advanceTimersByTimeAsync(4000)
    expect(useStorySimulationStore.getState().error).toBeNull()
    cleanup()
    // agentNotFound
    vi.mocked(deserializeSimulationSnapshot).mockReturnValue({
      agents: [makeAgent("路人")],
      state: {} as never,
    })
    showWith([], { viewingInterview: makeInterview({ agentSnapshot: { agents: [], state: {} } as never }) })
    render(<InterviewHistoryView />)
    await vi.advanceTimersByTimeAsync(0)
    fireEvent.click(screen.getByText(T.continueChat))
    await vi.advanceTimersByTimeAsync(0)
    expect(useStorySimulationStore.getState().error).toBe(
      T.agentDataNotFound.replace("{{name}}", "寨主"),
    )
    await vi.advanceTimersByTimeAsync(4000)
    expect(useStorySimulationStore.getState().error).toBeNull()
    cleanup()
    // 成功恢复
    vi.mocked(deserializeSimulationSnapshot).mockReturnValue({
      agents: [makeAgent("寨主")],
      state: {} as never,
    })
    showWith([], { viewingInterview: makeInterview({ agentSnapshot: { agents: [], state: {} } as never }) })
    render(<InterviewHistoryView />)
    await vi.advanceTimersByTimeAsync(0)
    fireEvent.click(screen.getByText(T.continueChat))
    await vi.advanceTimersByTimeAsync(0)
    expect(useStorySimulationStore.getState().infoMessage).toBe(T.interviewResumed)
    await vi.advanceTimersByTimeAsync(3000)
    expect(useStorySimulationStore.getState().infoMessage).toBeNull()
    cleanup()
    // 抛错分支
    vi.mocked(deserializeSimulationSnapshot).mockImplementationOnce(() => {
      throw new Error("bad")
    })
    showWith([], { viewingInterview: makeInterview({ agentSnapshot: { agents: [], state: {} } as never }) })
    render(<InterviewHistoryView />)
    await vi.advanceTimersByTimeAsync(0)
    fireEvent.click(screen.getByText(T.continueChat))
    await vi.advanceTimersByTimeAsync(0)
    expect(useStorySimulationStore.getState().error).toContain("操作失败")
    await vi.advanceTimersByTimeAsync(4000)
    expect(useStorySimulationStore.getState().error).toBeNull()
  })
})
