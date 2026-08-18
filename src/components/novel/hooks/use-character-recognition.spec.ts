// @vitest-environment jsdom
/**
 * useCharacterRecognition — 章节确认 → LLM 角色识别全流程 + 取消/错误分支全覆盖。
 * store 与外部依赖全部 vi.mock（vi.hoisted 可写 state 模式，参照 src/App.spec.tsx）。
 */
import { renderHook, act } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { AnalysisDepth, BookAnalysisMetadata, RecognizedCharacter } from "@/lib/novel/book-analysis/types"
import type { ChapterSelectionData } from "./use-character-extraction"
import { useCharacterRecognition, type UseCharacterRecognitionParams } from "./use-character-recognition"

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

interface BookAnalysisLike {
  updateTaskProgress: ReturnType<typeof vi.fn>
  requestReopenChapterSelection: ReturnType<typeof vi.fn>
}

interface WikiLike {
  llmConfig: unknown
}

const mocks = vi.hoisted(() => {
  const bookAnalysis: BookAnalysisLike = {
    updateTaskProgress: vi.fn(),
    requestReopenChapterSelection: vi.fn(),
  }
  const wiki: WikiLike = { llmConfig: null }
  return {
    bookAnalysis,
    wiki,
    readFile: vi.fn(async () => "---\ntitle: 第一章\n---\n正文内容正文内容"),
    joinPath: vi.fn((...parts: string[]) => parts.join("/")),
    toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
    saveRecognizedCharacters: vi.fn(async () => {}),
    llmRecognizeCharacters: vi.fn(),
  }
})

vi.mock("@/stores/book-analysis-store", () => ({
  useBookAnalysisStore: { getState: () => mocks.bookAnalysis },
}))

vi.mock("@/stores/wiki-store", () => ({
  useWikiStore: Object.assign(
    (selector: (s: WikiLike) => unknown) => selector(mocks.wiki),
    { getState: () => mocks.wiki },
  ),
}))

vi.mock("@/commands/fs", () => ({ readFile: mocks.readFile }))

vi.mock("@/lib/path-utils", () => ({ joinPath: mocks.joinPath }))

vi.mock("@/lib/toast", () => ({ toast: mocks.toast }))

vi.mock("@/lib/novel/book-analysis/recognized-character-store", () => ({
  saveRecognizedCharacters: mocks.saveRecognizedCharacters,
}))

vi.mock("@/lib/novel/book-analysis/character-llm-recognizer", () => ({
  llmRecognizeCharacters: mocks.llmRecognizeCharacters,
}))

// ── fixtures ────────────────────────────────────────────────────────────────────

const metadata: BookAnalysisMetadata = {
  title: "长夜书",
  author: "某人",
  totalChapters: 2,
  totalWords: 1800,
  sourceType: "file",
  createdAt: 1,
  updatedAt: 2,
}

function makeData(overrides: Partial<ChapterSelectionData> = {}): ChapterSelectionData {
  return {
    taskId: "task-1",
    bookPath: "/books/b1",
    chapters: [
      { id: "c1", title: "第一章", order: 1, wordCount: 1000, path: "/books/b1/chapters/c1.md" },
      { id: "c2", title: "第二章", order: 2, wordCount: 800, path: "/books/b1/chapters/c2.md" },
    ],
    metadata,
    abortController: new AbortController(),
    selectedChapterIds: ["c1", "c2"],
    depth: "standard" as AnalysisDepth,
    ...overrides,
  }
}

const recognized: RecognizedCharacter[] = [
  { id: "r1", name: "林烬", aliases: [], appearances: 3, chapterIndices: [0, 1], importanceScore: 90, category: "主角", sourceBook: "长夜书" },
  { id: "r2", name: "苏遥", aliases: [], appearances: 2, chapterIndices: [0], importanceScore: 70, category: "配角", sourceBook: "长夜书" },
  { id: "r3", name: "路人甲", aliases: [], appearances: 1, chapterIndices: [1], importanceScore: 30, category: "次要", sourceBook: "长夜书" },
]

const defaultLlm = { provider: "openai" as const, apiKey: "key-1", model: "gpt-4o", ollamaUrl: "", customEndpoint: "", maxContextSize: 120000 }

type RecParams = UseCharacterRecognitionParams
type RecSpecProps = Omit<RecParams, "llmConfig"> & { llmConfig: RecParams["llmConfig"] | null }

function renderRecognitionHook(overrides: Partial<RecSpecProps> = {}) {
  const props: RecSpecProps = {
    chapterSelectionData: makeData(),
    setChapterSelectionData: vi.fn(),
    recognizedCharacters: recognized,
    selectedCharacterIds: ["r1"],
    setRecognitionStatus: vi.fn(),
    setRecognizedCharacters: vi.fn(),
    setSelectedCharacterIds: vi.fn(),
    clearRecognition: vi.fn(),
    setRecognitionError: vi.fn(),
    llmConfig: defaultLlm,
    ...overrides,
  }
  const rendered = renderHook(() => useCharacterRecognition(props as unknown as RecParams))
  return { ...rendered, props }
}

describe("useCharacterRecognition", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.readFile.mockResolvedValue("---\ntitle: 第一章\n---\n正文内容正文内容")
    mocks.llmRecognizeCharacters.mockResolvedValue([recognized[0], recognized[1]])
    mocks.saveRecognizedCharacters.mockResolvedValue(undefined)
  })

  // ── handleChapterSelectionConfirm ──────────────────────────────────────────────

  it("无 chapterSelectionData 时确认不触发任何动作", async () => {
    const { result, props } = renderRecognitionHook({ chapterSelectionData: null })
    await act(async () => {
      await result.current.handleChapterSelectionConfirm(["c1"])
    })
    expect(props.setChapterSelectionData).not.toHaveBeenCalled()
    expect(props.clearRecognition).not.toHaveBeenCalled()
    expect(props.setRecognitionStatus).not.toHaveBeenCalled()
    expect(mocks.bookAnalysis.updateTaskProgress).not.toHaveBeenCalled()
  })

  it("成功路径：读章节→LLM 识别→保存→done→toast action 重开面板", async () => {
    const { result, props } = renderRecognitionHook()
    await act(async () => {
      await result.current.handleChapterSelectionConfirm(["c1", "c2"])
    })
    expect(props.setChapterSelectionData).toHaveBeenCalledWith(
      expect.objectContaining({ selectedChapterIds: ["c1", "c2"], depth: "standard" }),
    )
    expect(props.clearRecognition).toHaveBeenCalledTimes(1)
    expect(props.setRecognitionStatus).toHaveBeenCalledWith("heuristic")
    expect(mocks.bookAnalysis.updateTaskProgress).toHaveBeenCalledWith("task-1", {
      recognitionStatus: "heuristic",
      stageLabel: "读取章节中",
    })
    expect(mocks.joinPath).toHaveBeenCalledWith("/books/b1", "chapters", "c1.md")
    expect(mocks.joinPath).toHaveBeenCalledWith("/books/b1", "chapters", "c2.md")
    expect(mocks.readFile).toHaveBeenCalledTimes(2)
    expect(mocks.llmRecognizeCharacters).toHaveBeenCalledWith(
      expect.objectContaining({
        chapters: [
          { index: 0, content: expect.any(String) },
          { index: 1, content: expect.any(String) },
        ],
        sourceBook: "/books/b1",
      }),
    )
    expect(props.setRecognitionStatus).toHaveBeenCalledWith("llm_recognizing")
    expect(mocks.bookAnalysis.updateTaskProgress).toHaveBeenCalledWith("task-1", {
      recognitionStatus: "llm_recognizing",
      stageLabel: "正在用 AI 识别角色",
    })
    expect(mocks.saveRecognizedCharacters).toHaveBeenCalledWith("/books/b1", [recognized[0], recognized[1]])
    expect(props.setRecognizedCharacters).toHaveBeenCalledWith([recognized[0], recognized[1]])
    expect(props.setRecognitionStatus).toHaveBeenCalledWith("done")
    expect(mocks.bookAnalysis.updateTaskProgress).toHaveBeenCalledWith(
      "task-1",
      expect.objectContaining({ recognitionStatus: "done", percentage: 100, stageLabel: "识别出 2 个角色（AI 识别）" }),
    )
    expect(mocks.toast.success).toHaveBeenCalledWith("识别完成：共 2 个角色", expect.objectContaining({ label: "现在处理" }))
    const action = mocks.toast.success.mock.calls[0]?.[1] as { onClick: () => void }
    act(() => action.onClick())
    expect(mocks.bookAnalysis.requestReopenChapterSelection).toHaveBeenCalledWith("task-1")
  })

  it("读取章节只读取所选章节并按 order 排序", async () => {
    const { result } = renderRecognitionHook()
    await act(async () => {
      await result.current.handleChapterSelectionConfirm(["c2"])
    })
    expect(mocks.readFile).toHaveBeenCalledTimes(1)
    expect(mocks.joinPath).toHaveBeenCalledWith("/books/b1", "chapters", "c2.md")
    expect(mocks.llmRecognizeCharacters).toHaveBeenCalledWith(
      expect.objectContaining({ chapters: [{ index: 0, content: expect.any(String) }] }),
    )
  })

  it("未配置 LLM 时报错并进入 error 状态", async () => {
    const { result, props } = renderRecognitionHook({ llmConfig: null })
    await act(async () => {
      await result.current.handleChapterSelectionConfirm(["c1", "c2"])
    })
    expect(props.setRecognitionStatus).toHaveBeenCalledWith("error")
    expect(props.setRecognitionError).toHaveBeenCalledWith("未配置可用的模型，请先在设置中配置 LLM，再识别角色")
    expect(mocks.bookAnalysis.updateTaskProgress).toHaveBeenCalledWith("task-1", {
      recognitionStatus: "error",
      stageLabel: "角色识别失败：未配置可用的模型，请先在设置中配置 LLM，再识别角色",
    })
    expect(mocks.toast.error).toHaveBeenCalledWith("角色识别失败：未配置可用的模型，请先在设置中配置 LLM，再识别角色")
  })

  it("AI 未识别出角色时报错", async () => {
    mocks.llmRecognizeCharacters.mockResolvedValue([])
    const { result, props } = renderRecognitionHook()
    await act(async () => {
      await result.current.handleChapterSelectionConfirm(["c1", "c2"])
    })
    expect(props.setRecognitionError).toHaveBeenCalledWith("AI 没有识别出角色，请确认所选章节包含人物，或更换模型后重试")
    expect(props.setRecognitionStatus).toHaveBeenCalledWith("error")
  })

  it("章节读取循环中用户取消：静默返回", async () => {
    const controller = new AbortController()
    controller.abort()
    const { result, props } = renderRecognitionHook({ chapterSelectionData: makeData({ abortController: controller }) })
    await act(async () => {
      await result.current.handleChapterSelectionConfirm(["c1", "c2"])
    })
    expect(mocks.llmRecognizeCharacters).not.toHaveBeenCalled()
    expect(props.setRecognitionStatus).not.toHaveBeenCalledWith("error")
    expect(props.setRecognitionError).not.toHaveBeenCalled()
    expect(mocks.toast.error).not.toHaveBeenCalled()
  })

  it("LLM 返回后用户取消：静默返回", async () => {
    const controller = new AbortController()
    mocks.llmRecognizeCharacters.mockImplementation(async () => {
      controller.abort()
      return recognized
    })
    const { result, props } = renderRecognitionHook({ chapterSelectionData: makeData({ abortController: controller }) })
    await act(async () => {
      await result.current.handleChapterSelectionConfirm(["c1", "c2"])
    })
    expect(mocks.saveRecognizedCharacters).not.toHaveBeenCalled()
    expect(props.setRecognizedCharacters).not.toHaveBeenCalled()
    expect(props.setRecognitionStatus).not.toHaveBeenCalledWith("done")
    expect(props.setRecognitionStatus).not.toHaveBeenCalledWith("error")
    expect(mocks.toast.error).not.toHaveBeenCalled()
  })

  it("非 Error 抛出时按「识别失败」兜底", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    mocks.readFile.mockRejectedValue("boom-string")
    const { result, props } = renderRecognitionHook()
    await act(async () => {
      await result.current.handleChapterSelectionConfirm(["c1"])
    })
    expect(props.setRecognitionError).toHaveBeenCalledWith("识别失败")
    expect(props.setRecognitionStatus).toHaveBeenCalledWith("error")
    expect(mocks.toast.error).toHaveBeenCalledWith("角色识别失败：识别失败")
    expect(errorSpy).toHaveBeenCalled()
    errorSpy.mockRestore()
  })

  it("超时错误追加超时提示文案", async () => {
    mocks.readFile.mockRejectedValue(new Error("request timed out"))
    const { result, props } = renderRecognitionHook()
    await act(async () => {
      await result.current.handleChapterSelectionConfirm(["c1"])
    })
    expect(props.setRecognitionError).toHaveBeenCalledWith(
      "request timed out（请求超时：可少选几章、或更换更快 / 更稳定的模型后重试）",
    )
    expect(props.setRecognitionStatus).toHaveBeenCalledWith("error")
  })

  it("普通错误透传 message", async () => {
    mocks.readFile.mockRejectedValue(new Error("boom"))
    const { result, props } = renderRecognitionHook()
    await act(async () => {
      await result.current.handleChapterSelectionConfirm(["c1"])
    })
    expect(props.setRecognitionError).toHaveBeenCalledWith("boom")
    expect(props.setRecognitionStatus).toHaveBeenCalledWith("error")
  })

  // ── 勾选交互 ───────────────────────────────────────────────────────────────────

  it("toggle 角色：已勾选则移除，未勾选则追加", () => {
    const { result, props } = renderRecognitionHook({ selectedCharacterIds: ["r1"] })
    act(() => result.current.handleToggleCharacter("r1"))
    expect(props.setSelectedCharacterIds).toHaveBeenCalledWith([])
    act(() => result.current.handleToggleCharacter("r2"))
    expect(props.setSelectedCharacterIds).toHaveBeenCalledWith(["r1", "r2"])
  })

  it("全选主角配角（过滤掉次要角色）", () => {
    const { result, props } = renderRecognitionHook({ recognizedCharacters: recognized })
    act(() => result.current.handleSelectAllMain())
    expect(props.setSelectedCharacterIds).toHaveBeenCalledWith(["r1", "r2"])
  })

  it("清空选择", () => {
    const { result, props } = renderRecognitionHook()
    act(() => result.current.handleClearSelection())
    expect(props.setSelectedCharacterIds).toHaveBeenCalledWith([])
  })
})
