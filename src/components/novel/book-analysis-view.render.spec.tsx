// @vitest-environment jsdom
/**
 * BookAnalysisView 渲染级覆盖（W4F2 战役）。
 * 目标：src/components/novel/book-analysis-view.tsx 四维全口径补满。
 * 策略：vi.mock store / hooks / 子组件 / 外部依赖，断言对照源码实现。
 */
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest"
import { cleanup } from "@testing-library/react"
import { act, fireEvent, render, screen, waitFor } from "@/test-helpers/component-test-utils"
import { BookAnalysisView } from "./book-analysis-view"
import type {
  BookAnalysisConfig,
  BookAnalysisMetadata,
  BookAnalysisProgress,
  BookAnalysisResult,
  RecognizedCharacter,
} from "@/lib/novel/book-analysis/types"
import type { SplitChaptersResult } from "@/lib/novel/book-analysis/analysis-engine"
import type { ChapterSelectionData, UseCharacterExtractionParams } from "./hooks/use-character-extraction"

const CH1 = { id: "ch-1", title: "第一章", order: 1, wordCount: 1000, path: "/p/book-analysis/book-1/chapters/ch-1.md" }
const CH2 = { id: "ch-2", title: "第二章", order: 2, wordCount: 1200, path: "/p/book-analysis/book-1/chapters/ch-2.md" }

const mocks = vi.hoisted(() => {
  const baState: {
    tasks: unknown[]
    selectedLibraryBookId: string | null
    sidebarRefreshCounter: number
    pendingRecognitionTaskId: string | null
    recognitionStatus: string
    recognizedCharacters: unknown[]
    selectedCharacterIds: string[]
    recognitionError: unknown
    showResultViewer: boolean
    currentResult: unknown
    startTask: Mock<(projectPath: string, config: BookAnalysisConfig, abortController?: AbortController) => string>
    cancelTask: Mock<(taskId: string) => void>
    setShowResultViewer: Mock<(show: boolean) => void>
    setRecognitionStatus: Mock<(status: "idle" | "heuristic" | "llm_scoring" | "llm_recognizing" | "done" | "error") => void>
    setRecognizedCharacters: Mock<(characters: RecognizedCharacter[]) => void>
    setSelectedCharacterIds: Mock<(ids: string[]) => void>
    setRecognitionError: Mock<(error?: string) => void>
    clearRecognition: Mock<() => void>
    consumeReopenRequest: Mock<() => string | null>
    setCurrentResult: Mock<(result: BookAnalysisResult | null) => void>
    updateTaskProgress: Mock<(taskId: string, progress: Partial<BookAnalysisProgress>) => void>
    updateTaskMetadata: Mock<(taskId: string, metadata: BookAnalysisMetadata) => void>
    updateTaskBookData: Mock<(taskId: string, bookId: string, chapters: unknown[], bookPath?: string) => void>
    triggerSidebarRefresh: Mock<() => void>
    errorTask: Mock<(taskId: string, error: string) => void>
  } = {
    tasks: [],
    selectedLibraryBookId: null,
    sidebarRefreshCounter: 0,
    pendingRecognitionTaskId: null,
    recognitionStatus: "idle",
    recognizedCharacters: [],
    selectedCharacterIds: [],
    recognitionError: undefined,
    showResultViewer: false,
    currentResult: null,
    startTask: vi.fn<(projectPath: string, config: BookAnalysisConfig, abortController?: AbortController) => string>(() => "task-1"),
    cancelTask: vi.fn<(taskId: string) => void>(),
    setShowResultViewer: vi.fn<(show: boolean) => void>((v: unknown) => {
      baState.showResultViewer = v as boolean
    }),
    setRecognitionStatus: vi.fn<(status: "idle" | "heuristic" | "llm_scoring" | "llm_recognizing" | "done" | "error") => void>(),
    setRecognizedCharacters: vi.fn<(characters: RecognizedCharacter[]) => void>(),
    setSelectedCharacterIds: vi.fn<(ids: string[]) => void>(),
    setRecognitionError: vi.fn<(error?: string) => void>(),
    clearRecognition: vi.fn<() => void>(),
    consumeReopenRequest: vi.fn<() => string | null>(),
    setCurrentResult: vi.fn<(result: BookAnalysisResult | null) => void>((r: unknown) => {
      baState.currentResult = r
    }),
    updateTaskProgress: vi.fn<(taskId: string, progress: Partial<BookAnalysisProgress>) => void>(),
    updateTaskMetadata: vi.fn<(taskId: string, metadata: BookAnalysisMetadata) => void>(),
    updateTaskBookData: vi.fn<(taskId: string, bookId: string, chapters: unknown[], bookPath?: string) => void>(),
    triggerSidebarRefresh: vi.fn<() => void>(),
    errorTask: vi.fn<(taskId: string, error: string) => void>(),
  }
  const wikiState: Record<string, unknown> = {
    project: null,
    llmConfig: {
      provider: "openai",
      apiKey: "k",
      model: "m",
      ollamaUrl: "http://127.0.0.1:11434",
      customEndpoint: "",
      maxContextSize: 204800,
    },
    aiChatModel: null,
    providerConfigs: {},
  }
  const libraryBooks: unknown[] = []
  const reloadLibraryState = vi.fn(async () => {})
  const splitNovelIntoChapters = vi.fn<(sourcePath: string, projectPath: string, llmConfig: unknown, onProgress?: (progress: unknown) => void, signal?: AbortSignal) => Promise<SplitChaptersResult>>(async () => ({ success: false, bookId: "", bookPath: "", metadata: { title: "", totalChapters: 0, totalWords: 0, sourceType: "file", createdAt: 0, updatedAt: 0 }, chapters: [] }))
  const toastSuccess = vi.fn()
  const toastError = vi.fn()
  const toastInfo = vi.fn()
  const resolveModelConfig = vi.fn((target: string, base: Record<string, unknown>) => ({ ...base, model: target }))
  const toBookAnalysisResult = vi.fn((book: { id?: string } | null) => ({ bookId: book?.id }))
  const handleLibraryExtractStyle = vi.fn()
  const handleLibraryToggleStyle = vi.fn()
  const handleLibraryAddSkillsToSoul = vi.fn()
  const handleLibraryDeleteBook = vi.fn()
  const handleLibraryReextractCharacters = vi.fn()
  const handleChapterSelectionConfirm = vi.fn()
  const handleToggleCharacter = vi.fn()
  const handleSelectAllMain = vi.fn()
  const handleClearSelection = vi.fn()
  const handleDeepExtract = vi.fn()
  const handleSimpleExtract = vi.fn()
  const handleResumeFailedExtraction = vi.fn()
  const useLibraryOperations = vi.fn((params: { setLibraryState: (s: unknown) => void }) => {
    reloadLibraryState.mockImplementation(async () => {
      params.setLibraryState({ books: [...libraryBooks], enabledStyle: null, bindings: [] })
    })
    return {
      styleExtracting: false,
      addingToSoul: false,
      reloadLibraryState,
      handleLibraryExtractStyle,
      handleLibraryToggleStyle,
      handleLibraryAddSkillsToSoul,
      handleLibraryDeleteBook,
      handleLibraryReextractCharacters,
    }
  })
  const useCharacterRecognition = vi.fn(() => ({
    handleChapterSelectionConfirm,
    handleToggleCharacter,
    handleSelectAllMain,
    handleClearSelection,
  }))
  const useCharacterExtraction = vi.fn<(params: UseCharacterExtractionParams) => { extracting: boolean; handleDeepExtract: () => Promise<void>; handleSimpleExtract: () => Promise<void>; handleResumeFailedExtraction: (taskId: string) => Promise<void> }>(() => ({
    extracting: false,
    handleDeepExtract,
    handleSimpleExtract,
    handleResumeFailedExtraction,
  }))
  return {
    baState,
    wikiState,
    libraryBooks,
    reloadLibraryState,
    splitNovelIntoChapters,
    toastSuccess,
    toastError,
    toastInfo,
    resolveModelConfig,
    toBookAnalysisResult,
    handleLibraryExtractStyle,
    handleLibraryToggleStyle,
    handleLibraryAddSkillsToSoul,
    handleLibraryDeleteBook,
    handleLibraryReextractCharacters,
    handleChapterSelectionConfirm,
    handleToggleCharacter,
    handleSelectAllMain,
    handleClearSelection,
    handleDeepExtract,
    handleSimpleExtract,
    handleResumeFailedExtraction,
    useLibraryOperations,
    useCharacterRecognition,
    useCharacterExtraction,
  }
})

vi.mock("@/stores/wiki-store", () => ({
  useWikiStore: Object.assign(
    (selector: (s: Record<string, unknown>) => unknown) => selector(mocks.wikiState),
    { getState: () => mocks.wikiState },
  ),
}))

vi.mock("@/stores/book-analysis-store", () => ({
  useBookAnalysisStore: Object.assign(
    (selector: (s: Record<string, unknown>) => unknown) => selector(mocks.baState),
    { getState: () => mocks.baState },
  ),
}))

vi.mock("@/lib/novel/model-resolver", () => ({
  resolveModelConfig: mocks.resolveModelConfig,
}))

vi.mock("@/lib/novel/book-analysis/library-state", () => ({
  toBookAnalysisResult: mocks.toBookAnalysisResult,
}))

vi.mock("@/lib/toast", () => ({
  toast: { success: mocks.toastSuccess, error: mocks.toastError, info: mocks.toastInfo },
}))

vi.mock("@/lib/novel/book-analysis/analysis-engine", () => ({
  splitNovelIntoChapters: mocks.splitNovelIntoChapters,
}))

vi.mock("./hooks/use-library-operations", () => ({
  useLibraryOperations: mocks.useLibraryOperations,
}))

vi.mock("./hooks/use-character-recognition", () => ({
  useCharacterRecognition: mocks.useCharacterRecognition,
}))

vi.mock("./hooks/use-character-extraction", () => ({
  useCharacterExtraction: mocks.useCharacterExtraction,
}))

vi.mock("./book-analysis-library-layout", () => ({
  BookAnalysisLibraryLayout: (props: Record<string, unknown>) => (
    <div data-testid="library-layout">
      <span data-testid="layout-books">{String((props.state as { books: unknown[] }).books.length)}</span>
      <span data-testid="layout-selected">{String(props.selectedBookId)}</span>
      <span data-testid="layout-character">{String(props.selectedCharacterId)}</span>
      <span data-testid="layout-extracting-style">{String(props.extractingStyle)}</span>
      <span data-testid="layout-extracting-chars">{String(props.extractingCharacters)}</span>
      <span data-testid="layout-adding-soul">{String(props.addingToSoul)}</span>
      <button data-testid="layout-import" onClick={() => (props.onImportNovel as () => void)()}>import</button>
      <button data-testid="layout-select-book" onClick={() => (props.onSelectBook as (id: string) => void)("book-1")}>select</button>
      <button data-testid="layout-select-missing" onClick={() => (props.onSelectBook as (id: string) => void)("missing")}>select-missing</button>
      <button data-testid="layout-delete" onClick={() => (props.onDeleteBook as (id: string) => void)("book-1")}>delete</button>
      <button data-testid="layout-extract-style" onClick={() => (props.onExtractStyle as () => void)()}>extract-style</button>
      <button data-testid="layout-toggle-style" onClick={() => (props.onToggleStyle as () => void)()}>toggle-style</button>
      <button data-testid="layout-add-skill" onClick={() => (props.onAddSelectedSkillsToSoul as (id: string) => void)("skill-1")}>add-skill</button>
      <button data-testid="layout-reextract" onClick={() => (props.onReextractCharacters as () => void)()}>reextract</button>
    </div>
  ),
}))

vi.mock("./book-analysis-input-dialog", () => ({
  BookAnalysisInputDialog: (props: Record<string, unknown>) => (
    <div data-testid="input-dialog">
      <span data-testid="dialog-open">{String(props.open)}</span>
      <button
        data-testid="dialog-submit"
        onClick={() =>
          (props.onSubmit as (c: { sourceType: "file"; sourcePath: string }) => void)({
            sourceType: "file",
            sourcePath: "/tmp/book.txt",
          })
        }
      >
        submit
      </button>
      <button data-testid="dialog-close" onClick={() => (props.onOpenChange as (o: boolean) => void)(false)}>close</button>
    </div>
  ),
}))

vi.mock("./book-analysis-result-viewer", () => ({
  BookAnalysisResultViewer: (props: Record<string, unknown>) => (
    <div data-testid="result-viewer">
      <span data-testid="viewer-path">{String(props.projectPath)}</span>
      <span data-testid="viewer-has-result">{String(props.result !== null)}</span>
      <button data-testid="viewer-close" onClick={() => (props.onClose as () => void)()}>close</button>
    </div>
  ),
}))

vi.mock("./chapter-selection-panel", () => ({
  ChapterSelectionPanel: (props: Record<string, unknown>) => (
    <div data-testid="chapter-panel">
      <span data-testid="panel-chapters">{String((props.chapters as unknown[]).length)}</span>
      <span data-testid="panel-phase">{String(props.extractionPhase)}</span>
      <span data-testid="panel-has-extracted">{String(props.hasExtractedCharacters)}</span>
      <span data-testid="panel-progress">{String(JSON.stringify(props.extractionProgress))}</span>
      <span data-testid="panel-status">{String(props.recognitionStatus)}</span>
      <button data-testid="panel-cancel" onClick={() => (props.onCancel as () => void)()}>cancel</button>
      <button data-testid="panel-background" onClick={() => (props.onBackground as () => void)()}>background</button>
      <button
        data-testid="panel-load"
        onClick={() => (props.onLoadExtractedCharacters as (ids: string[]) => void)(["ch-1", "ch-2"])}
      >
        load
      </button>
      <button data-testid="panel-analyzing-true" onClick={() => (props.onAnalyzingChange as (a: boolean) => void)(true)}>
        an-true
      </button>
      <button data-testid="panel-analyzing-false" onClick={() => (props.onAnalyzingChange as (a: boolean) => void)(false)}>
        an-false
      </button>
      <button data-testid="panel-confirm" onClick={() => (props.onConfirm as (ids: string[]) => void)(["ch-1"])}>
        confirm
      </button>
      <button data-testid="panel-deep" onClick={() => (props.onDeepExtract as () => void)()}>deep</button>
    </div>
  ),
}))

const PROJECT = { id: "p1", name: "P", path: "/p/x" }
const METADATA: BookAnalysisMetadata = { title: "Book A", totalChapters: 2, totalWords: 2200, sourceType: "file", createdAt: 1, updatedAt: 2 }
const SPLIT_FAILURE: SplitChaptersResult = { success: false, bookId: "", bookPath: "", metadata: { title: "", totalChapters: 0, totalWords: 0, sourceType: "file", createdAt: 0, updatedAt: 0 }, chapters: [] }
const EMPTY_CHAPTER_SELECTION: ChapterSelectionData = {
  taskId: "",
  bookPath: "",
  chapters: [],
  metadata: METADATA,
  abortController: new AbortController(),
  selectedChapterIds: [],
  depth: "deep",
}

function makeTask(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "task-1",
    projectPath: "/p/x",
    bookId: "book-1",
    bookPath: "/p/book-analysis/book-1",
    config: { sourceType: "file", sourcePath: "/tmp/book.txt", selectedChapters: [] },
    metadata: METADATA,
    progress: { stage: "reading_file", stageLabel: "读取文件中", completed: 0, total: 100, percentage: 0 },
    status: "running",
    startedAt: 1,
    updatedAt: 1,
    chapters: [CH1, CH2],
    characters: [],
    skills: [],
    ...overrides,
  }
}

function makeBook(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "book-1",
    path: "/p/book-analysis/book-1",
    metadata: METADATA,
    recognizedCharacters: [],
    characters: [],
    skills: [],
    styleStatus: "missing",
    boundAurasCount: 0,
    addedAuraCharacterIds: [],
    ...overrides,
  }
}

const RC_A = { id: "rc-a", name: "主角A", aliases: ["A"], appearances: 10, chapterIndices: [0], importanceScore: 9, category: "主角", sourceBook: "/p/book-analysis/book-1" }
const RC_B = { id: "rc-b", name: "配角B", aliases: [], appearances: 5, chapterIndices: [0], importanceScore: 6, category: "配角", sourceBook: "/p/book-analysis/book-1" }
const RC_C = { id: "rc-c", name: "次要C", aliases: undefined, appearances: 2, chapterIndices: [1], importanceScore: 3, category: "次要", sourceBook: "/p/book-analysis/book-1" }

const EX_P = { id: "ex-p", name: "主角A", aliases: undefined, importance: 9, category: "protagonist", firstAppearance: 1, lastAppearance: 2, appearanceCount: 10, description: "", personality: "", speechStyle: "", relationships: [], keyEvents: [] }
const EX_S = { id: "ex-s", name: "配角B", aliases: [], importance: 6, category: "supporting", firstAppearance: 1, lastAppearance: 2, appearanceCount: 5, description: "", personality: "", speechStyle: "", relationships: [], keyEvents: [] }
const EX_M = { id: "ex-m", name: "次要C", aliases: [], importance: 3, category: "minor", firstAppearance: 2, lastAppearance: 2, appearanceCount: 2, description: "", personality: "", speechStyle: "", relationships: [], keyEvents: [] }

function mockAnalysisSuccess(bookPath = "/p/book-analysis/book-1"): void {
  mocks.splitNovelIntoChapters.mockImplementation(
    async (_path: string, _proj: string, _cfg: unknown, onProgress?: (p: Record<string, unknown>) => void) => {
      onProgress?.({
        stage: "extracting_characters",
        stageLabel: "提取角色中",
        completed: 1,
        total: 2,
        percentage: 50,
        currentItem: "角色A",
      })
      return { success: true, metadata: METADATA, bookId: "book-1", bookPath, chapters: [CH1, CH2] }
    },
  )
}

async function flushAsync(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

async function clickAndFlush(testId: string): Promise<void> {
  fireEvent.click(screen.getByTestId(testId))
  await flushAsync()
}

describe("BookAnalysisView 渲染覆盖", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.baState.tasks = []
    mocks.baState.selectedLibraryBookId = null
    mocks.baState.pendingRecognitionTaskId = null
    mocks.baState.showResultViewer = false
    mocks.baState.currentResult = null
    mocks.baState.recognitionStatus = "idle"
    mocks.baState.recognizedCharacters = []
    mocks.baState.selectedCharacterIds = []
    mocks.baState.recognitionError = undefined
    mocks.wikiState.project = null
    mocks.wikiState.aiChatModel = null
    mocks.libraryBooks.length = 0
    mocks.splitNovelIntoChapters.mockResolvedValue(SPLIT_FAILURE)
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it("无任务无项目时渲染库布局欢迎分支（任务数为 0）", async () => {
    const first = render(<BookAnalysisView />)
    await flushAsync()
    expect(screen.getByTestId("library-layout")).toBeTruthy()
    expect(screen.getByTestId("layout-books")).toHaveTextContent("0")
    expect(screen.getByTestId("layout-selected")).toHaveTextContent("null")
    expect(screen.getByTestId("dialog-open")).toHaveTextContent("false")
    expect(screen.queryByTestId("chapter-panel")).toBeNull()
    expect(screen.queryByTestId("result-viewer")).toBeNull()
    expect(mocks.reloadLibraryState).toHaveBeenCalledTimes(1)
    first.unmount()

    // 有书但未选 → selectedLibraryBook 回退 books[0]
    mocks.libraryBooks.push(makeBook())
    const second = render(<BookAnalysisView />)
    await flushAsync()
    expect(screen.getByTestId("layout-books")).toHaveTextContent("1")
    expect(screen.getByTestId("layout-selected")).toHaveTextContent("book-1")
    second.unmount()
  })

  it("导入对话框 open/close 由 onOpenChange 驱动", async () => {
    render(<BookAnalysisView />)
    await flushAsync()
    await clickAndFlush("layout-import")
    expect(screen.getByTestId("dialog-open")).toHaveTextContent("true")
    await clickAndFlush("dialog-close")
    expect(screen.getByTestId("dialog-open")).toHaveTextContent("false")
  })

  it("handleStartAnalysis 无项目时不启动任务并 console.error", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    render(<BookAnalysisView />)
    await flushAsync()
    await clickAndFlush("dialog-submit")
    expect(mocks.baState.startTask).not.toHaveBeenCalled()
    expect(errorSpy).toHaveBeenCalledWith("没有打开的项目")
  })

  it("handleStartAnalysis 成功：startTask + 进度回调 + 元数据回填 + 打开章节面板", async () => {
    mocks.wikiState.project = PROJECT
    mocks.baState.tasks = [makeTask()]
    mockAnalysisSuccess()
    render(<BookAnalysisView />)
    await flushAsync()

    await clickAndFlush("dialog-submit")

    expect(mocks.baState.startTask).toHaveBeenCalledWith(
      "/p/x",
      { sourceType: "file", sourcePath: "/tmp/book.txt", selectedChapters: [] },
      expect.any(AbortController),
    )
    expect(mocks.baState.clearRecognition).toHaveBeenCalled()
    expect(screen.getByTestId("dialog-open")).toHaveTextContent("false")

    await waitFor(() => expect(mocks.baState.updateTaskMetadata).toHaveBeenCalledWith("task-1", METADATA))
    expect(mocks.baState.updateTaskBookData).toHaveBeenCalledWith("task-1", "book-1", [CH1, CH2], "/p/book-analysis/book-1")
    expect(mocks.baState.triggerSidebarRefresh).toHaveBeenCalled()
    expect(mocks.reloadLibraryState).toHaveBeenCalled()
    expect(mocks.baState.updateTaskProgress).toHaveBeenCalledWith("task-1", {
      stage: "extracting_characters",
      stageLabel: "提取角色中",
      completed: 1,
      total: 2,
      percentage: 50,
      currentItem: "角色A",
    })
    // 面板打开（tasks>0 分支），extractionPhase 默认 null，hasExtractedCharacters 待库状态
    expect(screen.getByTestId("panel-chapters")).toHaveTextContent("2")
    expect(screen.getByTestId("panel-phase")).toHaveTextContent("null")
    expect(screen.getByTestId("layout-extracting-chars")).toHaveTextContent("true")
  })

  it("handleStartAnalysis 失败：非取消错误走 errorTask，取消类错误被吞", async () => {
    mocks.wikiState.project = PROJECT
    mocks.baState.tasks = [makeTask()]
    mocks.splitNovelIntoChapters.mockRejectedValue(new Error("boom"))
    render(<BookAnalysisView />)
    await flushAsync()
    await clickAndFlush("dialog-submit")
    await waitFor(() => expect(mocks.baState.errorTask).toHaveBeenCalledWith("task-1", "boom"))

    mocks.baState.errorTask.mockClear()
    mocks.splitNovelIntoChapters.mockRejectedValue(new Error("用户取消分析"))
    await clickAndFlush("dialog-submit")
    await flushAsync()
    expect(mocks.baState.errorTask).not.toHaveBeenCalled()

    mocks.baState.errorTask.mockClear()
    mocks.splitNovelIntoChapters.mockRejectedValue(new Error("任务已停止"))
    await clickAndFlush("dialog-submit")
    await flushAsync()
    expect(mocks.baState.errorTask).not.toHaveBeenCalled()
  })

  it("splitResult.success=false 时不回填元数据也不打开面板", async () => {
    mocks.wikiState.project = PROJECT
    mocks.baState.tasks = [makeTask()]
    render(<BookAnalysisView />)
    await flushAsync()
    await clickAndFlush("dialog-submit")
    await flushAsync()
    expect(mocks.baState.updateTaskMetadata).not.toHaveBeenCalled()
    expect(mocks.baState.updateTaskBookData).not.toHaveBeenCalled()
    expect(screen.queryByTestId("chapter-panel")).toBeNull()
  })

  it("侧栏 selectedLibraryBookId 同步：置顶选中 / 清空回退 books[0]", async () => {
    mocks.libraryBooks.push(makeBook({ id: "book-1" }), makeBook({ id: "book-2", path: "/p/book-analysis/book-2" }))
    mocks.baState.selectedLibraryBookId = "book-2"
    const { rerender } = render(<BookAnalysisView />)
    await flushAsync()
    expect(screen.getByTestId("layout-selected")).toHaveTextContent("book-2")

    // 侧栏清空 → 重新从 libraryState 选 books[0]
    mocks.baState.selectedLibraryBookId = null
    rerender(<BookAnalysisView />)
    await flushAsync()
    expect(screen.getByTestId("layout-selected")).toHaveTextContent("book-1")
  })

  it("pendingRecognitionTaskId 恢复面板：任务完整时打开、abortController 缺省用 new AbortController", async () => {
    // 任务带 abortController
    mocks.baState.tasks = [makeTask({ id: "task-a", abortController: new AbortController() })]
    mocks.baState.pendingRecognitionTaskId = "task-a"
    render(<BookAnalysisView />)
    await flushAsync()
    expect(mocks.baState.consumeReopenRequest).toHaveBeenCalledTimes(2)
    expect(screen.getByTestId("panel-chapters")).toHaveTextContent("2")
  })

  it("pendingRecognitionTaskId 恢复面板：任务无 abortController 时新建", async () => {
    mocks.baState.tasks = [makeTask({ id: "task-b" })]
    mocks.baState.pendingRecognitionTaskId = "task-b"
    render(<BookAnalysisView />)
    await flushAsync()
    expect(mocks.baState.consumeReopenRequest).toHaveBeenCalledTimes(2)
    expect(screen.getByTestId("panel-chapters")).toHaveTextContent("2")
  })

  it("pendingRecognitionTaskId 恢复面板：任务数据不完整时 console.warn", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
    // 章节为空
    mocks.baState.tasks = [makeTask({ id: "task-c", chapters: [] })]
    mocks.baState.pendingRecognitionTaskId = "task-c"
    const { rerender } = render(<BookAnalysisView />)
    await flushAsync()
    expect(warnSpy).toHaveBeenCalledWith("[现在处理] 任务数据不完整，无法恢复面板", "task-c")
    expect(screen.queryByTestId("chapter-panel")).toBeNull()

    // 任务缺失
    warnSpy.mockClear()
    mocks.baState.tasks = []
    mocks.baState.pendingRecognitionTaskId = "task-x"
    rerender(<BookAnalysisView />)
    await flushAsync()
    // 源码：console.warn("[现在处理] 任务数据不完整，无法恢复面板", task?.id) —— 缺失任务 id 为 undefined
    expect(warnSpy).toHaveBeenCalledWith("[现在处理] 任务数据不完整，无法恢复面板", undefined)
  })

  it("pendingRecognitionTaskId 面板已打开时只消费请求不重复打开", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
    mocks.baState.tasks = [makeTask({ id: "task-d", abortController: new AbortController() })]
    mocks.baState.pendingRecognitionTaskId = "task-d"
    const { rerender } = render(<BookAnalysisView />)
    await flushAsync()
    expect(screen.getByTestId("panel-chapters")).toHaveTextContent("2")

    mocks.baState.pendingRecognitionTaskId = "task-d2"
    rerender(<BookAnalysisView />)
    await flushAsync()
    // 第 1 次：挂载打开面板；第 2 次：chapterSelectionData 变化重跑；第 3 次：新 pending 请求
    expect(mocks.baState.consumeReopenRequest).toHaveBeenCalledTimes(3)
    expect(warnSpy).not.toHaveBeenCalled()
    expect(screen.getByTestId("panel-chapters")).toHaveTextContent("2")
  })

  it("hasExtractedCharacters：库中已有识别角色时为 true；加载已提取角色走 recognizedCharacters", async () => {
    mocks.wikiState.project = PROJECT
    mocks.baState.tasks = [makeTask()]
    mocks.libraryBooks.push(makeBook({ recognizedCharacters: [RC_A, RC_B, RC_C] }))
    mockAnalysisSuccess()
    render(<BookAnalysisView />)
    await flushAsync()
    await clickAndFlush("dialog-submit")
    await waitFor(() => expect(screen.getByTestId("panel-chapters")).toBeTruthy())

    expect(screen.getByTestId("panel-has-extracted")).toHaveTextContent("true")
    await clickAndFlush("panel-load")
    expect(mocks.baState.setRecognizedCharacters).toHaveBeenCalledWith([RC_A, RC_B, RC_C])
    expect(mocks.baState.setSelectedCharacterIds).toHaveBeenCalledWith(["rc-a", "rc-b"])
    expect(mocks.baState.setRecognitionStatus).toHaveBeenCalledWith("done")
    expect(mocks.toastInfo).toHaveBeenCalledWith("已加载 3 个已提取的角色，可直接选择进行提取")
  })

  it("加载已提取角色：无 recognizedCharacters 时从 characters 回退映射", async () => {
    mocks.wikiState.project = PROJECT
    mocks.baState.tasks = [makeTask()]
    mocks.libraryBooks.push(makeBook({ recognizedCharacters: [], characters: [EX_P, EX_S, EX_M] }))
    mockAnalysisSuccess()
    render(<BookAnalysisView />)
    await flushAsync()
    await clickAndFlush("dialog-submit")
    await waitFor(() => expect(screen.getByTestId("panel-chapters")).toBeTruthy())
    expect(screen.getByTestId("panel-has-extracted")).toHaveTextContent("true")

    await clickAndFlush("panel-load")
    const mapped = mocks.baState.setRecognizedCharacters.mock.calls[0]?.[0]
    expect(mapped).toHaveLength(3)
    expect(mapped?.[0]).toMatchObject({ id: "ex-p", category: "主角", aliases: [], chapterIndices: [0], importanceScore: 9 })
    expect(mapped?.[1]).toMatchObject({ id: "ex-s", category: "配角" })
    expect(mapped?.[2]).toMatchObject({ id: "ex-m", category: "次要" })
    expect(mocks.baState.setSelectedCharacterIds).toHaveBeenCalledWith(["ex-p", "ex-s"])
    expect(mocks.toastInfo).toHaveBeenCalledWith("已加载 3 个已提取的角色，可直接选择进行提取")
  })

  it("加载已提取角色：库中没有该书或角色为空时 toast 提示", async () => {
    mocks.wikiState.project = PROJECT
    mocks.baState.tasks = [makeTask()]
    mockAnalysisSuccess()
    render(<BookAnalysisView />)
    await flushAsync()
    await clickAndFlush("dialog-submit")
    await waitFor(() => expect(screen.getByTestId("panel-chapters")).toBeTruthy())
    expect(screen.getByTestId("panel-has-extracted")).toHaveTextContent("false")

    await clickAndFlush("panel-load")
    expect(mocks.toastInfo).toHaveBeenCalledWith("没有已提取的角色")
  })

  it("加载已提取角色：bookPath 缺失时直接返回", async () => {
    mocks.wikiState.project = PROJECT
    mocks.baState.tasks = [makeTask()]
    mockAnalysisSuccess(null as unknown as string)
    render(<BookAnalysisView />)
    await flushAsync()
    await clickAndFlush("dialog-submit")
    await waitFor(() => expect(screen.getByTestId("panel-chapters")).toBeTruthy())
    expect(screen.getByTestId("panel-has-extracted")).toHaveTextContent("false")
    await clickAndFlush("panel-load")
    expect(mocks.toastInfo).not.toHaveBeenCalled()
  })

  it("章节面板取消：cancelTask + 关闭面板", async () => {
    mocks.wikiState.project = PROJECT
    mocks.baState.tasks = [makeTask()]
    mockAnalysisSuccess()
    render(<BookAnalysisView />)
    await flushAsync()
    await clickAndFlush("dialog-submit")
    await waitFor(() => expect(screen.getByTestId("panel-chapters")).toBeTruthy())
    await clickAndFlush("panel-cancel")
    expect(mocks.baState.cancelTask).toHaveBeenCalledWith("task-1")
    expect(screen.queryByTestId("chapter-panel")).toBeNull()
  })

  it("章节面板后台运行：toast 提示 + 关闭面板", async () => {
    mocks.wikiState.project = PROJECT
    mocks.baState.tasks = [makeTask()]
    mockAnalysisSuccess()
    render(<BookAnalysisView />)
    await flushAsync()
    await clickAndFlush("dialog-submit")
    await waitFor(() => expect(screen.getByTestId("panel-chapters")).toBeTruthy())
    await clickAndFlush("panel-background")
    expect(mocks.toastInfo).toHaveBeenCalledWith("任务已在后台运行，完成后会自动刷新")
    expect(screen.queryByTestId("chapter-panel")).toBeNull()
  })

  it("onAnalyzingChange 回调切换分析中状态", async () => {
    mocks.wikiState.project = PROJECT
    mocks.baState.tasks = [makeTask()]
    mockAnalysisSuccess()
    render(<BookAnalysisView />)
    await flushAsync()
    await clickAndFlush("dialog-submit")
    await waitFor(() => expect(screen.getByTestId("panel-chapters")).toBeTruthy())
    await clickAndFlush("panel-analyzing-true")
    await clickAndFlush("panel-analyzing-false")
  })

  it("onSelectBook：设置选中 + 清空角色选中 + 写入 currentResult；未知书不写 currentResult", async () => {
    mocks.libraryBooks.push(makeBook())
    render(<BookAnalysisView />)
    await flushAsync()
    await clickAndFlush("layout-select-book")
    expect(screen.getByTestId("layout-selected")).toHaveTextContent("book-1")
    expect(mocks.baState.clearRecognition).toHaveBeenCalled()
    expect(mocks.toBookAnalysisResult).toHaveBeenCalledWith(expect.objectContaining({ id: "book-1" }))
    expect(mocks.baState.setCurrentResult).toHaveBeenCalledWith({ bookId: "book-1" })

    await clickAndFlush("layout-select-missing")
    expect(mocks.baState.setCurrentResult).toHaveBeenCalledTimes(1)
    // 源码：侧栏 store 为空时重新从 libraryState 选择 books[0]
    expect(screen.getByTestId("layout-selected")).toHaveTextContent("book-1")
  })

  it("onSelectBook 时库为空：同步效果回退 books[0]?.id ?? null", async () => {
    render(<BookAnalysisView />)
    await flushAsync()
    await clickAndFlush("layout-select-book")
    // 源码：else 分支 setSelectedBookId(libraryState.books[0]?.id ?? null)
    expect(screen.getByTestId("layout-selected")).toHaveTextContent("null")
  })

  it("结果查看器：showResultViewer 打开、project 缺省路径为空、onClose 关闭", async () => {
    mocks.wikiState.project = PROJECT
    mocks.baState.showResultViewer = true
    const { rerender } = render(<BookAnalysisView />)
    await flushAsync()
    expect(screen.getByTestId("viewer-path")).toHaveTextContent("/p/x")

    await clickAndFlush("viewer-close")
    expect(mocks.baState.setShowResultViewer).toHaveBeenCalledWith(false)
    rerender(<BookAnalysisView />)
    await flushAsync()
    expect(screen.queryByTestId("result-viewer")).toBeNull()

    // 无项目时 projectPath 回退 ""
    mocks.wikiState.project = null
    mocks.baState.showResultViewer = true
    rerender(<BookAnalysisView />)
    await flushAsync()
    expect(screen.getByTestId("viewer-path")).toHaveTextContent("")
  })

  it("tasks>0 时任务分支渲染；extractionProgress 由任务进度计算（completed/error/缺失）", async () => {
    mocks.wikiState.project = PROJECT
    mocks.baState.tasks = [
      makeTask({ status: "completed", progress: { stage: "completed", stageLabel: "深度提取中", percentage: 33, currentItem: "角色B" } }),
    ]
    mockAnalysisSuccess()
    render(<BookAnalysisView />)
    await flushAsync()
    await clickAndFlush("dialog-submit")
    await waitFor(() => expect(screen.getByTestId("panel-chapters")).toBeTruthy())
    expect(screen.getByTestId("panel-progress")).toHaveTextContent("深度提取中")
    expect(screen.getByTestId("panel-progress")).toHaveTextContent('"isCompleted":true')
  })

  it("extractionProgress：任务 error 时携带 error 字段", async () => {
    mocks.wikiState.project = PROJECT
    mocks.baState.tasks = [makeTask({ status: "error", error: "boom" })]
    mockAnalysisSuccess()
    render(<BookAnalysisView />)
    await flushAsync()
    await clickAndFlush("dialog-submit")
    await waitFor(() => expect(screen.getByTestId("panel-chapters")).toBeTruthy())
    expect(screen.getByTestId("panel-progress")).toHaveTextContent('"error":"boom"')
  })

  it("extractionProgress：找不到任务时为 undefined", async () => {
    mocks.wikiState.project = PROJECT
    mocks.baState.tasks = [makeTask({ id: "other-task" })]
    mockAnalysisSuccess()
    render(<BookAnalysisView />)
    await flushAsync()
    await clickAndFlush("dialog-submit")
    await waitFor(() => expect(screen.getByTestId("panel-chapters")).toBeTruthy())
    expect(screen.getByTestId("panel-progress")).toHaveTextContent("undefined")
  })

  it("加载已提取角色：库中书按 path 匹配（id 不同）/ 书存在但角色为空 / 均不匹配", async () => {
    mocks.wikiState.project = PROJECT
    mocks.baState.tasks = [makeTask()]
    // 书 id 不同但 path 匹配 chapterSelectionData.bookPath
    mocks.libraryBooks.push(makeBook({ id: "book-1", path: "/p/book-analysis/book-9" }))
    mockAnalysisSuccess("/p/book-analysis/book-9")
    render(<BookAnalysisView />)
    await flushAsync()
    await clickAndFlush("dialog-submit")
    await waitFor(() => expect(screen.getByTestId("panel-chapters")).toBeTruthy())
    expect(screen.getByTestId("panel-has-extracted")).toHaveTextContent("false")
    await clickAndFlush("panel-load")
    expect(mocks.toastInfo).toHaveBeenCalledWith("没有已提取的角色")
    expect(mocks.toastInfo).toHaveBeenCalledTimes(1)

    // id 与 path 均不匹配：find 走完全部项后返回 undefined
    mockAnalysisSuccess("/p/book-analysis/book-x")
    await clickAndFlush("dialog-submit")
    await flushAsync()
    expect(screen.getByTestId("panel-has-extracted")).toHaveTextContent("false")
    await clickAndFlush("panel-load")
    expect(mocks.toastInfo).toHaveBeenCalledTimes(2)
  })

  it("pendingRecognitionTaskId 恢复面板：bookPath/metadata/chapters 缺失时分别 warn", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
    mocks.baState.tasks = [makeTask({ id: "t1", bookPath: undefined })]
    mocks.baState.pendingRecognitionTaskId = "t1"
    const { rerender } = render(<BookAnalysisView />)
    await flushAsync()
    expect(warnSpy).toHaveBeenCalledWith("[现在处理] 任务数据不完整，无法恢复面板", "t1")

    mocks.baState.tasks = [makeTask({ id: "t2", metadata: undefined })]
    mocks.baState.pendingRecognitionTaskId = "t2"
    rerender(<BookAnalysisView />)
    await flushAsync()
    expect(warnSpy).toHaveBeenCalledWith("[现在处理] 任务数据不完整，无法恢复面板", "t2")

    mocks.baState.tasks = [makeTask({ id: "t3", chapters: undefined })]
    mocks.baState.pendingRecognitionTaskId = "t3"
    rerender(<BookAnalysisView />)
    await flushAsync()
    expect(warnSpy).toHaveBeenCalledWith("[现在处理] 任务数据不完整，无法恢复面板", "t3")
  })

  it("handleStartAnalysis 非 Error 异常：错误消息回退为「分析失败」", async () => {
    mocks.wikiState.project = PROJECT
    mocks.baState.tasks = [makeTask()]
    mocks.splitNovelIntoChapters.mockRejectedValue("boom-string")
    render(<BookAnalysisView />)
    await flushAsync()
    await clickAndFlush("dialog-submit")
    await waitFor(() => expect(mocks.baState.errorTask).toHaveBeenCalledWith("task-1", "分析失败"))
  })

  it("深度提取阶段：extractionPhase 透传面板（chapterSelectionData.extractionPhase ?? null）", async () => {
    mocks.wikiState.project = PROJECT
    mocks.baState.tasks = [makeTask()]
    mockAnalysisSuccess()
    mocks.useCharacterExtraction.mockImplementation((params: UseCharacterExtractionParams) => ({
      extracting: false,
      handleDeepExtract: async () => {
        params.setChapterSelectionData((prev) => ({ ...(prev ?? EMPTY_CHAPTER_SELECTION), extractionPhase: "deep" }))
      },
      handleSimpleExtract: mocks.handleSimpleExtract,
      handleResumeFailedExtraction: mocks.handleResumeFailedExtraction,
    }))
    render(<BookAnalysisView />)
    await flushAsync()
    await clickAndFlush("dialog-submit")
    await waitFor(() => expect(screen.getByTestId("panel-chapters")).toBeTruthy())
    expect(screen.getByTestId("panel-phase")).toHaveTextContent("null")
    await clickAndFlush("panel-deep")
    expect(screen.getByTestId("panel-phase")).toHaveTextContent("deep")
  })

  it("tasks>0 主分支下查看器同样渲染并可关闭", async () => {
    mocks.wikiState.project = PROJECT
    mocks.baState.tasks = [makeTask()]
    mocks.baState.showResultViewer = true
    const { rerender } = render(<BookAnalysisView />)
    await flushAsync()
    expect(screen.getByTestId("viewer-path")).toHaveTextContent("/p/x")
    await clickAndFlush("viewer-close")
    expect(mocks.baState.setShowResultViewer).toHaveBeenCalledWith(false)
    rerender(<BookAnalysisView />)
    await flushAsync()
    expect(screen.queryByTestId("result-viewer")).toBeNull()

    // 无项目时主分支 projectPath 回退 ""（viewingResultPath ?? currentProject?.path ?? ""）
    mocks.wikiState.project = null
    mocks.baState.showResultViewer = true
    rerender(<BookAnalysisView />)
    await flushAsync()
    expect(screen.getByTestId("viewer-path")).toHaveTextContent("")
  })

  it("作品库操作回调接线：extract/toggle/add/delete/reextract 全部透传", async () => {
    mocks.libraryBooks.push(makeBook())
    render(<BookAnalysisView />)
    await flushAsync()
    await clickAndFlush("layout-extract-style")
    expect(mocks.handleLibraryExtractStyle).toHaveBeenCalledTimes(1)
    await clickAndFlush("layout-toggle-style")
    expect(mocks.handleLibraryToggleStyle).toHaveBeenCalledTimes(1)
    await clickAndFlush("layout-add-skill")
    expect(mocks.handleLibraryAddSkillsToSoul).toHaveBeenCalledWith("skill-1")
    await clickAndFlush("layout-reextract")
    expect(mocks.handleLibraryReextractCharacters).toHaveBeenCalledTimes(1)
    await clickAndFlush("layout-delete")
    // 源码：onDeleteBook={(bookId) => handleLibraryDeleteBook(bookId, selectedBookId)}，此时 selectedBookId 为 null
    expect(mocks.handleLibraryDeleteBook).toHaveBeenCalledWith("book-1", null)
  })

  it("章节确认回调接线：onConfirm 透传选中章节", async () => {
    mocks.wikiState.project = PROJECT
    mocks.baState.tasks = [makeTask()]
    mockAnalysisSuccess()
    render(<BookAnalysisView />)
    await flushAsync()
    await clickAndFlush("dialog-submit")
    await waitFor(() => expect(screen.getByTestId("panel-chapters")).toBeTruthy())
    await clickAndFlush("panel-confirm")
    expect(mocks.handleChapterSelectionConfirm).toHaveBeenCalledWith(["ch-1"])
  })

  it("aiChatModel 配置解析：有 aiChatModel 时走 resolveModelConfig，无则用 baseLlmConfig", async () => {
    mocks.wikiState.aiChatModel = "gpt-x"
    render(<BookAnalysisView />)
    await flushAsync()
    expect(mocks.resolveModelConfig).toHaveBeenCalledWith(
      "gpt-x",
      expect.objectContaining({ provider: "openai" }),
      mocks.wikiState.providerConfigs,
    )
    const hookParams = mocks.useLibraryOperations.mock.calls[0]?.[0] as Record<string, unknown>
    expect(hookParams.currentProjectPath).toBeNull()
    expect(hookParams.llmConfig).toMatchObject({ model: "gpt-x" })

    // 无 aiChatModel：llmConfig = baseLlmConfig，且 getState() 分支同样回退
    mocks.wikiState.aiChatModel = null
    const second = render(<BookAnalysisView />)
    await flushAsync()
    mocks.resolveModelConfig.mockClear()
    const hookParams2 = mocks.useLibraryOperations.mock.calls[1]?.[0] as Record<string, unknown>
    expect(hookParams2.llmConfig).toMatchObject({ provider: "openai" })
    second.rerender(<BookAnalysisView />)
    await flushAsync()
    expect(mocks.resolveModelConfig).not.toHaveBeenCalled()
    second.unmount()
  })

  it("加载已提取角色：路径分割的空数组回退为空 bookId", async () => {
    mocks.wikiState.project = PROJECT
    mocks.baState.tasks = [makeTask()]
    mocks.libraryBooks.push(makeBook({ id: "", recognizedCharacters: [RC_A] }))
    mockAnalysisSuccess()
    const originalSplit = String.prototype.split as (separator: string | RegExp, limit?: number) => string[]
    const splitSpy = vi.spyOn(String.prototype, "split").mockImplementation(function (this: string, separator?: string | RegExp | { [Symbol.split](string: string, limit?: number): string[] }, limit?: number) {
      if (this === "/p/book-analysis/book-1" && separator instanceof RegExp && String(separator) === "/[/\\\\]/") return [] as string[]
      return originalSplit.call(this, separator as string, limit)
    })
    render(<BookAnalysisView />)
    await flushAsync()
    await clickAndFlush("dialog-submit")
    await waitFor(() => expect(screen.getByTestId("chapter-panel")).toBeTruthy())
    expect(screen.getByTestId("panel-has-extracted")).toHaveTextContent("true")
    await clickAndFlush("panel-load")
    expect(mocks.baState.setRecognizedCharacters).toHaveBeenCalledWith([RC_A])
    splitSpy.mockRestore()
  })

  it("handleStartAnalysis 使用运行时 store 的 aiChatModel 解析 LLM 配置", async () => {
    mocks.wikiState.project = PROJECT
    mocks.wikiState.aiChatModel = "gpt-runtime"
    mocks.baState.tasks = [makeTask()]
    mockAnalysisSuccess()
    render(<BookAnalysisView />)
    await flushAsync()
    await clickAndFlush("dialog-submit")
    await waitFor(() => expect(mocks.baState.updateTaskMetadata).toHaveBeenCalledWith("task-1", METADATA))
    // 源码：storeState.aiChatModel ? resolveModelConfig(...) : storeState.llmConfig（运行时分支）
    expect(mocks.resolveModelConfig).toHaveBeenCalledWith(
      "gpt-runtime",
      expect.objectContaining({ provider: "openai" }),
      mocks.wikiState.providerConfigs,
    )
    expect(mocks.splitNovelIntoChapters).toHaveBeenCalledWith(
      "/tmp/book.txt",
      "/p/x",
      expect.objectContaining({ model: "gpt-runtime" }),
      expect.any(Function),
      expect.any(AbortSignal),
    )
  })

  it("所有现有行为回调均由章节面板接线承载", async () => {
    mocks.wikiState.project = PROJECT
    mocks.baState.tasks = [makeTask()]
    mockAnalysisSuccess()
    render(<BookAnalysisView />)
    await flushAsync()
    await clickAndFlush("dialog-submit")
    await waitFor(() => expect(screen.getByTestId("chapter-panel")).toBeTruthy())
    expect(screen.getByTestId("panel-status")).toHaveTextContent("idle")
  })
})

