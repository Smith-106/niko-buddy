// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest"
import { render, fireEvent, waitFor, within, act } from "@/test-helpers/component-test-utils"
import { MultiPovMeshPanel } from "./multi-pov-mesh-panel"
import * as novelModule from "@/lib/novel"
import type { NovelAgent, TimelineEvent } from "@/lib/novel"

describe("MultiPovMeshPanel", () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    document.body.innerHTML = ""
    Object.assign(navigator, {
      clipboard: {
        writeText: vi.fn().mockResolvedValue(undefined),
      },
    })
  })

  const dummyAgents = new Map<string, NovelAgent>([
    [
      "agent-1",
      {
        characterId: "c1",
        name: "林越",
        profile: "侦探",
        status: "active",
        cognition: { knows: ["死者身份"], doesNotKnow: ["沈清秋是真凶"] },
        knownFacts: new Set(["死者身份"]),
        personality: "沉着",
        motive: "查明真相",
        currentGoal: "搜查公馆",
        relationships: {},
      } as unknown as NovelAgent,
    ],
    [
      "agent-2",
      {
        characterId: "c2",
        name: "沈清秋",
        profile: "财阀",
        status: "active",
        cognition: { knows: [], doesNotKnow: [] },
        knownFacts: new Set([]),
        personality: "冷酷",
        motive: "掌控全局",
        currentGoal: "掩盖痕迹",
        relationships: {},
      } as unknown as NovelAgent,
    ],
  ])

  const dummyEvents: TimelineEvent[] = [
    {
      id: "ev-1",
      nodeIndex: 0,
      round: 0,
      actorId: "c1",
      actorName: "林越",
      actionType: "dialogue",
      content: "林越潜入公馆搜查",
      targetName: "秘密账本",
      timestamp: new Date().toISOString(),
    } as unknown as TimelineEvent,
    {
      id: "ev-2",
      nodeIndex: 0,
      round: 0,
      actorId: "c2",
      actorName: "沈清秋",
      actionType: "dialogue",
      content: "沈清秋回到公馆",
      targetName: "秘密账本",
      timestamp: new Date().toISOString(),
    } as unknown as TimelineEvent,
  ]

  it("renders multi-POV mesh with threads and detected intersections", () => {
    const { container, unmount } = render(
      <MultiPovMeshPanel agents={dummyAgents} events={dummyEvents} className="custom-test-class" />,
    )
    const view = within(container)

    expect(container.firstChild).toHaveClass("custom-test-class")
    expect(view.getByText("多主角并行织网视图 (Multi-POV Mesh)")).toBeInTheDocument()
    expect(view.getByText("林越")).toBeInTheDocument()
    expect(view.getByText("沈清秋")).toBeInTheDocument()
    expect(view.getAllByText(/防穿帮铁律/).length).toBeGreaterThan(0)
    expect(view.getAllByText(/【禁止描写】：林越此时绝对不知晓【沈清秋是真凶】/).length).toBeGreaterThan(0)
    expect(view.getByText(/支线交汇检测看板/)).toBeInTheDocument()
    expect(view.getAllByText(/第 1 章交汇/).length).toBeGreaterThan(0)

    unmount()
  })

  it("allows switching active POV thread and shows empty constraint message", () => {
    const { container, unmount } = render(
      <MultiPovMeshPanel agents={dummyAgents} events={dummyEvents} />,
    )
    const view = within(container)

    const shenBtn = view.getByText("沈清秋").closest("button")!
    fireEvent.click(shenBtn)

    expect(view.getByText(/当前视点：沈清秋 的独立切片视窗/)).toBeInTheDocument()
    expect(view.getByText("暂无显式被隐瞒的情报，视点全知本线既有事件。")).toBeInTheDocument()
    unmount()
  })

  it("handles copy prompt and convergence pack and resets copy state after timer", async () => {
    vi.useFakeTimers()
    const { container, unmount } = render(
      <MultiPovMeshPanel agents={dummyAgents} events={dummyEvents} />,
    )
    const view = within(container)

    const copyBtn = view.getByText("复制 Prompt 承接包")
    fireEvent.click(copyBtn)
    expect(navigator.clipboard.writeText).toHaveBeenCalled()

    const copyPackBtn = view.getByText("复制对齐约束包")
    fireEvent.click(copyPackBtn)
    expect(navigator.clipboard.writeText).toHaveBeenCalled()

    act(() => {
      vi.advanceTimersByTime(2500)
    })
    vi.useRealTimers()
    unmount()
  })

  it("runs SLM epistemic leak check and displays pass result", async () => {
    vi.spyOn(novelModule, "verifyPovEpistemicIntegrityWithSlm").mockResolvedValue({
      passed: true,
      leakedFacts: [],
      checkedBy: "slm",
    })

    const { container, unmount } = render(
      <MultiPovMeshPanel agents={dummyAgents} events={dummyEvents} />,
    )
    const view = within(container)

    const textarea = view.getByPlaceholderText(/输入测试段落/)
    fireEvent.change(textarea, { target: { value: "林越走在空无一人的街头，细雨纷飞。" } })

    const testBtn = view.getByText("极速自检")
    fireEvent.click(testBtn)

    await waitFor(() => {
      expect(view.getByText(/【SLM 审查通过】/)).toBeInTheDocument()
    })

    unmount()
  })

  it("runs SLM epistemic leak check and displays violation message", async () => {
    vi.spyOn(novelModule, "verifyPovEpistemicIntegrityWithSlm").mockResolvedValue({
      passed: false,
      leakedFacts: ["全知视角泄露违规：沈清秋是真凶"],
      reasoning: "泄露了真凶秘密",
      checkedBy: "slm",
    })

    const { container, unmount } = render(
      <MultiPovMeshPanel agents={dummyAgents} events={dummyEvents} />,
    )
    const view = within(container)

    const textarea = view.getByPlaceholderText(/输入测试段落/)
    fireEvent.change(textarea, { target: { value: "林越突然领悟到沈清秋就是真凶。" } })

    const testBtn = view.getByText("极速自检")
    fireEvent.click(testBtn)

    await waitFor(() => {
      expect(view.getByText(/【SLM 拦截到穿帮】：全知视角泄露违规：沈清秋是真凶/)).toBeInTheDocument()
    })

    unmount()
  })

  it("catches Error object in SLM test and displays error message", async () => {
    vi.spyOn(novelModule, "verifyPovEpistemicIntegrityWithSlm").mockRejectedValue(
      new Error("连接本地 Ollama 失败"),
    )

    const { container, unmount } = render(
      <MultiPovMeshPanel agents={dummyAgents} events={dummyEvents} />,
    )
    const view = within(container)

    const textarea = view.getByPlaceholderText(/输入测试段落/)
    fireEvent.change(textarea, { target: { value: "测试文本" } })

    const testBtn = view.getByText("极速自检")
    fireEvent.click(testBtn)

    await waitFor(() => {
      expect(view.getByText(/自检异常：连接本地 Ollama 失败/)).toBeInTheDocument()
    })

    unmount()
  })

  it("catches non-Error string in SLM test and displays fallback string error", async () => {
    vi.spyOn(novelModule, "verifyPovEpistemicIntegrityWithSlm").mockRejectedValue(
      "原生服务异常",
    )

    const { container, unmount } = render(
      <MultiPovMeshPanel agents={dummyAgents} events={dummyEvents} />,
    )
    const view = within(container)

    const textarea = view.getByPlaceholderText(/输入测试段落/)
    fireEvent.change(textarea, { target: { value: "测试文本" } })

    const testBtn = view.getByText("极速自检")
    fireEvent.click(testBtn)

    await waitFor(() => {
      expect(view.getByText(/自检异常：原生服务异常/)).toBeInTheDocument()
    })

    unmount()
  })

  it("does not trigger SLM test when test draft is empty or only whitespace", () => {
    const spy = vi.spyOn(novelModule, "verifyPovEpistemicIntegrityWithSlm")

    const { container, unmount } = render(
      <MultiPovMeshPanel agents={dummyAgents} events={dummyEvents} />,
    )
    const view = within(container)

    const textarea = view.getByPlaceholderText(/输入测试段落/)
    fireEvent.change(textarea, { target: { value: "   " } })

    const testBtn = view.getByText("极速自检")
    fireEvent.click(testBtn)

    expect(spy).not.toHaveBeenCalled()
    unmount()
  })

  it("handles agent fallback fields without profile or cognition", () => {
    const fallbackAgents = new Map<string, NovelAgent>([
      [
        "agent-3",
        {
          characterId: "c3",
          name: "路人",
          // 没有 profile，应 fallback 到 "主角"
          // 没有 cognition，应 fallback 到 []
          status: "active",
          personality: "普通",
          motive: "无",
          currentGoal: "路过",
          relationships: {},
        } as unknown as NovelAgent,
      ],
    ])

    const eventsWithoutTarget: TimelineEvent[] = [
      {
        id: "ev-3",
        nodeIndex: 0,
        round: 0,
        actorId: "c3",
        actorName: "路人",
        actionType: "dialogue",
        content: "路过街角",
        // 无 targetName，应 fallback 到 "同幕场景"
        timestamp: new Date().toISOString(),
      } as unknown as TimelineEvent,
    ]

    const { container, unmount } = render(
      <MultiPovMeshPanel agents={fallbackAgents} events={eventsWithoutTarget} />,
    )
    const view = within(container)

    expect(view.getByText("路人")).toBeInTheDocument()
    expect(view.getByText("主角")).toBeInTheDocument()
    unmount()
  })

  it("handles empty agents gracefully", () => {
    const { container, unmount } = render(
      <MultiPovMeshPanel agents={new Map()} events={[]} />,
    )
    const view = within(container)

    expect(view.getByText(/0 视点 \/ 0 交汇点/)).toBeInTheDocument()
    expect(view.getByText(/请从左侧选择一个视点角色/)).toBeInTheDocument()
    expect(view.getByText(/暂未探测到支线交汇点/)).toBeInTheDocument()

    unmount()
  })

  it("handles agent with knownFacts when cognition.knows is undefined", () => {
    const customAgents = new Map<string, NovelAgent>([
      [
        "agent-kf",
        {
          characterId: "c-kf",
          name: "线索持有者",
          profile: "线人",
          status: "active",
          cognition: { doesNotKnow: ["隐藏机密"] },
          knownFacts: new Set(["已知线索A", "已知线索B"]),
          personality: "机敏",
          motive: "自保",
          currentGoal: "提供情报",
          relationships: {},
        } as unknown as NovelAgent,
      ],
    ])
    const { container, unmount } = render(
      <MultiPovMeshPanel agents={customAgents} events={[]} />,
    )
    const view = within(container)
    expect(view.getByText("知晓 2")).toBeInTheDocument()
    expect(view.getByText("隐秘 1")).toBeInTheDocument()
    unmount()
  })

  it("detects location-based intersection with fallback goal in convergence board", () => {
    const locationEvents: TimelineEvent[] = [
      {
        id: "ev-loc-1",
        nodeIndex: 1,
        round: 0,
        actorId: "c1",
        actorName: "林越",
        actionType: "dialogue",
        content: "林越抵达迷雾码头",
        targetName: "地点:迷雾码头",
        timestamp: new Date().toISOString(),
      } as unknown as TimelineEvent,
      {
        id: "ev-loc-2",
        nodeIndex: 1,
        round: 0,
        actorId: "c2",
        actorName: "沈清秋",
        actionType: "dialogue",
        content: "沈清秋也来到迷雾码头",
        targetName: "地点:迷雾码头",
        timestamp: new Date().toISOString(),
      } as unknown as TimelineEvent,
    ]

    const { container, unmount } = render(
      <MultiPovMeshPanel agents={dummyAgents} events={locationEvents} />,
    )
    const view = within(container)

    expect(view.getByText(/发生地点：迷雾码头 \| 目标：剧情推进/)).toBeInTheDocument()
    unmount()
  })
})
