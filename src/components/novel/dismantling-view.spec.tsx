// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup } from "@testing-library/react"
import { render, screen, fireEvent, waitFor, within } from "@/test-helpers/component-test-utils"
import { DismantlingView } from "./dismantling-view"
import type { DismantlingChapter, DismantlingLibrary } from "@/lib/novel/dismantling"

const wiki = vi.hoisted(() => {
  const state: Record<string, unknown> = {
    project: { id: "p1", name: "Novel", path: "E:/Novel" },
    llmConfig: { provider: "custom" as const, apiKey: "k", model: "m" },
    novelConfig: { contextTokenBudget: 0 },
    dataVersion: 0,
    selectedDismantlingProjectId: "proj-1",
    bumpDataVersion: vi.fn(),
  }
  return {
    state,
    getStateSnapshot: {
      searchApiConfig: { provider: "local" as const, apiKey: "" },
    },
  }
})

vi.mock("@/stores/wiki-store", () => ({
  useWikiStore: Object.assign(
    (selector: (s: Record<string, unknown>) => unknown) => selector(wiki.state),
    { getState: () => wiki.getStateSnapshot },
  ),
}))

const dismantling = vi.hoisted(() => {
  const chapters: DismantlingChapter[] = [
    { id: "ch1", chapterNumber: 1, title: "第一章 初入皇城", content: "c1", status: "pending" },
    { id: "ch2", chapterNumber: 2, title: "第二章 夜宴", content: "c2", status: "pending" },
    { id: "ch3", chapterNumber: 3, title: "第三章 变局", content: "c3", status: "done" },
    { id: "ch4", chapterNumber: 4, title: "第四章 尾声", content: "c4", status: "running" },
  ]
  return {
    chapters,
    library: (overrides?: Partial<DismantlingLibrary>): DismantlingLibrary => ({
      version: 1,
      projects: [
        {
          id: "proj-1",
          title: "长夜书",
          createdAt: 1,
          updatedAt: 2,
          chapters,
          analyses: [
            { id: "analysis-1", chapterIds: ["ch3"], title: "第 3 章拆文", createdAt: 3, markdown: "# 分析输出", structureMemory: ["m1"] },
          ],
          structureMemory: ["记忆A", "记忆B"],
          useInChat: false,
        },
      ],
      ...overrides,
    }),
    loadDismantlingLibrary: vi.fn(),
    saveDismantlingLibrary: vi.fn(async () => {}),
    selectNextDismantlingBatch: vi.fn(),
    buildDismantlingAnalysisPrompt: vi.fn(() => "analysis-prompt"),
    buildDismantlingWebResearchPrompt: vi.fn(() => "web-prompt"),
    extractStructureMemoryFromAnalysis: vi.fn(() => ["记忆1", "记忆2"]),
  }
})

vi.mock("@/lib/novel/dismantling", () => ({
  loadDismantlingLibrary: dismantling.loadDismantlingLibrary,
  saveDismantlingLibrary: dismantling.saveDismantlingLibrary,
  selectNextDismantlingBatch: dismantling.selectNextDismantlingBatch,
  buildDismantlingAnalysisPrompt: dismantling.buildDismantlingAnalysisPrompt,
  buildDismantlingWebResearchPrompt: dismantling.buildDismantlingWebResearchPrompt,
  extractStructureMemoryFromAnalysis: dismantling.extractStructureMemoryFromAnalysis,
}))

const llm = vi.hoisted(() => ({
  streamChat: vi.fn(async (_config: unknown, _messages: unknown, callbacks: { onToken: (t: string) => void; onDone: () => void; onError: (e: Error) => void }) => {
    callbacks.onToken("token")
    callbacks.onDone()
  }),
}))

vi.mock("@/lib/llm-client", () => ({
  streamChat: llm.streamChat,
}))

const model = vi.hoisted(() => ({
  resolveNovelModel: vi.fn(() => ({ provider: "custom", apiKey: "k", model: "m" })),
}))

vi.mock("@/lib/novel/model-resolver", () => ({
  resolveNovelModel: model.resolveNovelModel,
}))

const web = vi.hoisted(() => ({
  collectWebResearch: vi.fn(async () => ({ items: [], sources: [] })),
  buildWebResearchContext: vi.fn(() => ({ markdown: "web-ctx", sources: ["src1", "src2"] })),
}))

vi.mock("@/lib/web-research", () => ({
  collectWebResearch: web.collectWebResearch,
  buildWebResearchContext: web.buildWebResearchContext,
}))

beforeEach(() => {
  vi.clearAllMocks()
  wiki.state.project = { id: "p1", name: "Novel", path: "E:/Novel" }
  wiki.state.selectedDismantlingProjectId = "proj-1"
  dismantling.loadDismantlingLibrary.mockResolvedValue(dismantling.library())
  dismantling.selectNextDismantlingBatch.mockImplementation(
    (project: { chapters: DismantlingChapter[] }, options: { selectedChapterIds: string[]; batchSize: number }) =>
      project.chapters
        .filter((c) => options.selectedChapterIds.includes(c.id) && c.status === "pending")
        .slice(0, options.batchSize),
  )
})

afterEach(() => {
  cleanup()
})

describe("DismantlingView", () => {
  it("shows a hint when no project is open", () => {
    wiki.state.project = null
    render(<DismantlingView />)
    expect(screen.getByText("请先打开小说项目。")).toBeInTheDocument()
  })

  it("shows empty states when no dismantling project is selected", async () => {
    wiki.state.selectedDismantlingProjectId = null
    render(<DismantlingView />)
    expect(await screen.findByText("请从左侧选择拆文作品")).toBeInTheDocument()
    expect(screen.getByText("选择作品后，拆文结果将显示在此处。")).toBeInTheDocument()
  })

  it("loads the selected project and renders chapters, structure memory and analyses", async () => {
    render(<DismantlingView />)
    expect(await screen.findByText("长夜书")).toBeInTheDocument()
    expect(screen.getByText("已自动识别章节结构：4 章 · 2 条结构记忆")).toBeInTheDocument()
    // chapter rows
    expect(screen.getByText("第一章 初入皇城")).toBeInTheDocument()
    expect(screen.getByText("第二章 夜宴")).toBeInTheDocument()
    expect(screen.getByText("第三章 变局")).toBeInTheDocument()
    expect(screen.getByText("第四章 尾声")).toBeInTheDocument()
    // status badges: pending ×2 + done + running
    expect(screen.getAllByText("待拆")).toHaveLength(2)
    expect(screen.getByText("已拆")).toBeInTheDocument()
    expect(screen.getByText("拆文中")).toBeInTheDocument()
    // structure memory list（li 渲染为 "- 记忆A"）
    expect(screen.getByText(/- 记忆A/)).toBeInTheDocument()
    expect(screen.getByText(/- 记忆B/)).toBeInTheDocument()
    // analyses
    expect(screen.getByText("第 3 章拆文")).toBeInTheDocument()
    expect(screen.getByText("# 分析输出")).toBeInTheDocument()
    // batch size default 3 章
    expect(screen.getByRole("combobox")).toHaveValue("3")
  })

  it("falls back to an empty state when the project id is not in the library", async () => {
    dismantling.loadDismantlingLibrary.mockResolvedValue({ version: 1, projects: [] })
    render(<DismantlingView />)
    expect(await screen.findByText("请从左侧选择拆文作品")).toBeInTheDocument()
    expect(dismantling.loadDismantlingLibrary).toHaveBeenCalledWith("E:/Novel")
  })

  it("toggles use-in-chat and reports status, leaving other projects untouched", async () => {
    const other = {
      id: "proj-2",
      title: "另一本书",
      createdAt: 1,
      updatedAt: 1,
      chapters: [],
      analyses: [],
      structureMemory: [],
      useInChat: true,
    }
    dismantling.loadDismantlingLibrary.mockResolvedValue({
      version: 1,
      projects: [dismantling.library().projects[0], other],
    })
    render(<DismantlingView />)
    await screen.findByText("长夜书")
    const checkbox = screen.getByRole("checkbox", { name: /在 AI 会话写作时参考当前拆文作品的结构记忆/ })
    fireEvent.click(checkbox)
    await waitFor(() => {
      expect(dismantling.saveDismantlingLibrary).toHaveBeenCalledTimes(1)
    })
    const saved = dismantling.saveDismantlingLibrary.mock.calls[0][1] as DismantlingLibrary
    expect(saved.projects[0].useInChat).toBe(true)
    // 另一个项目走 map 的 else 分支原样保留
    expect(saved.projects[1]).toBe(other)
    expect(screen.getByText("已启用：AI 会话会在用户写作时参考拆文结构。")).toBeInTheDocument()

    fireEvent.click(checkbox)
    await waitFor(() => {
      expect(dismantling.saveDismantlingLibrary).toHaveBeenCalledTimes(2)
    })
    expect(screen.getByText("已关闭：AI 会话不会读取该拆文结构。")).toBeInTheDocument()
  })

  it("toggles chapter selection, select-all and clear", async () => {
    render(<DismantlingView />)
    await screen.findByText("长夜书")
    const ch1 = screen.getByRole("checkbox", { name: /第一章 初入皇城/ })
    fireEvent.click(ch1)
    expect(screen.getByText(/开始拆文（3 章）/)).toBeInTheDocument()
    // 重新勾选走 toggleChapter 的 checked 分支
    fireEvent.click(ch1)
    expect(screen.getByText(/开始拆文（4 章）/)).toBeInTheDocument()
    fireEvent.click(screen.getByText("清空"))
    expect(screen.getByText("请先选择章节")).toBeInTheDocument()
    fireEvent.click(screen.getByText("全选"))
    expect(screen.getByText(/开始拆文（4 章）/)).toBeInTheDocument()
  })

  it("changes batch size via select", async () => {
    render(<DismantlingView />)
    await screen.findByText("长夜书")
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "5" } })
    expect(screen.getByRole("combobox")).toHaveValue("5")
  })

  it("reports when the selected range has no pending chapters", async () => {
    dismantling.selectNextDismantlingBatch.mockReturnValue([])
    render(<DismantlingView />)
    await screen.findByText("长夜书")
    fireEvent.click(screen.getByText(/开始拆文/))
    expect(await screen.findByText("当前选择范围内没有待拆章节。")).toBeInTheDocument()
  })

  it("runs dismantling: marks chapters running/done, saves analysis and structure memory", async () => {
    render(<DismantlingView />)
    await screen.findByText("长夜书")
    fireEvent.click(screen.getByText(/开始拆文（4 章）/))
    expect(await screen.findByText(/本批拆文完成，新增 2 条结构记忆/)).toBeInTheDocument()
    expect(llm.streamChat).toHaveBeenCalledTimes(1)
    expect(model.resolveNovelModel).toHaveBeenCalledWith(expect.anything(), expect.anything(), "extract")
    const calls = dismantling.saveDismantlingLibrary.mock.calls.map((c) => c[1] as DismantlingLibrary)
    // 1st save marks running, 2nd marks done + analysis
    expect(calls[0].projects[0].chapters.find((c) => c.id === "ch1")?.status).toBe("running")
    const final = calls[calls.length - 1]
    expect(final.projects[0].chapters.find((c) => c.id === "ch1")?.status).toBe("done")
    expect(final.projects[0].analyses[0].title).toBe("第 1-2 章拆文")
    expect(final.projects[0].structureMemory).toContain("记忆1")
  })

  it("marks failed chapters when streamChat errors (non-Error throw)", async () => {
    llm.streamChat.mockImplementationOnce(async (_c, _m, callbacks) => {
      callbacks.onError("网络中断" as unknown as Error)
    })
    render(<DismantlingView />)
    await screen.findByText("长夜书")
    fireEvent.click(screen.getByText(/开始拆文（4 章）/))
    expect(await screen.findByText("拆文失败：网络中断")).toBeInTheDocument()
    const calls = dismantling.saveDismantlingLibrary.mock.calls.map((c) => c[1] as DismantlingLibrary)
    const last = calls[calls.length - 1]
    expect(last.projects[0].chapters.find((c) => c.id === "ch2")?.status).toBe("failed")
    expect(last.projects[0].chapters.find((c) => c.id === "ch2")?.error).toBe("网络中断")
  })

  it("ignores a stale library load when the selection changes", async () => {
    let resolveFirst: (value: DismantlingLibrary) => void = () => {}
    dismantling.loadDismantlingLibrary.mockImplementationOnce(
      () => new Promise<DismantlingLibrary>((res) => { resolveFirst = res }),
    )
    dismantling.loadDismantlingLibrary.mockResolvedValueOnce(dismantling.library())
    const { rerender } = render(<DismantlingView />)
    wiki.state.dataVersion = 1
    rerender(<DismantlingView />)
    expect(dismantling.loadDismantlingLibrary).toHaveBeenCalledTimes(2)
    // 第一次加载在 effect 重跑后完成 → cancelled=true，忽略
    resolveFirst(dismantling.library())
    expect(await screen.findByText("长夜书")).toBeInTheDocument()
  })

  it("shows empty structure memory and analyses placeholders", async () => {
    const empty = dismantling.library()
    empty.projects[0].structureMemory = []
    empty.projects[0].analyses = []
    dismantling.loadDismantlingLibrary.mockResolvedValue(empty)
    render(<DismantlingView />)
    await screen.findByText("长夜书")
    expect(screen.getByText("拆文完成后，这里会显示可供 AI 引用的结构记忆。")).toBeInTheDocument()
    expect(screen.getByText("还没有拆文结果。")).toBeInTheDocument()
  })

  it("web research: button disabled while input empty", async () => {
    render(<DismantlingView />)
    await screen.findByText("长夜书")
    // 空输入时按钮禁用（handleRunWebDismantlingResearch 的 !request 分支因此不可达）
    expect(screen.getByText("开始网页热门分析").closest("button")).toBeDisabled()
  })

  it("web research: runs collection + LLM and reports completion", async () => {
    render(<DismantlingView />)
    await screen.findByText("长夜书")
    fireEvent.change(screen.getByPlaceholderText(/例如：搜索番茄都市脑洞热门开篇套路/), {
      target: { value: "都市脑洞开篇" },
    })
    fireEvent.click(screen.getByText("开始网页热门分析"))
    expect(await screen.findByText(/网页热门分析完成，参考来源 2 条，新增 2 条结构记忆/)).toBeInTheDocument()
    expect(web.collectWebResearch).toHaveBeenCalledWith(expect.objectContaining({ maxSearchResults: 6, maxImportedDocuments: 4 }))
    expect(dismantling.buildDismantlingWebResearchPrompt).toHaveBeenCalledWith(expect.objectContaining({ userRequest: "都市脑洞开篇" }))
  })

  it("web research: reports failure (non-Error throw)", async () => {
    llm.streamChat.mockImplementationOnce(async (_c, _m, callbacks) => {
      callbacks.onError("搜索失败" as unknown as Error)
    })
    render(<DismantlingView />)
    await screen.findByText("长夜书")
    fireEvent.change(screen.getByPlaceholderText(/例如：搜索番茄都市脑洞热门开篇套路/), {
      target: { value: "榜单" },
    })
    fireEvent.click(screen.getByText("开始网页热门分析"))
    expect(await screen.findByText("网页热门分析失败：搜索失败")).toBeInTheDocument()
  })

  it("web research: reports failure with an Error instance", async () => {
    llm.streamChat.mockImplementationOnce(async (_c, _m, callbacks) => {
      callbacks.onError(new Error("接口超时"))
    })
    render(<DismantlingView />)
    await screen.findByText("长夜书")
    fireEvent.change(screen.getByPlaceholderText(/例如：搜索番茄都市脑洞热门开篇套路/), {
      target: { value: "榜单" },
    })
    fireEvent.click(screen.getByText("开始网页热门分析"))
    expect(await screen.findByText("网页热门分析失败：接口超时")).toBeInTheDocument()
  })

  it("renders failed status badges after a failed run", async () => {
    llm.streamChat.mockImplementationOnce(async (_c, _m, callbacks) => {
      callbacks.onError(new Error("x"))
    })
    render(<DismantlingView />)
    await screen.findByText("长夜书")
    fireEvent.click(screen.getByText(/开始拆文（4 章）/))
    await screen.findByText("拆文失败：x")
    expect(screen.getAllByText("失败")).toHaveLength(2)
    expect(screen.getByText("已拆")).toBeInTheDocument()
  })
})
