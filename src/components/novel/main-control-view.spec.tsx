/**
 * main-control-view.spec — 主控 Agent 面板（jsdom）。
 * 覆盖：空目标不触发运行 / 运行后轨迹与草稿渲染 / 错误提示 / 跳热力图入口 /
 * Draft-first 提示可见。
 */
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"

const runMainControlAgent = vi.fn()
const resolveWikiPath = vi.fn(async () => "/proj/wiki")
// R03=a：深章入口的两步路径（resolveDeepChapterRunner → runDeepChapterGeneration）全程 mock，
// 不碰真实 LLM / 文件系统。默认：resolve 返回同一个 runner（与生产的两步形态一致）。
const runDeepChapterGeneration = vi.fn()
const resolveDeepChapterRunner = vi.fn(async () => runDeepChapterGeneration)
const setActiveView = vi.fn()
const listChapterDrafts = vi.fn(async (): Promise<unknown[]> => [])
const adoptMainControlDraft = vi.fn()
const rerunMainControlGates = vi.fn()

vi.mock("@/commands/fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/commands/fs")>()
  return { ...actual, fileExists: vi.fn(async () => true) }
})

const saveTraceSnapshot = vi.fn(async (_projectPath: string, _snapshot: unknown) => true)
// TASK-014：回放读回端（磁盘快照 → 面板）。默认「没有快照」，与旧行为（真实实现读不到文件返回 null）一致。
const loadTraceSnapshot = vi.fn(async (_projectPath: string): Promise<unknown | null> => null)

vi.mock("@/lib/novel", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/novel")>()
  return {
    ...actual,
    runMainControlAgent,
    resolveWikiPath,
    resolveDeepChapterRunner,
    listChapterDrafts,
    adoptMainControlDraft,
    rerunMainControlGates,
    saveTraceSnapshot,
    loadTraceSnapshot,
  }
})

// 真实设置块由 main-control-settings-block.spec.tsx 覆盖（避免 ChatModelSelector 读 providerConfigs 在 jsdom 抛错）。
vi.mock("./main-control-settings-block", () => ({
  MainControlSettingsBlock: () => <div data-testid="main-control-settings" />,
}))

const wikiState = vi.hoisted(() => ({
  project: { id: "p1", path: "/proj" } as { id: string; path: string } | null,
  llmConfig: { provider: "openai", model: "gpt-test", apiKey: "k", baseUrl: "" },
  aiWorkflowMode: "standard",
  novelConfig: {
    stageJournalEnabled: true as boolean | undefined,
    journalTtlMs: 3_600_000,
    chapterTargetChars: 3000,
    preWriteGateMode: "warn" as "warn" | "block" | undefined,
    reviewModel: "",
    sceneBreakdownEnabled: false,
    literaryPolishAfterGate: false,
    autoIngestOnSave: false,
  },
  dataVersion: 1,
  setSelectedFile: vi.fn(),
}))

vi.mock("@/stores/wiki-store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/stores/wiki-store")>()
  const state = {
    get project() {
      return wikiState.project
    },
    llmConfig: wikiState.llmConfig,
    get aiWorkflowMode() {
      return wikiState.aiWorkflowMode
    },
    get novelConfig() {
      return wikiState.novelConfig
    },
    get novelMode() {
      return true
    },
    get dataVersion() {
      return wikiState.dataVersion
    },
    setSelectedFile: wikiState.setSelectedFile,
    setActiveView,
  }
  const useWikiStore = <T,>(selector: (s: typeof state) => T) => selector(state)
  return { ...actual, useWikiStore }
})

const { MainControlView } = await import("./main-control-view")

afterEach(() => {
  cleanup()
  runMainControlAgent.mockReset()
  resolveDeepChapterRunner.mockReset()
  resolveDeepChapterRunner.mockResolvedValue(runDeepChapterGeneration)
  runDeepChapterGeneration.mockReset()
  setActiveView.mockReset()
  listChapterDrafts.mockReset()
  listChapterDrafts.mockResolvedValue([])
  adoptMainControlDraft.mockReset()
  rerunMainControlGates.mockReset()
  saveTraceSnapshot.mockReset()
  saveTraceSnapshot.mockResolvedValue(true)
  loadTraceSnapshot.mockReset()
  loadTraceSnapshot.mockResolvedValue(null)
})

describe("MainControlView 管线动态挂载", () => {
  it("跑流程 Tab 内含可折叠管线动态区块（默认展开实况拓扑）", () => {
    render(<MainControlView />)
    expect(screen.getByTestId("main-control-tab-run").getAttribute("aria-selected")).toBe("true")
    const block = screen.getByTestId("main-control-motion")
    expect(block).toBeTruthy()
    const toggle = screen.getByTestId("main-control-motion-toggle")
    expect(toggle.getAttribute("aria-expanded")).toBe("true")
    // 默认展开：直接装载实况视图；收起后卸载。
    expect(screen.getByTestId("pipeline-motion-view")).toBeTruthy()
    fireEvent.click(toggle)
    expect(toggle.getAttribute("aria-expanded")).toBe("false")
    expect(screen.queryByTestId("pipeline-motion-view")).toBeNull()
  })
})

describe("MainControlView", () => {
  it("跑流程 Tab 挂载运行设置块，且 aiWorkflowMode 取自 store（R-02）", async () => {
    runMainControlAgent.mockResolvedValue({
      ok: true,
      finalText: "完成",
      roundsUsed: 1,
      steps: [],
      drafts: [],
    })
    render(<MainControlView />)
    expect(screen.getByTestId("main-control-settings")).toBeTruthy()
    fireEvent.change(screen.getByTestId("main-control-goal"), { target: { value: "任意目标" } })
    fireEvent.click(screen.getByTestId("main-control-run"))
    await waitFor(() => expect(runMainControlAgent).toHaveBeenCalled())
    expect(runMainControlAgent).toHaveBeenCalledWith(
      expect.objectContaining({ aiWorkflowMode: "standard" }),
    )
  })

  it("运行时装配 stageJournal 并透传（G3）", async () => {
    runMainControlAgent.mockResolvedValue({
      ok: true,
      finalText: "完成",
      roundsUsed: 1,
      steps: [],
      drafts: [],
    })
    render(<MainControlView />)
    fireEvent.change(screen.getByTestId("main-control-goal"), { target: { value: "任意目标" } })
    fireEvent.click(screen.getByTestId("main-control-run"))
    await waitFor(() =>
      expect(runMainControlAgent).toHaveBeenCalledWith(
        expect.objectContaining({ stageJournal: expect.anything() }),
      ),
    )
  })

  it("阶段日志关闭时显示诚实说明而非空面板（G3）", () => {
    wikiState.novelConfig = { ...wikiState.novelConfig, stageJournalEnabled: false }
    try {
      render(<MainControlView />)
      expect(screen.getByTestId("main-control-stage-journal-off")).toBeTruthy()
    } finally {
      wikiState.novelConfig = { ...wikiState.novelConfig, stageJournalEnabled: true }
    }
  })

  it("渲染目标输入与空态轨迹（默认跑流程 Tab）", () => {
    render(<MainControlView />)
    expect(screen.getByTestId("main-control-view")).toBeTruthy()
    expect(screen.getByTestId("main-control-tabs")).toBeTruthy()
    expect(screen.getByTestId("main-control-tab-run").getAttribute("aria-selected")).toBe("true")
    expect(screen.getByTestId("main-control-goal")).toBeTruthy()
    expect(screen.getByTestId("main-control-steps").textContent).toContain("还没有工具调用")
    // 草稿在收草稿 Tab，不在默认 Tab 堆叠
    expect(screen.queryByTestId("main-control-drafts")).toBeNull()
    fireEvent.click(screen.getByTestId("main-control-tab-drafts"))
    expect(screen.getByTestId("main-control-drafts").textContent).toContain("Draft-first")
    expect(screen.queryByTestId("main-control-steps")).toBeNull()
  })

  it("空目标点击运行不会调用 Agent", () => {
    render(<MainControlView />)
    fireEvent.click(screen.getByTestId("main-control-run"))
    expect(runMainControlAgent).not.toHaveBeenCalled()
  })

  it("运行后渲染轨迹、草稿与终稿", async () => {
    runMainControlAgent.mockResolvedValue({
      ok: true,
      finalText: "已读完上下文并产出草稿。",
      roundsUsed: 3,
      steps: [
        { callId: "c1", name: "read_chapter", params: { name: "第12章" }, status: "done", result: "正文", at: 1 },
      ],
      drafts: [{ id: "draft_1_abc", chapterName: "第12章 旧梦", words: 1800 }],
    })
    render(<MainControlView />)
    fireEvent.change(screen.getByTestId("main-control-goal"), { target: { value: "给第12章写开头" } })
    fireEvent.click(screen.getByTestId("main-control-run"))
    await waitFor(() => expect(screen.getByTestId("main-control-step-read_chapter")).toBeTruthy())
    expect(screen.getByTestId("main-control-final").textContent).toContain("已读完上下文并产出草稿")
    // 草稿在收草稿 Tab
    fireEvent.click(screen.getByTestId("main-control-tab-drafts"))
    expect(screen.getByTestId("main-control-drafts").textContent).toContain("第12章 旧梦")
    expect(screen.getByTestId("main-control-drafts").textContent).toContain("1800")
    expect(runMainControlAgent).toHaveBeenCalledWith(
      expect.objectContaining({ projectPath: "/proj", wikiPath: "/proj/wiki", goal: "给第12章写开头" }),
    )
  })

  it("跑流程 Tab 渲染阶段观测块：有 activities 时按类别展示", async () => {
    runMainControlAgent.mockResolvedValue({
      ok: true,
      finalText: "完成",
      roundsUsed: 1,
      steps: [],
      drafts: [],
      activities: [
        { id: "a1", stageId: "s1", kind: "stage_output", title: "阶段产出", content: "正文片段", timestamp: 1 },
      ],
    })
    render(<MainControlView />)
    fireEvent.change(screen.getByTestId("main-control-goal"), { target: { value: "任意目标" } })
    fireEvent.click(screen.getByTestId("main-control-run"))
    await waitFor(() => expect(screen.getByTestId("main-control-activity-stage_output")).toBeTruthy())
    const block = screen.getByTestId("main-control-activities")
    expect(block.textContent).toContain("阶段观测")
    expect(block.textContent).toContain("正文片段")
  })

  it("跑流程 Tab 无 activities 时显示「没有阶段事件」而不伪造", () => {
    render(<MainControlView />)
    const block = screen.getByTestId("main-control-activities")
    expect(block.textContent).toContain("本次运行没有阶段事件")
  })

  it("Agent 返回错误时显示错误提示", async () => {
    runMainControlAgent.mockResolvedValue({
      ok: false,
      finalText: "",
      roundsUsed: 0,
      steps: [],
      drafts: [],
      error: "模型不支持工具调用",
    })
    render(<MainControlView />)
    fireEvent.change(screen.getByTestId("main-control-goal"), { target: { value: "任意目标" } })
    fireEvent.click(screen.getByTestId("main-control-run"))
    await waitFor(() => expect(screen.getByTestId("main-control-error")).toBeTruthy())
    expect(screen.getByTestId("main-control-error").textContent).toContain("模型不支持工具调用")
  })

  it("可以跳转到热力图", () => {
    render(<MainControlView />)
    fireEvent.click(screen.getByTestId("main-control-heatmap"))
    expect(setActiveView).toHaveBeenCalledWith("moduleHeatmap")
  })

  it("亲手中止后显示已取消态而不是红字失败（生产契约：resolve + error）", async () => {
    // 生产路径不抛：runner abort 时 onError("操作已取消") 后 resolve，error 经返回值回来。
    runMainControlAgent.mockImplementation(
      ({ signal }: { signal?: AbortSignal }) =>
        new Promise((resolve) => {
          signal?.addEventListener("abort", () =>
            resolve({
              ok: false,
              finalText: "",
              roundsUsed: 0,
              steps: [],
              drafts: [],
              error: "操作已取消",
            }),
          )
        }),
    )
    render(<MainControlView />)
    fireEvent.change(screen.getByTestId("main-control-goal"), { target: { value: "任意目标" } })
    fireEvent.click(screen.getByTestId("main-control-run"))
    await waitFor(() => expect(screen.getByTestId("main-control-stop")).toBeTruthy())
    fireEvent.click(screen.getByTestId("main-control-stop"))
    await waitFor(() => expect(screen.getByTestId("main-control-cancelled")).toBeTruthy())
    expect(screen.queryByTestId("main-control-error")).toBeNull()
  })

  it("某一步 90 秒无返回提示可能卡住", async () => {
    runMainControlAgent.mockImplementation(
      ({ onStep }: { onStep: (s: unknown) => void }) => {
        onStep({
          callId: "c1",
          name: "slow_tool",
          params: {},
          status: "running",
          at: Date.now() - 200_000,
        })
        return new Promise(() => {})
      },
    )
    render(<MainControlView />)
    fireEvent.change(screen.getByTestId("main-control-goal"), { target: { value: "任意目标" } })
    fireEvent.click(screen.getByTestId("main-control-run"))
    await waitFor(() => expect(screen.getByTestId("main-control-stuck")).toBeTruthy())
    expect(screen.getByTestId("main-control-stuck").textContent).toContain("slow_tool")
  })
})

describe("MainControlView 运行轨迹与证据", () => {
  it("每步显示输入摘要，展开后可见原始证据", async () => {
    runMainControlAgent.mockResolvedValue({
      ok: true,
      finalText: "完成",
      roundsUsed: 2,
      steps: [
        {
          callId: "c1",
          name: "read_chapter",
          params: { name: "第12章" },
          status: "done",
          result: "第12章正文全文……",
          at: 1000,
          finishedAt: 1420,
        },
      ],
      drafts: [],
    })
    render(<MainControlView />)
    fireEvent.change(screen.getByTestId("main-control-goal"), { target: { value: "读第12章" } })
    fireEvent.click(screen.getByTestId("main-control-run"))
    await waitFor(() => expect(screen.getByTestId("main-control-trace-entry-read_chapter")).toBeTruthy())
    expect(screen.getByTestId("main-control-trace-input-read_chapter").textContent).toContain("第12章")
    expect(screen.getByTestId("main-control-trace").textContent).toContain("420")
    expect(screen.queryByTestId("main-control-trace-raw-read_chapter")).toBeNull()
    fireEvent.click(screen.getByTestId("main-control-trace-toggle-read_chapter"))
    expect(screen.getByTestId("main-control-trace-raw-read_chapter").textContent).toContain("第12章正文全文")
  })

  it("失败步骤显示失败原因", async () => {
    runMainControlAgent.mockResolvedValue({
      ok: false,
      finalText: "",
      roundsUsed: 1,
      steps: [
        { callId: "c9", name: "write_chapter", params: {}, status: "error", error: "磁盘只读", at: 5 },
      ],
      drafts: [],
      error: "磁盘只读",
    })
    render(<MainControlView />)
    fireEvent.change(screen.getByTestId("main-control-goal"), { target: { value: "写第2章" } })
    fireEvent.click(screen.getByTestId("main-control-run"))
    await waitFor(() => expect(screen.getByTestId("main-control-trace-entry-write_chapter")).toBeTruthy())
    expect(screen.getByTestId("main-control-trace-entry-write_chapter").textContent).toContain("磁盘只读")
  })
})

vi.mock("./live-execution-view", () => ({
  LiveExecutionView: ({ projectPath }: { projectPath: string }) => <div data-testid="live-execution-stub">{projectPath}</div>,
}))

describe("批次三·12：AI 实况并入主控", () => {
  it("第四个页签「AI 实况」挂载实况视图，传项目磁盘路径", () => {
    render(<MainControlView />)
    expect(screen.queryByTestId("main-control-live")).toBeNull()
    fireEvent.click(screen.getByTestId("main-control-tab-live"))
    expect(screen.getByTestId("main-control-tab-live").getAttribute("aria-selected")).toBe("true")
    expect(screen.getByTestId("live-execution-stub").textContent).toBeTruthy()
    expect(screen.queryByTestId("main-control-goal")).toBeNull()
  })
})

describe("主控面板挂载：章节目录 + 伏笔看板（grok 计划审查要求：新断言，不复用旧 spec）", () => {
  it("两个区块都挂载在 main-control-view 内，且无项目时不静默消失", async () => {
    render(<MainControlView />)
    expect(screen.getByTestId("main-control-view")).toBeTruthy()
    // 本章上下文 Tab：目录 + 伏笔并列收纳，不再与跑流程堆叠
    fireEvent.click(screen.getByTestId("main-control-tab-context"))
    expect(screen.getByTestId("main-control-chapter-directory")).toBeTruthy()
    expect(screen.getByTestId("main-control-foreshadowing")).toBeTruthy()
    // 有项目：走有项目分支
    expect(screen.getByTestId("chapter-directory")).toBeTruthy()
    expect(screen.getByTestId("foreshadowing-panel")).toBeTruthy()
    expect(screen.queryByTestId("chapter-directory-no-project")).toBeNull()
    expect(screen.queryByTestId("foreshadowing-panel-no-project")).toBeNull()
  })
})

describe("无项目不得静默消失（可失败断言：把无项目分支改回 return null 必红）", () => {
  it("project=null 时两个面板都渲染显式空态", async () => {
    wikiState.project = null
    render(<MainControlView />)
    fireEvent.click(screen.getByTestId("main-control-tab-context"))
    await waitFor(() => expect(screen.getByTestId("chapter-directory-no-project")).toBeTruthy())
    expect(screen.getByTestId("foreshadowing-panel-no-project")).toBeTruthy()
    // 章节目录根节点仍在，但不得出现「有项目」才有的汇总/表格
    expect(screen.queryByTestId("chapter-directory-total")).toBeNull()
    // 伏笔面板必须换到无项目分支：有项目分支的根节点不得存在（改回 return null → 本断言变红）
    expect(screen.queryByTestId("foreshadowing-panel")).toBeNull()
    wikiState.project = { id: "p1", path: "/proj" }
  })
})

describe("主控页内分层与运行反馈", () => {
  it("三 Tab 互斥：同一时间只渲染当前 Tab 区块", () => {
    render(<MainControlView />)
    // 默认跑流程 Tab：目标 + 步骤可见，草稿与上下文不堆叠
    expect(screen.getByTestId("main-control-steps")).toBeTruthy()
    expect(screen.queryByTestId("main-control-drafts")).toBeNull()
    expect(screen.queryByTestId("main-control-chapter-directory")).toBeNull()
    fireEvent.click(screen.getByTestId("main-control-tab-context"))
    expect(screen.getByTestId("main-control-chapter-directory")).toBeTruthy()
    expect(screen.getByTestId("main-control-work-heatmap")).toBeTruthy()
    expect(screen.queryByTestId("main-control-steps")).toBeNull()
    expect(screen.queryByTestId("main-control-drafts")).toBeNull()
  })

  it("运行时显示已运行秒数与当前步骤（诚实反馈，无假进度）", async () => {
    runMainControlAgent.mockImplementation(
      ({ onStep }: { onStep: (s: unknown) => void }) => {
        onStep({ callId: "c1", name: "read_chapter", params: {}, status: "running", at: Date.now() })
        return new Promise(() => {})
      },
    )
    render(<MainControlView />)
    fireEvent.change(screen.getByTestId("main-control-goal"), { target: { value: "任意目标" } })
    fireEvent.click(screen.getByTestId("main-control-run"))
    await waitFor(() => expect(screen.getByTestId("main-control-elapsed")).toBeTruthy())
    expect(screen.getByTestId("main-control-elapsed").textContent).toContain("已运行")
    expect(screen.getByTestId("main-control-elapsed").textContent).toContain("read_chapter")
    expect(screen.getByTestId("main-control-elapsed").textContent).toContain("0/1")
  })
})

/**
 * F1a：主控 drafts 页签真的能采纳（不再只是提示文案）。
 *
 * 关键断言（对应 post-execute 门判 fix 项）：第一步「采纳」只展开确认面板、
 * 不调用采纳通道（未确认 ⇒ 不写正式正文）；第二步「确认采纳」才带 confirmed:true
 * 调 adoptMainControlDraft（accept seam = acceptChapterDraft）。
 */
describe("F1a 主控 drafts 页签采纳（两步确认）", () => {
  const draftRow = { id: "draft_1_abc", chapterName: "第3章 旧梦", content: "正文", createdAt: 1, status: "draft" }

  it("第一步不写盘，第二步才调采纳通道（confirmed:true）并显示回填结论", async () => {
    listChapterDrafts.mockResolvedValue([draftRow])
    adoptMainControlDraft.mockResolvedValue({
      formalChapterPath: "/proj/wiki/chapters/第3章 旧梦.md",
      ingest: "skipped-config",
    })
    render(<MainControlView />)
    fireEvent.click(screen.getByTestId("main-control-tab-drafts"))
    await waitFor(() => expect(screen.getByTestId("main-control-draft-adopt-draft_1_abc")).toBeTruthy())

    fireEvent.click(screen.getByTestId("main-control-draft-adopt-draft_1_abc"))
    await waitFor(() => expect(screen.getByTestId("main-control-draft-adopt-confirm")).toBeTruthy())
    // 第一步确认：只展开面板，采纳通道零调用（未确认不写正式正文）。
    expect(adoptMainControlDraft).not.toHaveBeenCalled()
    expect(screen.getByTestId("main-control-draft-adopt-confirm").textContent).toContain(
      "/proj/wiki/chapters/第3章 旧梦.md",
    )

    fireEvent.click(screen.getByTestId("main-control-draft-adopt-confirm-accept"))
    await waitFor(() => expect(adoptMainControlDraft).toHaveBeenCalledTimes(1))
    expect(adoptMainControlDraft).toHaveBeenCalledWith(
      expect.objectContaining({ draftId: "draft_1_abc", chapterName: "第3章 旧梦", confirmed: true }),
    )
    await waitFor(() =>
      expect(screen.getByTestId("main-control-draft-adopt-note").textContent).toContain("已写入正式章"),
    )
  })

  it("取消确认面板后仍不写盘", async () => {
    listChapterDrafts.mockResolvedValue([draftRow])
    render(<MainControlView />)
    fireEvent.click(screen.getByTestId("main-control-tab-drafts"))
    await waitFor(() => expect(screen.getByTestId("main-control-draft-adopt-draft_1_abc")).toBeTruthy())
    fireEvent.click(screen.getByTestId("main-control-draft-adopt-draft_1_abc"))
    await waitFor(() => expect(screen.getByTestId("main-control-draft-adopt-confirm-cancel")).toBeTruthy())
    fireEvent.click(screen.getByTestId("main-control-draft-adopt-confirm-cancel"))
    expect(screen.queryByTestId("main-control-draft-adopt-confirm")).toBeNull()
    expect(adoptMainControlDraft).not.toHaveBeenCalled()
  })

  it("记忆回填结果进同一 activities 列表与快照（RV-002 ②）", async () => {
    runMainControlAgent.mockResolvedValue({
      ok: true,
      finalText: "完成",
      roundsUsed: 1,
      steps: [],
      drafts: [],
      activities: [
        { id: "a1", stageId: "run_chapter_workflow", kind: "stage_output", title: "深章阶段产出", content: "正文片段", timestamp: 1 },
      ],
    })
    listChapterDrafts.mockResolvedValue([draftRow])
    adoptMainControlDraft.mockResolvedValue({
      formalChapterPath: "/proj/wiki/chapters/第3章 旧梦.md",
      ingest: "ok",
    })
    render(<MainControlView />)

    fireEvent.change(screen.getByTestId("main-control-goal"), { target: { value: "任意目标" } })
    fireEvent.click(screen.getByTestId("main-control-run"))
    await waitFor(() => expect(screen.getByTestId("main-control-activity-stage_output")).toBeTruthy())

    fireEvent.click(screen.getByTestId("main-control-tab-drafts"))
    await waitFor(() => expect(screen.getByTestId("main-control-draft-adopt-draft_1_abc")).toBeTruthy())
    fireEvent.click(screen.getByTestId("main-control-draft-adopt-draft_1_abc"))
    await waitFor(() => expect(screen.getByTestId("main-control-draft-adopt-confirm-accept")).toBeTruthy())
    fireEvent.click(screen.getByTestId("main-control-draft-adopt-confirm-accept"))
    await waitFor(() => expect(adoptMainControlDraft).toHaveBeenCalledTimes(1))

    // 同一个观测列表：运行产出 + 采纳后回填两条源
    fireEvent.click(screen.getByTestId("main-control-tab-run"))
    await waitFor(() => expect(screen.getByTestId("main-control-activity-extract_result")).toBeTruthy())
    const block = screen.getByTestId("main-control-activities")
    expect(block.textContent).toContain("正文片段")
    expect(block.textContent).toContain("第3章 旧梦.md")
    expect(block.textContent).toContain("记忆回填")

    // 快照也要真的消费这条通道（最后一次落盘含 ingest 事件）
    await waitFor(() => expect(saveTraceSnapshot).toHaveBeenCalled())
    // 快照里的 activities 是投影（kind/title/summary/at，R-08 体积纪律）。
    const calls = saveTraceSnapshot.mock.calls
    const lastSnapshot = calls[calls.length - 1]?.[1] as { activities?: { kind: string }[] }
    expect(lastSnapshot.activities?.map((a) => a.kind)).toEqual(["stage_output", "extract_result"])
  })
})

/**
 * F1b：live 页签挂「重跑门控」，结果行由 rerunMainControlGates（→ evaluateChapterGates）产出。
 */
describe("F1b 主控 live 页签重跑门控", () => {
  it("点「重跑门控」调用 rerunMainControlGates，并渲染三门结果与契约未评估提示", async () => {
    listChapterDrafts.mockResolvedValue([
      { id: "draft_1_abc", chapterName: "第3章 旧梦", content: "正文", createdAt: 1, status: "draft" },
    ])
    rerunMainControlGates.mockResolvedValue({
      draftId: "draft_1_abc",
      chapterNumber: 3,
      rows: [
        { key: "consistency", status: "pass", verdict: "pass", findings: 0 },
        { key: "anti_ai", status: "skipped", verdict: "pending", findings: 0 },
        { key: "quality", status: "fail", verdict: "fail", findings: 1 },
      ],
      overall: "fail",
      contractEvaluated: false,
      llmMediated: true,
      unassessedDimensions: ["chapter_contract"],
    })
    render(<MainControlView />)
    fireEvent.click(screen.getByTestId("main-control-tab-live"))
    await waitFor(() => expect(screen.getByTestId("main-control-gate-rerun-draft_1_abc")).toBeTruthy())
    fireEvent.click(screen.getByTestId("main-control-gate-rerun-draft_1_abc"))
    await waitFor(() => expect(rerunMainControlGates).toHaveBeenCalledTimes(1))
    expect(rerunMainControlGates).toHaveBeenCalledWith(expect.objectContaining({ draftId: "draft_1_abc" }))
    await waitFor(() => expect(screen.getByTestId("main-control-gate-rerun-result")).toBeTruthy())
    // 未评估门呈现「未评估」，绝不呈现为通过
    expect(screen.getByTestId("main-control-gate-row-anti_ai").textContent).toContain("未评估")
    expect(screen.getByTestId("main-control-gate-row-quality").textContent).toContain("未通过")
    expect(screen.getByTestId("main-control-gate-rerun-contract").textContent).toContain("章节契约维度未评估")
  })
})

/**
 * 前端验收（--frontend-verify）补充：activities 三类事件同通道展示。
 *
 * 三类来源：
 * - stage_output  → 深章阶段产出（run-chapter-workflow onThinking）
 * - analysis      → 共识写作轨迹（run-chapter-workflow buildConsensusActivity，stageId=consensus_writing）
 * - extract_result → 采纳后记忆回填（buildIngestActivity，stageId=memory_ingest）
 * 三者必须都进 `main-control-activities` 同一列表（同一 activities 通道），不各开一块。
 */
describe("前端验收：activities 列表显示三类阶段事件", () => {
  it("stage_output / consensus / ingest 三类事件都进同一 activities 列表", async () => {
    runMainControlAgent.mockResolvedValue({
      ok: true,
      finalText: "完成",
      roundsUsed: 1,
      steps: [],
      drafts: [],
      activities: [
        {
          id: "stage_output:1",
          stageId: "run_chapter_workflow",
          kind: "stage_output",
          title: "深章阶段产出",
          content: "阶段正文片段",
          timestamp: 1,
        },
        {
          id: "consensus_writing:2",
          stageId: "consensus_writing",
          kind: "analysis",
          title: "共识写作",
          content: "席位: 3 · 辩论轮次: 2 · 胜者: seat-1",
          timestamp: 2,
        },
      ],
    })
    listChapterDrafts.mockResolvedValue([
      { id: "draft_1_abc", chapterName: "第3章 旧梦", content: "正文", createdAt: 1, status: "draft" },
    ])
    adoptMainControlDraft.mockResolvedValue({
      formalChapterPath: "/proj/wiki/chapters/第3章 旧梦.md",
      ingest: "ok",
    })
    render(<MainControlView />)

    fireEvent.change(screen.getByTestId("main-control-goal"), { target: { value: "任意目标" } })
    fireEvent.click(screen.getByTestId("main-control-run"))
    await waitFor(() => expect(screen.getByTestId("main-control-activity-stage_output")).toBeTruthy())
    // 共识轨迹走同一条通道（kind=analysis，stageId=consensus_writing）
    expect(screen.getByTestId("main-control-activity-analysis")).toBeTruthy()
    const afterRun = screen.getByTestId("main-control-activities").textContent ?? ""
    expect(afterRun).toContain("阶段正文片段")
    expect(afterRun).toContain("共识写作")
    expect(afterRun).toContain("seat-1")
    // 计数也是同一通道的真实条数（2 条，不伪造）
    expect(afterRun).toContain("2")

    // 第三类：采纳后记忆回填
    fireEvent.click(screen.getByTestId("main-control-tab-drafts"))
    await waitFor(() => expect(screen.getByTestId("main-control-draft-adopt-draft_1_abc")).toBeTruthy())
    fireEvent.click(screen.getByTestId("main-control-draft-adopt-draft_1_abc"))
    await waitFor(() => expect(screen.getByTestId("main-control-draft-adopt-confirm-accept")).toBeTruthy())
    fireEvent.click(screen.getByTestId("main-control-draft-adopt-confirm-accept"))
    await waitFor(() => expect(adoptMainControlDraft).toHaveBeenCalledTimes(1))

    fireEvent.click(screen.getByTestId("main-control-tab-run"))
    await waitFor(() => expect(screen.getByTestId("main-control-activity-extract_result")).toBeTruthy())
    const block = screen.getByTestId("main-control-activities")
    // 三类事件同时在列表里（同一通道，顺序：运行产出 → 共识 → 回填）
    expect(screen.getByTestId("main-control-activity-stage_output")).toBeTruthy()
    expect(screen.getByTestId("main-control-activity-analysis")).toBeTruthy()
    expect(screen.getByTestId("main-control-activity-extract_result")).toBeTruthy()
    expect(block.textContent).toContain("阶段正文片段")
    expect(block.textContent).toContain("共识写作")
    expect(block.textContent).toContain("第3章 旧梦.md")
  })
})

/**
 * 前端验收补充：采纳块的两步确认之外的边界态。
 * - 已写入正式库的草稿不给「采纳」按钮（只显示已保存标记），避免二次覆盖；
 * - 无草稿时显式空态，不静默消失。
 */
describe("前端验收：采纳块边界态", () => {
  it("status=saved 的草稿不出现采纳按钮，只显示已写入标记", async () => {
    listChapterDrafts.mockResolvedValue([
      { id: "draft_9_saved", chapterName: "第9章 已收", content: "正文", createdAt: 1, status: "saved" },
    ])
    render(<MainControlView />)
    fireEvent.click(screen.getByTestId("main-control-tab-drafts"))
    await waitFor(() => expect(screen.getByTestId("main-control-draft-saved-draft_9_saved")).toBeTruthy())
    expect(screen.queryByTestId("main-control-draft-adopt-draft_9_saved")).toBeNull()
  })

  it("无草稿时采纳块显示显式空态（不静默消失）", async () => {
    listChapterDrafts.mockResolvedValue([])
    render(<MainControlView />)
    fireEvent.click(screen.getByTestId("main-control-tab-drafts"))
    await waitFor(() => expect(screen.getByTestId("main-control-draft-adopt-empty")).toBeTruthy())
    expect(screen.getByTestId("main-control-draft-adopt")).toBeTruthy()
  })
})

/**
 * 前端验收补充：live 页签重跑门控的「不给绿色结论」分支与失败提示。
 */
describe("前端验收：重跑门控结果呈现边界", () => {
  it("AI 审稿关闭（llmMediated=false）时显式提示门控为未评估", async () => {
    listChapterDrafts.mockResolvedValue([
      { id: "draft_1_abc", chapterName: "第3章 旧梦", content: "正文", createdAt: 1, status: "draft" },
    ])
    rerunMainControlGates.mockResolvedValue({
      draftId: "draft_1_abc",
      chapterNumber: 3,
      rows: [
        { key: "consistency", status: "pass", verdict: "pass", findings: 0 },
        { key: "anti_ai", status: "skipped", verdict: "pending", findings: 0 },
        { key: "quality", status: "skipped", verdict: "pending", findings: 0 },
      ],
      overall: "manual_review",
      contractEvaluated: true,
      llmMediated: false,
      unassessedDimensions: [],
    })
    render(<MainControlView />)
    fireEvent.click(screen.getByTestId("main-control-tab-live"))
    await waitFor(() => expect(screen.getByTestId("main-control-gate-rerun-draft_1_abc")).toBeTruthy())
    fireEvent.click(screen.getByTestId("main-control-gate-rerun-draft_1_abc"))
    await waitFor(() => expect(screen.getByTestId("main-control-gate-rerun-result")).toBeTruthy())
    expect(screen.getByTestId("main-control-gate-rerun-no-review")).toBeTruthy()
    // 契约已评估 ⇒ 不再提示未评估
    expect(screen.queryByTestId("main-control-gate-rerun-contract")).toBeNull()
    // 两门未评估仍是「未评估」，不得呈现为通过
    expect(screen.getByTestId("main-control-gate-row-anti_ai").textContent).toContain("未评估")
    expect(screen.getByTestId("main-control-gate-row-quality").textContent).toContain("未评估")
    // 整体结论进 note 文案
    const note = screen.getByTestId("main-control-gate-rerun-note").textContent ?? ""
    expect(note).toContain("门控重跑完成")
    expect(note).toContain("转人工")
  })

  it("重跑失败时显示失败原因且不渲染结果块", async () => {
    listChapterDrafts.mockResolvedValue([
      { id: "draft_1_abc", chapterName: "第3章 旧梦", content: "正文", createdAt: 1, status: "draft" },
    ])
    rerunMainControlGates.mockRejectedValue(new Error("找不到草稿正文"))
    render(<MainControlView />)
    fireEvent.click(screen.getByTestId("main-control-tab-live"))
    await waitFor(() => expect(screen.getByTestId("main-control-gate-rerun-draft_1_abc")).toBeTruthy())
    fireEvent.click(screen.getByTestId("main-control-gate-rerun-draft_1_abc"))
    await waitFor(() => expect(screen.getByTestId("main-control-gate-rerun-note")).toBeTruthy())
    expect(screen.getByTestId("main-control-gate-rerun-note").textContent).toContain("门控重跑失败")
    expect(screen.getByTestId("main-control-gate-rerun-note").textContent).toContain("找不到草稿正文")
    expect(screen.queryByTestId("main-control-gate-rerun-result")).toBeNull()
  })

  it("无草稿时门控块显示显式空态", async () => {
    listChapterDrafts.mockResolvedValue([])
    render(<MainControlView />)
    fireEvent.click(screen.getByTestId("main-control-tab-live"))
    await waitFor(() => expect(screen.getByTestId("main-control-gate-rerun-empty")).toBeTruthy())
    expect(screen.getByTestId("main-control-gate-rerun")).toBeTruthy()
  })
})

/**
 * R03=a（TASK-008）：显式「跑深章」入口。
 *
 * 验收（task.test.unit）：
 * - 按钮可渲染；
 * - 点击后真的走 `resolveDeepChapterRunner(novelConfig)` → `runDeepChapterGeneration`，
 *   输入带当前章号 + 当前 novelConfig（目标字数就在 novelConfig 里）；
 * - 深章运行中按钮 loading + disabled（防重入）；
 * - 点击路径零写盘：不碰采纳通道（draft-manager 的 `!confirmed` 护栏原样保留）。
 */
describe("R03=a 显式「跑深章」入口", () => {
  const passGate = { status: "passed", verdict: "pass", findings: [], repair_suggestions: [], retry_count: 0 }
  const deepResult = {
    finalContent: "深章正文片段",
    taskBrief: "任务书",
    draftContent: "草稿正文",
    reviewResults: [],
    revised: false,
    decisionGates: { consistency: passGate, anti_ai: passGate, quality: passGate, overall: "pass" },
    manualReviewRequired: false,
    retryCount: 0,
    partial: false,
    partialReason: null,
  }

  it("跑流程 Tab 渲染「跑深章」按钮（小说模式）", () => {
    render(<MainControlView />)
    expect(screen.getByTestId("main-control-deep-run").textContent).toContain("跑深章")
  })

  it("点击后走 resolveDeepChapterRunner + runDeepChapterGeneration，输入带章号与 novelConfig", async () => {
    runDeepChapterGeneration.mockImplementation(async (_input: unknown, callbacks?: { onThinking?: (s: string) => void }) => {
      callbacks?.onThinking?.("深章阶段产出片段")
      return deepResult
    })
    render(<MainControlView />)
    fireEvent.change(screen.getByTestId("main-control-goal"), { target: { value: "给第12章写开头" } })
    fireEvent.click(screen.getByTestId("main-control-deep-run"))

    await waitFor(() => expect(runDeepChapterGeneration).toHaveBeenCalledTimes(1))
    // 第一步：入口按开关解析（与 start() 同一 helper，不另开生成路径）
    expect(resolveDeepChapterRunner).toHaveBeenCalledWith(
      expect.objectContaining({ chapterTargetChars: 3000 }),
    )
    const [input] = runDeepChapterGeneration.mock.calls[0]
    expect(input).toEqual(
      expect.objectContaining({
        projectPath: "/proj",
        userRequest: "给第12章写开头",
        chapterNumber: 12,
        novelConfig: expect.objectContaining({ chapterTargetChars: 3000 }),
      }),
    )
    // 这条入口不是「拼目标再跑模型」：主控 Agent 零调用（不依赖模型自觉）
    expect(runMainControlAgent).not.toHaveBeenCalled()

    await waitFor(() => expect(screen.getByTestId("main-control-deep-output")).toBeTruthy())
    expect(screen.getByTestId("main-control-deep-output").textContent).toContain("深章正文片段")
    expect(screen.getByTestId("main-control-deep-verdict").textContent).toContain("通过")
    expect(screen.getByTestId("main-control-deep-chapter").textContent).toContain("12")
    // 产出只展示不写盘（文案与行为一致）
    expect(screen.getByTestId("main-control-deep-output-hint").textContent).toContain("未写入任何文件")
    // 深章阶段产出进主控同一条 activities 通道
    expect(screen.getByTestId("main-control-activity-stage_output").textContent).toContain("深章阶段产出片段")
  })

  it("深章运行中按钮 loading + disabled（防重入：再点也只跑一次）", async () => {
    runDeepChapterGeneration.mockImplementation(() => new Promise(() => {}))
    render(<MainControlView />)
    fireEvent.click(screen.getByTestId("main-control-deep-run"))
    await waitFor(() =>
      expect(screen.getByTestId("main-control-deep-run").textContent).toContain("深章生成中"),
    )
    const button = screen.getByTestId("main-control-deep-run") as HTMLButtonElement
    expect(button.disabled).toBe(true)
    fireEvent.click(button)
    fireEvent.click(button)
    expect(runDeepChapterGeneration).toHaveBeenCalledTimes(1)
    // 长跑必须有中止出口（与主控 Agent 共用「中止」按钮）
    expect(screen.getByTestId("main-control-stop")).toBeTruthy()
  })

  it("空目标也能跑：用兜底请求，且不把「3000 字」误当章号", async () => {
    runDeepChapterGeneration.mockResolvedValue(deepResult)
    render(<MainControlView />)
    fireEvent.click(screen.getByTestId("main-control-deep-run"))
    await waitFor(() => expect(runDeepChapterGeneration).toHaveBeenCalledTimes(1))
    const [input] = runDeepChapterGeneration.mock.calls[0]
    expect(input.userRequest).toBe("续写下一章，按当前设置的目标字数写完整一章")
    expect(input.chapterNumber).toBeUndefined()
  })

  it("点击路径零写盘：不调用采纳通道（!confirmed 护栏原样保留）", async () => {
    runDeepChapterGeneration.mockResolvedValue(deepResult)
    render(<MainControlView />)
    fireEvent.click(screen.getByTestId("main-control-deep-run"))
    await waitFor(() => expect(screen.getByTestId("main-control-deep-output")).toBeTruthy())
    expect(adoptMainControlDraft).not.toHaveBeenCalled()
  })

  it("深章失败时显示失败原因，且不渲染产出块", async () => {
    runDeepChapterGeneration.mockRejectedValue(new Error("模型不可用"))
    render(<MainControlView />)
    fireEvent.click(screen.getByTestId("main-control-deep-run"))
    await waitFor(() => expect(screen.getByTestId("main-control-error")).toBeTruthy())
    expect(screen.getByTestId("main-control-error").textContent).toContain("深章生成失败")
    expect(screen.getByTestId("main-control-error").textContent).toContain("模型不可用")
    expect(screen.queryByTestId("main-control-deep-output")).toBeNull()
  })
})

/**
 * TASK-014（F10 + F11 + NF-05）：轨迹快照读回端。
 *
 * 快照共 9 个字段，旧实现只恢复 entries / savedAt，activities / finalText / goal /
 * ok / stopReason / roundsUsed 六项全被丢弃 → 回放面板显示「假空态」（明明有阶段事件，
 * 却说本次运行没有）。本组断言逐项钉住这 6 个字段「读回后可观测」，
 * 以及空态文案必须区分「没有快照」与「快照存在但那次没有阶段事件」。
 */
describe("TASK-014 回放：快照 6 个字段全部读回（不再假空态）", () => {
  const snapshot = {
    fileVersion: 2 as const,
    goal: "上次的目标：给第12章写开头",
    savedAt: 1_700_000_000_000,
    ok: false,
    stopReason: "模型不支持工具调用",
    roundsUsed: 4,
    finalText: "上次运行的终稿正文",
    entries: [
      {
        callId: "c1",
        name: "read_chapter",
        input: '{"name":"第12章"}',
        result: "正文",
        status: "done" as const,
        startedAt: 1,
        finishedAt: 421,
        durationMs: 420,
        title: "读取章节",
        summary: "读了第12章",
        details: [],
      },
    ],
    activities: [
      { kind: "stage_output" as const, title: "深章阶段产出", summary: "快照里的阶段产出片段", at: 11 },
      { kind: "analysis" as const, title: "共识写作", summary: "席位: 3", at: 12 },
    ],
  }

  it("activities / finalText / goal / ok / stopReason / roundsUsed 六项读回后都可观测", async () => {
    loadTraceSnapshot.mockResolvedValue(snapshot)
    render(<MainControlView />)

    // ③ goal：回放把上次目标填回输入框（空目标时才填）
    await waitFor(() =>
      expect((screen.getByTestId("main-control-goal") as HTMLTextAreaElement).value).toBe(snapshot.goal),
    )

    // ① activities：快照投影进同一条阶段观测通道，而不是「本次运行没有阶段事件」
    await waitFor(() => expect(screen.getByTestId("main-control-activity-stage_output")).toBeTruthy())
    expect(screen.getByTestId("main-control-activity-analysis").textContent).toContain("共识写作")
    expect(screen.getByTestId("main-control-activities").textContent).toContain("快照里的阶段产出片段")
    expect(screen.getByTestId("main-control-activities-replay")).toBeTruthy()
    expect(screen.getByTestId("main-control-activities").textContent).not.toContain("本次运行没有阶段事件")

    // ② finalText + ⑥ roundsUsed：结论块读回上次运行的终稿与轮数
    const finalBlock = screen.getByTestId("main-control-final")
    expect(finalBlock.textContent).toContain("上次运行的终稿正文")
    expect(finalBlock.textContent).toContain("4 轮")
    expect(screen.getByTestId("main-control-final-replay")).toBeTruthy()

    // ④ ok + ⑤ stopReason：结论里能看出上次没成功、以及中断原因
    expect(screen.getByTestId("main-control-replay-verdict").textContent).toContain("上次运行未成功")
    expect(screen.getByTestId("main-control-replay-stop-reason").textContent).toContain("模型不支持工具调用")

    // 原有 2 项不得回退：entries / savedAt
    expect(screen.getByTestId("main-control-trace-entry-read_chapter")).toBeTruthy()
    expect(screen.getByTestId("main-control-trace-replay")).toBeTruthy()
  })

  it("快照 ok=true 时结论标为成功，且不渲染中断原因", async () => {
    loadTraceSnapshot.mockResolvedValue({ ...snapshot, ok: true, stopReason: undefined, finalText: "完成" })
    render(<MainControlView />)
    await waitFor(() => expect(screen.getByTestId("main-control-replay-verdict")).toBeTruthy())
    expect(screen.getByTestId("main-control-replay-verdict").textContent).toContain("上次运行成功")
    expect(screen.queryByTestId("main-control-replay-stop-reason")).toBeNull()
    expect(screen.getByTestId("main-control-final").textContent).toContain("完成")
  })

  it("快照存在但没有 activities：空态说「快照里没有阶段事件」，不冒充本次运行空", async () => {
    loadTraceSnapshot.mockResolvedValue({ ...snapshot, activities: undefined })
    render(<MainControlView />)
    await waitFor(() =>
      expect(screen.getByTestId("main-control-activities-empty").textContent).toContain(
        "上次运行的快照里没有阶段事件",
      ),
    )
    expect(screen.getByTestId("main-control-activities-empty").textContent).not.toContain(
      "本次运行没有阶段事件",
    )
    // 快照在：回放标识仍在（证明这是「快照空」而不是「没有快照」）
    expect(screen.getByTestId("main-control-activities-replay")).toBeTruthy()
  })

  it("没有快照：空态说「本次运行没有阶段事件」，不得冒充快照空", async () => {
    loadTraceSnapshot.mockResolvedValue(null)
    render(<MainControlView />)
    await waitFor(() => expect(loadTraceSnapshot).toHaveBeenCalledWith("/proj"))
    const empty = screen.getByTestId("main-control-activities-empty").textContent ?? ""
    expect(empty).toContain("本次运行没有阶段事件")
    expect(empty).not.toContain("上次运行的快照里没有阶段事件")
    expect(screen.queryByTestId("main-control-activities-replay")).toBeNull()
    expect(screen.queryByTestId("main-control-trace-replay")).toBeNull()
  })

  it("TASK-015：两种空态渲染不同文案 —— 快照不存在 vs 快照存在但无 activities", async () => {
    // ① 「快照不存在」：读回端返回 null
    loadTraceSnapshot.mockResolvedValue(null)
    render(<MainControlView />)
    await waitFor(() => expect(loadTraceSnapshot).toHaveBeenCalledWith("/proj"))
    const noSnapshotActivitiesEmpty = screen.getByTestId("main-control-activities-empty").textContent ?? ""
    const noSnapshotTraceEmpty = screen.getByTestId("main-control-trace-empty").textContent ?? ""
    cleanup()

    // ② 「快照存在但那次没有 activities」：快照在（回放标识出现），只是字段为空
    loadTraceSnapshot.mockResolvedValue({ ...snapshot, entries: [], activities: undefined })
    render(<MainControlView />)
    await waitFor(() => expect(screen.getByTestId("main-control-trace-replay")).toBeTruthy())
    const snapshotActivitiesEmpty = screen.getByTestId("main-control-activities-empty").textContent ?? ""
    const snapshotTraceEmpty = screen.getByTestId("main-control-trace-empty").textContent ?? ""

    // 两段文案必须「真的不一样」——同一句话就是假空态回归（本次要防的那件事）
    expect(noSnapshotActivitiesEmpty.length).toBeGreaterThan(0)
    expect(snapshotActivitiesEmpty.length).toBeGreaterThan(0)
    expect(snapshotActivitiesEmpty).not.toBe(noSnapshotActivitiesEmpty)
    // 且各自指向正确的那件事
    expect(noSnapshotActivitiesEmpty).toContain("本次运行没有阶段事件")
    expect(noSnapshotActivitiesEmpty).not.toContain("上次运行的快照里没有阶段事件")
    expect(snapshotActivitiesEmpty).toContain("上次运行的快照里没有阶段事件")
    expect(snapshotActivitiesEmpty).not.toContain("本次运行没有阶段事件")

    // 轨迹空态同样区分两种「空」
    expect(snapshotTraceEmpty).not.toBe(noSnapshotTraceEmpty)
    expect(noSnapshotTraceEmpty).toContain("还没有轨迹")
    expect(snapshotTraceEmpty).toContain("上次运行的快照里没有工具调用记录")
  })

  it("章节页交接的目标不被回放覆盖（回放只填空目标）", async () => {
    const handoff = await import("./main-control-handoff")
    handoff.setMainControlGoalHandoff("为「第7章」生成本章草稿")
    try {
      loadTraceSnapshot.mockResolvedValue(snapshot)
      render(<MainControlView />)
      await waitFor(() => expect(screen.getByTestId("main-control-trace-replay")).toBeTruthy())
      expect((screen.getByTestId("main-control-goal") as HTMLTextAreaElement).value).toBe(
        "为「第7章」生成本章草稿",
      )
    } finally {
      handoff.clearMainControlGoalHandoff()
    }
  })

  it("本次运行开始后旧快照不再冒充当前状态（回放标识消失）", async () => {
    loadTraceSnapshot.mockResolvedValue(snapshot)
    runMainControlAgent.mockResolvedValue({
      ok: true,
      finalText: "本次终稿",
      roundsUsed: 1,
      steps: [],
      drafts: [],
      activities: [{ id: "a1", stageId: "s1", kind: "stage_output", title: "本次产出", content: "本次片段", timestamp: 1 }],
    })
    render(<MainControlView />)
    await waitFor(() => expect(screen.getByTestId("main-control-trace-replay")).toBeTruthy())
    fireEvent.change(screen.getByTestId("main-control-goal"), { target: { value: "本次目标" } })
    fireEvent.click(screen.getByTestId("main-control-run"))
    await waitFor(() => expect(screen.getByTestId("main-control-final")).toBeTruthy())
    expect(screen.getByTestId("main-control-final").textContent).toContain("本次终稿")
    expect(screen.queryByTestId("main-control-final-replay")).toBeNull()
    expect(screen.queryByTestId("main-control-replay-verdict")).toBeNull()
    expect(screen.getByTestId("main-control-activities").textContent).toContain("本次片段")
    expect(screen.queryByTestId("main-control-activities-replay")).toBeNull()
  })
})
