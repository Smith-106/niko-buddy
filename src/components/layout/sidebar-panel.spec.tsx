// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { ReactNode } from "react"
import { cleanup } from "@testing-library/react"
import {
  act,
  fireEvent,
  render,
  screen,
  setupDomGlobals,
  userEvent,
  waitFor,
  within,
} from "@/test-helpers/component-test-utils"
import { DismantlingSidebarPanel, SidebarPanel } from "./sidebar-panel"
import type { FileNode } from "@/types/wiki"
import type { DismantlingChapter, DismantlingLibrary, DismantlingProject } from "@/lib/novel/dismantling"
import type {
  ChapterImportCandidate,
  ImportedChapter,
  ImportedChapterMemoryProgress,
  ImportedChapterMemoryResult,
} from "@/lib/novel/chapter-import"
import type { OutlineImportCandidate } from "@/lib/novel/outline-import"
import type { MemoryCenterData } from "@/lib/novel/memory-center"

interface ProjectLike {
  id: string
  name: string
  path: string
}

interface DismantlingProjectLike extends DismantlingProject {}

interface DismantlingLibraryLike extends DismantlingLibrary {
  version: 1
  selectedProjectId: string | null
}

interface WikiStateLike {
  project: ProjectLike | null
  activeView: string
  novelMode: boolean
  selectedFile: string | null
  selectedMemoryCenterEntry: string | null
  setSelectedMemoryCenterEntry: ReturnType<typeof vi.fn>
  setSelectedFile: ReturnType<typeof vi.fn>
  setFileTree: ReturnType<typeof vi.fn>
  dataVersion: number
  searchHistory: string[]
  setActiveView: ReturnType<typeof vi.fn>
  setSearchTrigger: ReturnType<typeof vi.fn>
  selectedDismantlingProjectId: string | null
  setSelectedDismantlingProjectId: ReturnType<typeof vi.fn>
  bumpDataVersion: ReturnType<typeof vi.fn>
}

const DEFAULT_PROJECT: ProjectLike = { id: "p1", name: "MyBook", path: "/p/mybook" }

function makeProject(id: string, title: string, chapterCount = 1, memoryCount = 0): DismantlingProjectLike {
  const now = Date.now()
  return {
    id,
    title,
    createdAt: now,
    updatedAt: now,
    chapters: Array.from({ length: chapterCount }, (_, i) => ({
      id: `chapter-${String(i + 1).padStart(3, "0")}`,
      chapterNumber: i + 1,
      title: `第${i + 1}章`,
      content: "正文",
      status: "pending",
    })),
    analyses: [],
    structureMemory: Array.from({ length: memoryCount }, (_, i) => `mem-${i}`),
    useInChat: false,
  }
}

function makeLibrary(projects: DismantlingProjectLike[]): DismantlingLibraryLike {
  return { version: 1, projects, selectedProjectId: projects[0]?.id ?? null }
}

const mocks = vi.hoisted(() => {
  const state: WikiStateLike = {
    project: null,
    activeView: "wiki",
    novelMode: true,
    selectedFile: null,
    selectedMemoryCenterEntry: null,
    setSelectedMemoryCenterEntry: vi.fn(),
    setSelectedFile: vi.fn(),
    setFileTree: vi.fn(),
    dataVersion: 0,
    searchHistory: [],
    setActiveView: vi.fn(),
    setSearchTrigger: vi.fn(),
    selectedDismantlingProjectId: null,
    setSelectedDismantlingProjectId: vi.fn(),
    bumpDataVersion: vi.fn(),
  }
  const getStateSnapshot: { bumpDataVersion: ReturnType<typeof vi.fn> } = {
    bumpDataVersion: vi.fn(),
  }
  const importProgressActions = {
    startTask: vi.fn(),
    updateTask: vi.fn(),
    finishTask: vi.fn(),
    markCancelling: vi.fn(),
    cancelTask: vi.fn(),
  }
  return {
    state,
    getStateSnapshot,
    importProgressActions,
    t: vi.fn((key: string) => key),
    // fs
    createDirectory: vi.fn<(path: string) => Promise<void>>(async () => {}),
    fileExists: vi.fn<(path: string) => Promise<boolean>>(async () => false),
    listDirectory: vi.fn<(path: string) => Promise<FileNode[]>>(async () => []),
    preprocessFile: vi.fn<(path: string) => Promise<string>>(async () => ""),
    readFile: vi.fn<(path: string) => Promise<string>>(async () => ""),
    writeFile: vi.fn<(path: string, contents: string) => Promise<void>>(async () => {}),
    // libs
    countChapterBodyWords: vi.fn<(markdown: string) => number>(() => 0),
    buildChapterTotalWordCountLabel: vi.fn<(n: number) => string>((n: number) => `total:${n}`),
    getFileName: vi.fn<(p: string) => string>((p: string) => p.split("/").pop() ?? p),
    getFileStem: vi.fn<(p: string) => string>((p: string) => (p.split("/").pop() ?? p).replace(/\.\w+$/, "")),
    normalizePath: vi.fn<(p: string) => string>((p: string) => p),
    flattenMdFiles: vi.fn<
      (nodes: Array<{ name: string; path: string; is_dir: boolean; children?: unknown[] }>) => Array<{ name: string; path: string }>
    >((nodes) => nodes.map(({ name, path }) => ({ name, path }))),
    getNextChapterNumber: vi.fn<(projectPath: string) => Promise<number>>(async () => 1),
    invalidateChapterCache: vi.fn<(projectPath?: string) => void>(() => {}),
    loadDismantlingLibrary: vi.fn<(projectPath: string) => Promise<DismantlingLibraryLike>>(async () => makeLibrary([])),
    normalizeDismantlingLibrary: vi.fn<(input: Partial<DismantlingLibrary> | null | undefined) => DismantlingLibraryLike>((input) => input as DismantlingLibraryLike),
    saveDismantlingLibrary: vi.fn<(projectPath: string, library: DismantlingLibrary) => Promise<void>>(async () => {}),
    splitDismantlingTextIntoChapters: vi.fn<(text: string) => DismantlingChapter[]>(() => []),
    sortChapterImportCandidates: vi.fn<(candidates: readonly ChapterImportCandidate[]) => ChapterImportCandidate[]>((c) => [...c]),
    makeChapterFileName: vi.fn<(title: string, n?: number | null) => string>((title: string, n?: number | null) => `chapter-${n ?? "?"}-${title}.md`),
    makeDefaultChapterTitle: vi.fn<(n: number) => string>((n: number) => `第${n}章`),
    makeSafeFileSlug: vi.fn<(title: string) => string>((title: string) => title),
    collectChapterImportCandidatesFromFolder: vi.fn<(selectedFolder: string) => Promise<ChapterImportCandidate[]>>(async () => []),
    collectOutlineImportCandidatesFromFolder: vi.fn<(selectedFolder: string) => Promise<OutlineImportCandidate[]>>(async () => []),
    importChapterFiles: vi.fn<
      (projectPath: string, sourcePaths: readonly string[], options: { finalForMemoryExtraction: boolean }) => Promise<ImportedChapter[]>
    >(async () => []),
    importOutlineCandidates: vi.fn<(projectPath: string, candidates: readonly OutlineImportCandidate[]) => Promise<string[]>>(async () => []),
    importOutlineFiles: vi.fn<(projectPath: string, sourcePaths: string[]) => Promise<string[]>>(async () => []),
    runImportedChapterMemoryExtraction: vi.fn<
      (args: {
        projectPath: string
        chapterPaths: readonly string[]
        signal?: AbortSignal
        reviewModel?: string
        ingestChapter: (projectPath: string, chapterPath: string, reviewModel?: string) => Promise<{ snapshot: unknown | null; failReason?: string }>
        onProgress?: (progress: ImportedChapterMemoryProgress) => void
      }) => Promise<ImportedChapterMemoryResult>
    >(async () => ({ cancelled: false, completed: 0, failed: 0, errors: [] })),
    runOutlineIngestTask: vi.fn<(taskId: string) => Promise<void>>(async () => {}),
    createOutlineIngestTask: vi.fn<(projectPath: string, outlinePath: string) => string>((_p: string, path: string) => `outline-task:${path}`),
    ingestChapter: vi.fn<
      (projectPath: string, chapterPath: string, reviewModel?: string) => Promise<{ snapshot: unknown | null; failReason?: string }>
    >(async () => ({ snapshot: null })),
    loadMemoryCenterData: vi.fn<(projectPath: string) => Promise<MemoryCenterData | null>>(async () => null),
    openExternalUrl: vi.fn<(url: string) => Promise<void>>(async () => {}),
    dialogOpen: vi.fn<(options?: unknown) => Promise<unknown>>(async () => null),
    CHAPTER_IMPORT_EXTENSIONS: ["txt", "md", "mdx", "doc", "docx"],
    OUTLINE_IMPORT_EXTENSIONS: ["md", "mdx"],
  }
})

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: mocks.t }),
}))

vi.mock("@/stores/wiki-store", () => ({
  useWikiStore: Object.assign(
    (selector: (s: WikiStateLike) => unknown) => selector(mocks.state),
    { getState: () => mocks.getStateSnapshot },
  ),
}))

vi.mock("@/stores/import-progress-store", () => ({
  useImportProgressStore: Object.assign(
    (selector: (s: unknown) => unknown) => selector({}),
    { getState: () => mocks.importProgressActions },
  ),
}))

vi.mock("@/commands/fs", () => ({
  createDirectory: mocks.createDirectory,
  fileExists: mocks.fileExists,
  listDirectory: mocks.listDirectory,
  preprocessFile: mocks.preprocessFile,
  readFile: mocks.readFile,
  writeFile: mocks.writeFile,
}))

vi.mock("@/lib/chapter-word-count", () => ({
  countChapterBodyWords: mocks.countChapterBodyWords,
}))

vi.mock("@/lib/chapter-display", () => ({
  buildChapterTotalWordCountLabel: mocks.buildChapterTotalWordCountLabel,
}))

vi.mock("@/lib/path-utils", () => ({
  getFileName: mocks.getFileName,
  getFileStem: mocks.getFileStem,
  normalizePath: mocks.normalizePath,
}))

vi.mock("@/lib/novel/dismantling", () => ({
  loadDismantlingLibrary: mocks.loadDismantlingLibrary,
  normalizeDismantlingLibrary: mocks.normalizeDismantlingLibrary,
  saveDismantlingLibrary: mocks.saveDismantlingLibrary,
  splitDismantlingTextIntoChapters: mocks.splitDismantlingTextIntoChapters,
}))

vi.mock("@/lib/novel/chapter-utils", () => ({
  flattenMdFiles: mocks.flattenMdFiles,
  getNextChapterNumber: mocks.getNextChapterNumber,
  invalidateChapterCache: mocks.invalidateChapterCache,
}))

vi.mock("@/lib/novel/outline-import", () => ({
  OUTLINE_IMPORT_EXTENSIONS: mocks.OUTLINE_IMPORT_EXTENSIONS,
  collectOutlineImportCandidatesFromFolder: mocks.collectOutlineImportCandidatesFromFolder,
  importOutlineCandidates: mocks.importOutlineCandidates,
  importOutlineFiles: mocks.importOutlineFiles,
}))

vi.mock("@/lib/novel/chapter-import", () => ({
  CHAPTER_IMPORT_EXTENSIONS: mocks.CHAPTER_IMPORT_EXTENSIONS,
  collectChapterImportCandidatesFromFolder: mocks.collectChapterImportCandidatesFromFolder,
  importChapterFiles: mocks.importChapterFiles,
  runImportedChapterMemoryExtraction: mocks.runImportedChapterMemoryExtraction,
  sortChapterImportCandidates: mocks.sortChapterImportCandidates,
}))

vi.mock("@/lib/wiki-filename", () => ({
  makeChapterFileName: mocks.makeChapterFileName,
  makeDefaultChapterTitle: mocks.makeDefaultChapterTitle,
  makeSafeFileSlug: mocks.makeSafeFileSlug,
}))

vi.mock("@/lib/open-external-url", () => ({
  openExternalUrl: mocks.openExternalUrl,
}))

vi.mock("@/lib/novel/memory-center", () => ({
  loadMemoryCenterData: mocks.loadMemoryCenterData,
}))

vi.mock("@/lib/novel/chapter-ingest", () => ({
  ingestChapter: mocks.ingestChapter,
}))

vi.mock("@/lib/novel/outline-generation", () => ({
  createOutlineIngestTask: mocks.createOutlineIngestTask,
  runOutlineIngestTask: mocks.runOutlineIngestTask,
}))

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: mocks.dialogOpen,
}))

vi.mock("@/components/ui/button", () => ({
  Button: ({
    children,
    onClick,
    disabled,
    title,
    type = "button",
    className,
  }: {
    children?: ReactNode
    onClick?: () => void
    disabled?: boolean
    title?: string
    type?: "button" | "submit" | "reset"
    className?: string
  }) => (
    <button type={type} onClick={onClick} disabled={disabled} title={title} className={className}>
      {children}
    </button>
  ),
}))

vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({
    open,
    onOpenChange,
    children,
  }: {
    open: boolean
    onOpenChange: (open: boolean) => void
    children?: ReactNode
  }) =>
    open ? (
      <div data-testid="dialog-root">
        {children}
        <button type="button" data-testid="dialog-close" onClick={() => onOpenChange(false)}>
          close
        </button>
        <button type="button" data-testid="dialog-reopen" onClick={() => onOpenChange(true)}>
          reopen
        </button>
      </div>
    ) : null,
  DialogContent: ({ children }: { children?: ReactNode }) => <div data-testid="dialog-content">{children}</div>,
  DialogHeader: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  DialogDescription: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  DialogFooter: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}))

vi.mock("@/components/layout/knowledge-tree", () => ({
  KnowledgeTree: ({
    filterType,
    refreshKey,
    pendingPages,
    onRemovePendingPage,
    onRequestCreate,
  }: {
    filterType: "chapter" | "outline"
    refreshKey?: number
    pendingPages?: Array<{ path: string; type: string }>
    onRemovePendingPage?: (pagePath: string) => void
    onRequestCreate?: (request: { kind: string; parentDir?: string }) => void
  }) => (
    <div data-testid="knowledge-tree">
      <span data-testid="kt-filter">{filterType}</span>
      <span data-testid="kt-refresh">{String(refreshKey ?? 0)}</span>
      <span data-testid="kt-pending">{JSON.stringify((pendingPages ?? []).map((p) => p.path))}</span>
      <button type="button" data-testid="kt-create" onClick={() => onRequestCreate?.({ kind: filterType })}>
        create
      </button>
      <button
        type="button"
        data-testid="kt-create-parent"
        onClick={() => onRequestCreate?.({ kind: filterType, parentDir: `/p/mybook/wiki/chapters/v1` })}
      >
        create-parent
      </button>
      <button
        type="button"
        data-testid="kt-create-secondary"
        onClick={() => onRequestCreate?.({ kind: filterType === "chapter" ? "volume" : "folder" })}
      >
        create-secondary
      </button>
      <button
        type="button"
        data-testid="kt-remove"
        onClick={() => onRemovePendingPage?.((pendingPages ?? [])[0]?.path ?? "")}
      >
        remove
      </button>
    </div>
  ),
  RawSourcesSection: ({ onCancelExtraction }: { onCancelExtraction?: () => void }) => (
    <div data-testid="raw-sources">
      <button type="button" data-testid="raw-cancel" onClick={() => onCancelExtraction?.()}>
        cancel-extraction
      </button>
    </div>
  ),
}))

vi.mock("./trash-panel", () => ({ TrashPanel: () => <div data-testid="trash-panel">trash</div> }))
vi.mock("./graph-sidebar-panel", () => ({ GraphSidebarPanel: () => <div data-testid="graph-panel">graph</div> }))
vi.mock("./soul-sidebar-panel", () => ({ SoulSidebarPanel: () => <div data-testid="soul-panel">soul</div> }))
vi.mock("./review-center-sidebar-panel", () => ({
  ReviewCenterSidebarPanel: () => <div data-testid="review-panel">review</div>,
}))
vi.mock("./book-analysis-sidebar-panel", () => ({
  BookAnalysisSidebarPanel: () => <div data-testid="book-panel">book</div>,
}))

function renderSidebar(initial?: Partial<WikiStateLike>): {
  container: HTMLElement
  setState: (updates: Partial<WikiStateLike>) => void
  unmount: () => void
} {
  Object.assign(mocks.state, initial)
  const utils = render(<SidebarPanel />)
  return {
    container: utils.container,
    unmount: utils.unmount,
    setState(updates) {
      Object.assign(mocks.state, updates)
      utils.rerender(<SidebarPanel />)
    },
  }
}

function renderDismantling(initial?: Partial<WikiStateLike>): {
  container: HTMLElement
  setState: (updates: Partial<WikiStateLike>) => void
  unmount: () => void
} {
  Object.assign(mocks.state, initial)
  const utils = render(<DismantlingSidebarPanel />)
  return {
    container: utils.container,
    unmount: utils.unmount,
    setState(updates) {
      Object.assign(mocks.state, updates)
      utils.rerender(<DismantlingSidebarPanel />)
    },
  }
}

async function flushAsync(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

function flush(): void {
  act(() => {})
}

const CH1 = "/p/mybook/wiki/chapters/ch1.md"

describe("DismantlingSidebarPanel", () => {
  beforeEach(() => {
    cleanup()
    setupDomGlobals()
    vi.clearAllMocks()
    Object.assign(mocks.state, {
      project: null,
      selectedDismantlingProjectId: null,
      activeView: "dismantling",
      novelMode: true,
      selectedFile: null,
      selectedMemoryCenterEntry: null,
      dataVersion: 0,
      searchHistory: [],
    })
    mocks.dialogOpen.mockResolvedValue(null)
    mocks.listDirectory.mockResolvedValue([])
    mocks.readFile.mockResolvedValue("")
    mocks.fileExists.mockResolvedValue(false)
    mocks.writeFile.mockResolvedValue(undefined)
    mocks.createDirectory.mockResolvedValue(undefined)
    mocks.preprocessFile.mockResolvedValue("")
    mocks.splitDismantlingTextIntoChapters.mockReturnValue([])
    mocks.saveDismantlingLibrary.mockResolvedValue(undefined)
    mocks.loadDismantlingLibrary.mockResolvedValue(makeLibrary([]))
    mocks.flattenMdFiles.mockImplementation(
      (nodes) => nodes.filter((n) => !n.is_dir && n.name.endsWith(".md")).map((n) => ({ name: n.name, path: n.path })),
    )
  })

  afterEach(() => {
    vi.restoreAllMocks()
    cleanup()
  })

  it("无项目时清空拆文库并渲染空态", () => {
    renderDismantling()
    expect(screen.getByText("拆文作品")).toBeInTheDocument()
    expect(screen.getByText("独立拆文库")).toBeInTheDocument()
    expect(screen.getByText(/还没有拆文作品/)).toBeInTheDocument()
    expect(mocks.loadDismantlingLibrary).not.toHaveBeenCalled()
    expect(mocks.state.setSelectedDismantlingProjectId).toHaveBeenCalledWith(null)
    expect(screen.getByTestId("raw-sources")).toBeInTheDocument()
  })

  it("读取拆文库并自动选中首个作品（指定 id 不存在时回退）", async () => {
    const library = makeLibrary([makeProject("dp1", "作品甲", 3, 2), makeProject("dp2", "作品乙", 1, 0)])
    mocks.loadDismantlingLibrary.mockResolvedValue(library)
    renderDismantling({ project: DEFAULT_PROJECT, selectedDismantlingProjectId: "missing" })
    await waitFor(() => expect(mocks.state.setSelectedDismantlingProjectId).toHaveBeenCalledWith("dp1"))
    await flushAsync()

    expect(mocks.loadDismantlingLibrary).toHaveBeenCalledWith("/p/mybook")
    expect(screen.getByText("作品甲")).toBeInTheDocument()
    expect(screen.getByText("作品乙")).toBeInTheDocument()
    expect(screen.getByText("3 章 · 2 条结构记忆")).toBeInTheDocument()
    expect(screen.getByText("1 章 · 0 条结构记忆")).toBeInTheDocument()
  })

  it("选中项与库内作品匹配时不重复设置", async () => {
    const library = makeLibrary([makeProject("dp1", "作品甲"), makeProject("dp2", "作品乙")])
    mocks.loadDismantlingLibrary.mockResolvedValue(library)
    renderDismantling({ project: DEFAULT_PROJECT, selectedDismantlingProjectId: "dp2" })
    await waitFor(() => expect(screen.getByText("作品甲")).toBeInTheDocument())
    await flushAsync()
    expect(mocks.state.setSelectedDismantlingProjectId).not.toHaveBeenCalled()
  })

  it("加载中显示提示，卸载后 promise 完成不更新状态", async () => {
    let resolveLoad!: (value: DismantlingLibraryLike) => void
    mocks.loadDismantlingLibrary.mockReturnValue(
      new Promise<DismantlingLibraryLike>((resolve) => {
        resolveLoad = resolve
      }),
    )
    const { unmount } = renderDismantling({ project: DEFAULT_PROJECT })
    expect(screen.getByText("正在读取拆文库...")).toBeInTheDocument()
    unmount()
    act(() => {
      resolveLoad(makeLibrary([makeProject("dp1", "作品甲")]))
    })
    await flushAsync()
    expect(mocks.state.setSelectedDismantlingProjectId).not.toHaveBeenCalled()
  })

  it("点击作品行切换选中项", async () => {
    const library = makeLibrary([makeProject("dp1", "作品甲"), makeProject("dp2", "作品乙")])
    mocks.loadDismantlingLibrary.mockResolvedValue(library)
    renderDismantling({ project: DEFAULT_PROJECT })
    await waitFor(() => expect(screen.getByText("作品乙")).toBeInTheDocument())
    await flushAsync()
    fireEvent.click(screen.getByText("作品乙"))
    expect(mocks.state.setSelectedDismantlingProjectId).toHaveBeenCalledWith("dp2")
  })

  it("删除作品：确认后保存并回退选中项到下一个作品", async () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true)
    const library = makeLibrary([makeProject("dp1", "作品甲"), makeProject("dp2", "作品乙")])
    mocks.loadDismantlingLibrary.mockResolvedValue(library)
    renderDismantling({ project: DEFAULT_PROJECT, selectedDismantlingProjectId: "dp1" })
    await waitFor(() => expect(screen.getByText("作品甲")).toBeInTheDocument())
    await flushAsync()

    fireEvent.click(screen.getAllByTitle("删除拆文作品")[0])
    expect(confirmSpy).toHaveBeenCalledWith(expect.stringContaining("作品甲"))
    await waitFor(() => expect(mocks.saveDismantlingLibrary).toHaveBeenCalled())
    await flushAsync()

    const savedLibrary = mocks.saveDismantlingLibrary.mock.calls[0]?.[1] as DismantlingLibraryLike
    expect(savedLibrary.projects.map((p) => p.id)).toEqual(["dp2"])
    expect(savedLibrary.selectedProjectId).toBe("dp2")
    expect(mocks.state.setSelectedDismantlingProjectId).toHaveBeenLastCalledWith("dp2")
    expect(mocks.state.bumpDataVersion).toHaveBeenCalled()
    expect(screen.getByText("已删除拆文作品：作品甲")).toBeInTheDocument()
  })

  it("删除作品：取消确认时不保存", async () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false)
    const library = makeLibrary([makeProject("dp1", "作品甲")])
    mocks.loadDismantlingLibrary.mockResolvedValue(library)
    renderDismantling({ project: DEFAULT_PROJECT })
    await waitFor(() => expect(screen.getByText("作品甲")).toBeInTheDocument())
    await flushAsync()

    fireEvent.click(screen.getByTitle("删除拆文作品"))
    expect(confirmSpy).toHaveBeenCalled()
    expect(mocks.saveDismantlingLibrary).not.toHaveBeenCalled()
    expect(screen.getByText("作品甲")).toBeInTheDocument()
  })

  it("删除作品：删除最后一个作品时选中回退为 null", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true)
    const library = makeLibrary([makeProject("dp1", "作品甲")])
    mocks.loadDismantlingLibrary.mockResolvedValue(library)
    renderDismantling({ project: DEFAULT_PROJECT, selectedDismantlingProjectId: "dp1" })
    await waitFor(() => expect(screen.getByText("作品甲")).toBeInTheDocument())
    await flushAsync()

    fireEvent.click(screen.getByTitle("删除拆文作品"))
    await waitFor(() => expect(mocks.saveDismantlingLibrary).toHaveBeenCalled())
    await flushAsync()
    expect(mocks.state.setSelectedDismantlingProjectId).toHaveBeenLastCalledWith(null)
  })

  it("导入文件：单章/多章切分、标题回退与状态文案", async () => {
    const alertSpy = vi.spyOn(window, "alert").mockImplementation(() => {})
    mocks.state.project = DEFAULT_PROJECT
    mocks.dialogOpen.mockResolvedValue(["/tmp/a.md", "/tmp/b.md", "/tmp/c.md"])
    mocks.preprocessFile.mockResolvedValue("正文内容")
    mocks.splitDismantlingTextIntoChapters.mockImplementation((content: string) => {
      if (content === "正文内容") return []
      return [
        { id: "x", chapterNumber: 1, title: "第1章", content: "第一章正文", status: "pending" },
        { id: "y", chapterNumber: 2, title: "第二章", content: "第二章正文", status: "pending" },
      ]
    })
    renderDismantling({ project: DEFAULT_PROJECT })

    fireEvent.click(screen.getByTitle("导入文件"))
    await waitFor(() => expect(mocks.saveDismantlingLibrary).toHaveBeenCalled())
    await flushAsync()

    expect(mocks.dialogOpen).toHaveBeenCalledWith(
      expect.objectContaining({ multiple: true, title: "导入拆文文件" }),
    )
    expect(mocks.preprocessFile).toHaveBeenCalledTimes(3)
    // a/b/c 三个文件各产生 1 章（split 空 → 标题回退到 getFileStem）
    const saved = mocks.saveDismantlingLibrary.mock.calls[0]?.[1] as DismantlingLibraryLike
    expect(saved.projects).toHaveLength(1)
    expect(saved.projects[0]?.title).toBe("a")
    expect(saved.projects[0]?.chapters).toHaveLength(3)
    expect(saved.projects[0]?.chapters.map((c) => c.title)).toEqual(["a", "b", "c"])
    expect(saved.projects[0]?.chapters[0]?.id).toBe("chapter-001")
    expect(mocks.state.bumpDataVersion).toHaveBeenCalled()
    expect(screen.getByText("已提取 3 个章节。")).toBeInTheDocument()
    expect(mocks.state.setSelectedDismantlingProjectId).toHaveBeenLastCalledWith(expect.stringMatching(/^dismantling-/))
    expect(alertSpy).not.toHaveBeenCalled()
  })

  it("导入文件：多章节切分时逐章登记", async () => {
    mocks.state.project = DEFAULT_PROJECT
    mocks.dialogOpen.mockResolvedValue(["/tmp/multi.md"])
    mocks.preprocessFile.mockResolvedValue("multi")
    mocks.splitDismantlingTextIntoChapters.mockImplementation((content: string) => {
      if (content === "multi") {
        return [
          { id: "x", chapterNumber: 1, title: "第一章", content: "一", status: "pending" },
          { id: "y", chapterNumber: 2, title: "第二章", content: "二", status: "pending" },
        ]
      }
      return []
    })
    renderDismantling({ project: DEFAULT_PROJECT })

    fireEvent.click(screen.getByTitle("导入文件"))
    await waitFor(() => expect(mocks.saveDismantlingLibrary).toHaveBeenCalled())
    await flushAsync()

    const saved = mocks.saveDismantlingLibrary.mock.calls[0]?.[1] as DismantlingLibraryLike
    expect(saved.projects[0]?.chapters).toHaveLength(2)
    expect(saved.projects[0]?.chapters.map((c) => c.id)).toEqual(["chapter-001", "chapter-002"])
    expect(saved.projects[0]?.chapters.map((c) => c.chapterNumber)).toEqual([1, 2])
    expect(screen.getByText("已提取 2 个章节。")).toBeInTheDocument()
  })

  it("导入文件：单章切分且标题为“第1章”时回退到文件名", async () => {
    mocks.state.project = DEFAULT_PROJECT
    mocks.dialogOpen.mockResolvedValue(["/tmp/zero.md"])
    mocks.preprocessFile.mockResolvedValue("single")
    mocks.splitDismantlingTextIntoChapters.mockImplementation((content: string) => {
      if (content === "single") {
        return [{ id: "x", chapterNumber: 1, title: "第1章", content: "正文", status: "pending" }]
      }
      return []
    })
    renderDismantling({ project: DEFAULT_PROJECT })

    fireEvent.click(screen.getByTitle("导入文件"))
    await waitFor(() => expect(mocks.saveDismantlingLibrary).toHaveBeenCalled())
    await flushAsync()

    const saved = mocks.saveDismantlingLibrary.mock.calls[0]?.[1] as DismantlingLibraryLike
    expect(saved.projects[0]?.chapters[0]?.title).toBe("zero")
  })

  it("导入文件：无需预处理时回读原文；预处理抛错时回退 readFile", async () => {
    mocks.state.project = DEFAULT_PROJECT
    mocks.dialogOpen.mockResolvedValue(["/tmp/raw.md", "/tmp/broken.md"])
    mocks.preprocessFile.mockImplementation(async (path: string) => {
      if (path === "/tmp/raw.md") return "no preprocessing needed"
      throw new Error("preprocess boom")
    })
    mocks.readFile.mockImplementation(async (path: string) => (path === "/tmp/raw.md" ? "原文内容" : "回退内容"))
    renderDismantling({ project: DEFAULT_PROJECT })

    fireEvent.click(screen.getByTitle("导入文件"))
    await waitFor(() => expect(mocks.saveDismantlingLibrary).toHaveBeenCalled())
    await flushAsync()

    expect(mocks.readFile).toHaveBeenCalledWith("/tmp/raw.md")
    expect(mocks.readFile).toHaveBeenCalledWith("/tmp/broken.md")
    const saved = mocks.saveDismantlingLibrary.mock.calls[0]?.[1] as DismantlingLibraryLike
    expect(saved.projects[0]?.chapters.map((c) => c.content)).toEqual(["原文内容", "回退内容"])
  })

  it("导入文件：对话框取消/返回空数组时不导入", async () => {
    mocks.state.project = DEFAULT_PROJECT
    renderDismantling({ project: DEFAULT_PROJECT })
    fireEvent.click(screen.getByTitle("导入文件"))
    await flushAsync()
    expect(mocks.preprocessFile).not.toHaveBeenCalled()
    expect(mocks.saveDismantlingLibrary).not.toHaveBeenCalled()

    mocks.dialogOpen.mockResolvedValue([])
    fireEvent.click(screen.getByTitle("导入文件"))
    await flushAsync()
    expect(mocks.preprocessFile).not.toHaveBeenCalled()
  })

  it("导入文件：对话框返回单个字符串时归一为数组", async () => {
    mocks.state.project = DEFAULT_PROJECT
    mocks.dialogOpen.mockResolvedValue("/tmp/only.md")
    mocks.preprocessFile.mockResolvedValue("x")
    renderDismantling({ project: DEFAULT_PROJECT })
    fireEvent.click(screen.getByTitle("导入文件"))
    await waitFor(() => expect(mocks.preprocessFile).toHaveBeenCalledWith("/tmp/only.md"))
    await flushAsync()
  })

  it("导入文件夹：收集候选后导入并回退标题", async () => {
    mocks.state.project = DEFAULT_PROJECT
    mocks.dialogOpen.mockResolvedValue("/tmp/folder")
    mocks.collectChapterImportCandidatesFromFolder.mockResolvedValue([{ path: "/tmp/folder/a.md", name: "a.md" }])
    mocks.preprocessFile.mockResolvedValue("x")
    renderDismantling({ project: DEFAULT_PROJECT })
    fireEvent.click(screen.getByTitle("导入文件夹"))
    await waitFor(() => expect(mocks.collectChapterImportCandidatesFromFolder).toHaveBeenCalledWith("/tmp/folder"))
    await waitFor(() => expect(mocks.saveDismantlingLibrary).toHaveBeenCalled())
    await flushAsync()
    const saved = mocks.saveDismantlingLibrary.mock.calls[0]?.[1] as DismantlingLibraryLike
    expect(saved.projects[0]?.title).toBe("folder")
  })

  it("导入文件：项目在对话框期间失效时内层守卫返回", async () => {
    const project = { ...DEFAULT_PROJECT }
    mocks.state.project = project
    mocks.dialogOpen.mockImplementation(async () => {
      project.path = ""
      return ["/tmp/a.md"]
    })
    renderDismantling({ project })

    fireEvent.click(screen.getByTitle("导入文件"))
    await flushAsync()
    expect(mocks.preprocessFile).not.toHaveBeenCalled()
    expect(mocks.saveDismantlingLibrary).not.toHaveBeenCalled()
  })

  it("导入文件：缺失文件名时使用拆文作品默认标题", async () => {
    mocks.state.project = DEFAULT_PROJECT
    mocks.dialogOpen.mockResolvedValue(["/tmp/a.md"])
    mocks.getFileName.mockImplementationOnce(() => undefined as unknown as string)
    mocks.getFileStem
      .mockImplementationOnce(() => "")
      .mockImplementationOnce(() => "")
    mocks.preprocessFile.mockResolvedValue("正文")
    renderDismantling({ project: DEFAULT_PROJECT })

    fireEvent.click(screen.getByTitle("导入文件"))
    await waitFor(() => expect(mocks.saveDismantlingLibrary).toHaveBeenCalled())
    const saved = mocks.saveDismantlingLibrary.mock.calls[0]?.[1] as DismantlingLibraryLike
    expect(saved.projects[0]?.title).toBe("拆文作品")
  })

  it("导入文件：第1章且文件名 stem 为空时回退章节标题", async () => {
    mocks.state.project = DEFAULT_PROJECT
    mocks.dialogOpen.mockResolvedValue(["/tmp/a.md"])
    mocks.getFileStem
      .mockImplementationOnce(() => "作品标题")
      .mockImplementationOnce(() => "")
    mocks.preprocessFile.mockResolvedValue("正文")
    mocks.splitDismantlingTextIntoChapters.mockReturnValue([
      { id: "x", chapterNumber: 1, title: "第1章", content: "正文", status: "pending" },
    ])
    renderDismantling({ project: DEFAULT_PROJECT })

    fireEvent.click(screen.getByTitle("导入文件"))
    await waitFor(() => expect(mocks.saveDismantlingLibrary).toHaveBeenCalled())
    const saved = mocks.saveDismantlingLibrary.mock.calls[0]?.[1] as DismantlingLibraryLike
    expect(saved.projects[0]?.chapters[0]?.title).toBe("第1章")
  })

  it("导入文件夹：文件夹名为空时使用拆文作品默认标题", async () => {
    mocks.state.project = DEFAULT_PROJECT
    mocks.dialogOpen.mockResolvedValue("/tmp/folder")
    mocks.getFileName.mockImplementationOnce(() => "")
    mocks.collectChapterImportCandidatesFromFolder.mockResolvedValue([{ path: "/tmp/folder/a.md", name: "a.md" }])
    mocks.preprocessFile.mockResolvedValue("正文")
    renderDismantling({ project: DEFAULT_PROJECT })

    fireEvent.click(screen.getByTitle("导入文件夹"))
    await waitFor(() => expect(mocks.saveDismantlingLibrary).toHaveBeenCalled())
    const saved = mocks.saveDismantlingLibrary.mock.calls[0]?.[1] as DismantlingLibraryLike
    expect(saved.projects[0]?.title).toBe("拆文作品")
  })

  it("删除作品：项目路径失效时删除守卫返回", async () => {
    const project = { ...DEFAULT_PROJECT }
    const library = makeLibrary([makeProject("dp1", "作品甲")])
    mocks.loadDismantlingLibrary.mockResolvedValue(library)
    renderDismantling({ project, selectedDismantlingProjectId: "dp1" })
    await waitFor(() => expect(screen.getByText("作品甲")).toBeInTheDocument())

    project.path = ""
    fireEvent.click(screen.getByTitle("删除拆文作品"))
    await flushAsync()
    expect(mocks.saveDismantlingLibrary).not.toHaveBeenCalled()
  })

  it("导入文件夹：候选为空时提示没有可导入资料", async () => {
    const alertSpy = vi.spyOn(window, "alert").mockImplementation(() => {})
    mocks.state.project = DEFAULT_PROJECT
    mocks.dialogOpen.mockResolvedValue("/tmp/empty-folder")
    mocks.collectChapterImportCandidatesFromFolder.mockResolvedValue([])
    renderDismantling({ project: DEFAULT_PROJECT })

    fireEvent.click(screen.getByTitle("导入文件夹"))
    await waitFor(() => expect(alertSpy).toHaveBeenCalledWith("没有找到可导入的拆文资料。"))
    expect(mocks.saveDismantlingLibrary).not.toHaveBeenCalled()
  })

  it("导入文件夹：对话框返回数组或空值时守卫返回", async () => {
    mocks.state.project = DEFAULT_PROJECT
    mocks.dialogOpen.mockResolvedValue(["/a", "/b"])
    renderDismantling({ project: DEFAULT_PROJECT })
    fireEvent.click(screen.getByTitle("导入文件夹"))
    await flushAsync()
    expect(mocks.collectChapterImportCandidatesFromFolder).not.toHaveBeenCalled()

    mocks.dialogOpen.mockResolvedValue(null)
    fireEvent.click(screen.getByTitle("导入文件夹"))
    await flushAsync()
    expect(mocks.collectChapterImportCandidatesFromFolder).not.toHaveBeenCalled()
  })

  it("重复作品名：已存在时拦截并提示", async () => {
    const alertSpy = vi.spyOn(window, "alert").mockImplementation(() => {})
    mocks.state.project = DEFAULT_PROJECT
    mocks.dialogOpen.mockResolvedValue(["/tmp/dup.md"])
    mocks.preprocessFile.mockResolvedValue("x")
    renderDismantling({ project: DEFAULT_PROJECT })

    fireEvent.click(screen.getByTitle("导入文件"))
    await waitFor(() => expect(mocks.saveDismantlingLibrary).toHaveBeenCalled())
    await flushAsync()

    fireEvent.click(screen.getByTitle("导入文件"))
    await waitFor(() => expect(alertSpy).toHaveBeenCalledWith(expect.stringContaining("已存在相同拆文作品")))
    await flushAsync()
    expect(screen.getByText(/已存在相同拆文作品：dup/)).toBeInTheDocument()
    expect(mocks.saveDismantlingLibrary).toHaveBeenCalledTimes(1)
  })

  it("保存失败时 alert 导入失败", async () => {
    const alertSpy = vi.spyOn(window, "alert").mockImplementation(() => {})
    vi.spyOn(console, "error").mockImplementation(() => {})
    mocks.state.project = DEFAULT_PROJECT
    mocks.dialogOpen.mockResolvedValue(["/tmp/a.md"])
    mocks.preprocessFile.mockResolvedValue("x")
    mocks.saveDismantlingLibrary.mockRejectedValue(new Error("disk full"))
    renderDismantling({ project: DEFAULT_PROJECT })
    fireEvent.click(screen.getByTitle("导入文件"))
    await waitFor(() => expect(alertSpy).toHaveBeenCalledWith("导入失败：disk full"))
    await flushAsync()
  })

  it("无项目时导入按钮守卫返回", async () => {
    renderDismantling()
    fireEvent.click(screen.getByTitle("导入文件"))
    fireEvent.click(screen.getByTitle("导入文件夹"))
    await flushAsync()
    expect(mocks.dialogOpen).not.toHaveBeenCalled()
    expect(mocks.preprocessFile).not.toHaveBeenCalled()
    expect(mocks.collectChapterImportCandidatesFromFolder).not.toHaveBeenCalled()
  })

  it("导入进行中：按钮禁用且重复点击不触发新对话框", async () => {
    let resolvePreprocess!: (value: string) => void
    mocks.state.project = DEFAULT_PROJECT
    mocks.dialogOpen.mockResolvedValue(["/tmp/a.md"])
    mocks.preprocessFile.mockReturnValue(
      new Promise<string>((resolve) => {
        resolvePreprocess = resolve
      }),
    )
    renderDismantling({ project: DEFAULT_PROJECT })
    fireEvent.click(screen.getByTitle("导入文件"))
    await waitFor(() => expect(screen.getByText("正在提取章节：a.md")).toBeInTheDocument())

    expect(screen.getByTitle("导入文件")).toBeDisabled()
    expect(screen.getByTitle("导入文件夹")).toBeDisabled()
    fireEvent.click(screen.getByTitle("导入文件"))
    fireEvent.click(screen.getByTitle("导入文件夹"))
    await flushAsync()
    expect(mocks.dialogOpen).toHaveBeenCalledTimes(1)

    act(() => {
      resolvePreprocess("x")
    })
    await flushAsync()
  })

  it("读取到空拆文库时选中回退为 null", async () => {
    mocks.loadDismantlingLibrary.mockResolvedValue({ version: 1, projects: [], selectedProjectId: null })
    renderDismantling({ project: DEFAULT_PROJECT })
    await waitFor(() => expect(mocks.state.setSelectedDismantlingProjectId).toHaveBeenCalledWith(null))
    await flushAsync()
    expect(screen.getByText(/还没有拆文作品/)).toBeInTheDocument()
  })

  it("删除非选中作品时保留当前选中", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true)
    const library = makeLibrary([makeProject("dp1", "作品甲"), makeProject("dp2", "作品乙")])
    mocks.loadDismantlingLibrary.mockResolvedValue(library)
    renderDismantling({ project: DEFAULT_PROJECT, selectedDismantlingProjectId: "dp1" })
    await waitFor(() => expect(screen.getByText("作品乙")).toBeInTheDocument())
    await flushAsync()

    fireEvent.click(screen.getAllByTitle("删除拆文作品")[1])
    await waitFor(() => expect(mocks.saveDismantlingLibrary).toHaveBeenCalled())
    await flushAsync()
    expect(mocks.state.setSelectedDismantlingProjectId).toHaveBeenLastCalledWith("dp1")
    expect(screen.getByText("已删除拆文作品：作品乙")).toBeInTheDocument()
  })

  it("点击停止按钮触发 onCancelExtraction 空回调", () => {
    renderDismantling({ project: DEFAULT_PROJECT })
    fireEvent.click(screen.getByTestId("raw-cancel"))
  })

  it("保存失败（非 Error 抛出）时 alert 原始字符串", async () => {
    const alertSpy = vi.spyOn(window, "alert").mockImplementation(() => {})
    vi.spyOn(console, "error").mockImplementation(() => {})
    mocks.state.project = DEFAULT_PROJECT
    mocks.dialogOpen.mockResolvedValue(["/tmp/a.md"])
    mocks.preprocessFile.mockResolvedValue("x")
    mocks.saveDismantlingLibrary.mockRejectedValue("disk-full-str")
    renderDismantling({ project: DEFAULT_PROJECT })
    fireEvent.click(screen.getByTitle("导入文件"))
    await waitFor(() => expect(alertSpy).toHaveBeenCalledWith("导入失败：disk-full-str"))
    await flushAsync()
  })

  it("单章切分标题非“第1章”时直接沿用标题", async () => {
    mocks.state.project = DEFAULT_PROJECT
    mocks.dialogOpen.mockResolvedValue(["/tmp/intro.md"])
    mocks.preprocessFile.mockResolvedValue("single")
    mocks.splitDismantlingTextIntoChapters.mockImplementation((content: string) => {
      if (content === "single") {
        return [{ id: "x", chapterNumber: 1, title: "序章", content: "正文", status: "pending" }]
      }
      return []
    })
    renderDismantling({ project: DEFAULT_PROJECT })
    fireEvent.click(screen.getByTitle("导入文件"))
    await waitFor(() => expect(mocks.saveDismantlingLibrary).toHaveBeenCalled())
    await flushAsync()
    const saved = mocks.saveDismantlingLibrary.mock.calls[0]?.[1] as DismantlingLibraryLike
    expect(saved.projects[0]?.chapters[0]?.title).toBe("序章")
  })
})

describe("SidebarPanel 视图路由", () => {
  beforeEach(() => {
    cleanup()
    setupDomGlobals()
    vi.clearAllMocks()
    Object.assign(mocks.state, {
      project: DEFAULT_PROJECT,
      activeView: "wiki",
      novelMode: true,
      selectedFile: null,
      selectedMemoryCenterEntry: null,
      dataVersion: 0,
      searchHistory: [],
      selectedDismantlingProjectId: null,
    })
    mocks.listDirectory.mockResolvedValue([])
    mocks.readFile.mockResolvedValue("")
    mocks.loadMemoryCenterData.mockResolvedValue(null)
    mocks.flattenMdFiles.mockImplementation(
      (nodes) => nodes.filter((n) => !n.is_dir && n.name.endsWith(".md")).map((n) => ({ name: n.name, path: n.path })),
    )
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("graph/soul/reviewCenter/bookAnalysis/trash 视图渲染对应面板", () => {
    for (const [view, testId] of [
      ["graph", "graph-panel"],
      ["soul", "soul-panel"],
      ["reviewCenter", "review-panel"],
      ["bookAnalysis", "book-panel"],
      ["trash", "trash-panel"],
    ] as const) {
      const { unmount } = renderSidebar({ activeView: view })
      expect(screen.getByTestId(testId)).toBeInTheDocument()
      unmount()
    }
  })

  it("search 视图：无历史时显示空态", () => {
    renderSidebar({ activeView: "search", searchHistory: [] })
    expect(screen.getByText("暂无历史搜索")).toBeInTheDocument()
    expect(screen.getByText("novel.nav.search")).toBeInTheDocument()
  })

  it("search 视图：点击历史项触发搜索", () => {
    renderSidebar({ activeView: "search", searchHistory: ["关键词一", "关键词二"] })
    const buttons = screen.getAllByRole("button")
    expect(buttons).toHaveLength(2)
    fireEvent.click(screen.getByText("关键词一"))
    expect(mocks.state.setActiveView).toHaveBeenCalledWith("search")
    expect(mocks.state.setSearchTrigger).toHaveBeenCalledWith(expect.objectContaining({ query: "关键词一" }))
    const trigger = mocks.state.setSearchTrigger.mock.calls[0]?.[0] as { ts: number }
    expect(typeof trigger.ts).toBe("number")
  })

  it("lint+novelMode 且无项目时渲染记忆中心标题与禁用条目", async () => {
    renderSidebar({ activeView: "lint", novelMode: true, project: null })
    await flushAsync()
    expect(screen.getByText("novel.memoryCenter.title")).toBeInTheDocument()
    expect(mocks.loadMemoryCenterData).not.toHaveBeenCalled()
    const buttons = screen.getAllByRole("button")
    expect(buttons.some((b) => b.textContent === "novel.memoryCenter.snapshots.title0")).toBe(true)
  })

  it("lint+novelMode：加载中显示 spinner，成功后渲染条目计数", async () => {
    let resolveData!: (value: MemoryCenterData | null) => void
    mocks.loadMemoryCenterData.mockReturnValue(
      new Promise((resolve) => {
        resolveData = resolve
      }),
    )
    const { setState } = renderSidebar({ activeView: "lint", novelMode: true, project: DEFAULT_PROJECT })
    expect(screen.getByText("novel.memoryCenter.loading")).toBeInTheDocument()

    act(() => {
      resolveData({
        stats: { snapshotCount: 2, syncedSnapshotCount: 0, characterCount: 0, activeForeshadowingCount: 0, memoryFileCount: 0 },
        snapshots: [{ chapterNumber: 1, summary: "", endingHook: "", memorySynced: false, snapshotPath: "", characterStateChanges: [], knowledgeChanges: [], foreshadowingChanges: [], timelineEvents: [], hasMoreCharacterStateChanges: false, hasMoreKnowledgeChanges: false, hasMoreForeshadowingChanges: false, hasMoreTimelineEvents: false }],
        files: [
          {
            key: "character-states",
            title: "character-states",
            path: "/x",
            sections: [{ title: "s", groups: [{ title: "g1", items: [] }, { title: "g2", items: [] }], items: ["a", "b", "c"] }],
          },
          {
            key: "character-cognition",
            title: "character-cognition",
            path: "/x",
            sections: [{ title: "s", groups: [], items: ["a"] }],
          },
        ],
        dismantlingProjects: [],
      })
    })
    await flushAsync()

    expect(screen.getByText("novel.memoryCenter.sections.characterStates")).toBeInTheDocument()
    expect(screen.getByText("novel.memoryCenter.sections.cognition")).toBeInTheDocument()
    expect(screen.getByText("novel.memoryCenter.sections.foreshadowing")).toBeInTheDocument()
    expect(screen.getByText("novel.memoryCenter.sections.timeline")).toBeInTheDocument()
    expect(screen.getByText("novel.memoryCenter.sections.canonFacts")).toBeInTheDocument()
    expect(screen.getByText("novel.memoryCenter.sections.conflicts")).toBeInTheDocument()
    expect(screen.getByText("novel.memoryCenter.snapshots.title")).toBeInTheDocument()
    // 条目计数：snapshots=2 / character-states=5 / cognition=1 / 缺失文件=0
    const snapshotBtn = screen.getByRole("button", { name: /novel.memoryCenter.snapshots.title/ })
    expect(snapshotBtn.textContent).toContain("2")
    const statesBtn = screen.getByRole("button", { name: /characterStates/ })
    expect(statesBtn.textContent).toContain("5")
    const cognitionBtn = screen.getByRole("button", { name: /cognition/ })
    expect(cognitionBtn.textContent).toContain("1")
    const timelineBtn = screen.getByRole("button", { name: /timeline/ })
    expect(timelineBtn).toBeDisabled()
    expect(timelineBtn.textContent).toContain("0")

    fireEvent.click(statesBtn)
    expect(mocks.state.setSelectedMemoryCenterEntry).toHaveBeenCalledWith("character-states")

    // 刷新按钮再次加载
    fireEvent.click(screen.getByTitle("novel.memoryCenter.refresh"))
    await waitFor(() => expect(mocks.loadMemoryCenterData).toHaveBeenCalledTimes(2))
    await flushAsync()

    // 离开 lint 视图后清理数据
    setState({ activeView: "wiki" })
    await flushAsync()
    expect(screen.queryByText("novel.memoryCenter.loading")).not.toBeInTheDocument()
  })

  it("lint+novelMode：加载失败显示错误与刷新按钮", async () => {
    mocks.loadMemoryCenterData.mockRejectedValue(new Error("memory boom"))
    const { setState } = renderSidebar({ activeView: "lint", novelMode: true, project: DEFAULT_PROJECT })
    await waitFor(() => expect(screen.getByText("memory boom")).toBeInTheDocument())

    mocks.loadMemoryCenterData.mockResolvedValue({ stats: { snapshotCount: 0, syncedSnapshotCount: 0, characterCount: 0, activeForeshadowingCount: 0, memoryFileCount: 0 }, snapshots: [], files: [], dismantlingProjects: [] })
    fireEvent.click(screen.getByTitle("novel.memoryCenter.refresh"))
    await waitFor(() => expect(mocks.loadMemoryCenterData).toHaveBeenCalledTimes(2))
    await flushAsync()
    expect(screen.queryByText("memory boom")).not.toBeInTheDocument()

    setState({ activeView: "lint", novelMode: true, project: null })
    fireEvent.click(screen.getByTitle("novel.memoryCenter.refresh"))
    await flushAsync()
    expect(mocks.loadMemoryCenterData).toHaveBeenCalledTimes(2)
  })

  it("lint+novelMode：入口为 dismantling-library 时自动清空选择", async () => {
    const { setState } = renderSidebar({
      activeView: "lint",
      novelMode: true,
      project: DEFAULT_PROJECT,
      selectedMemoryCenterEntry: "dismantling-library",
    })
    await flushAsync()
    expect(mocks.state.setSelectedMemoryCenterEntry).toHaveBeenCalledWith(null)

    // 非 lint 视图不触发清空
    mocks.state.setSelectedMemoryCenterEntry.mockClear()
    setState({ activeView: "wiki" })
    await flushAsync()
    expect(mocks.state.setSelectedMemoryCenterEntry).not.toHaveBeenCalled()
  })

  it("非 lint 视图不加载记忆数据", async () => {
    const { setState } = renderSidebar({ activeView: "wiki", project: DEFAULT_PROJECT })
    await flushAsync()
    expect(mocks.loadMemoryCenterData).not.toHaveBeenCalled()
    setState({ activeView: "lint", novelMode: false, project: DEFAULT_PROJECT })
    await flushAsync()
    expect(mocks.loadMemoryCenterData).not.toHaveBeenCalled()
  })

  it("记忆加载：卸载后 resolve/reject 均跳过状态更新", async () => {
    let resolveData!: (value: MemoryCenterData | null) => void
    mocks.loadMemoryCenterData.mockReturnValue(
      new Promise((resolve) => {
        resolveData = resolve
      }),
    )
    const first = renderSidebar({ activeView: "lint", novelMode: true, project: DEFAULT_PROJECT })
    first.unmount()
    act(() => {
      resolveData({ stats: { snapshotCount: 1, syncedSnapshotCount: 0, characterCount: 0, activeForeshadowingCount: 0, memoryFileCount: 0 }, snapshots: [], files: [], dismantlingProjects: [] })
    })
    await flushAsync()

    let rejectData!: (reason: unknown) => void
    mocks.loadMemoryCenterData.mockReturnValue(
      new Promise((_resolve, reject) => {
        rejectData = reject
      }),
    )
    const second = renderSidebar({ activeView: "lint", novelMode: true, project: DEFAULT_PROJECT })
    second.unmount()
    act(() => {
      rejectData(new Error("late boom"))
    })
    await flushAsync()
  })

  it("记忆加载：非 Error 拒绝时显示 String(err)", async () => {
    mocks.loadMemoryCenterData.mockRejectedValue("boom-str")
    renderSidebar({ activeView: "lint", novelMode: true, project: DEFAULT_PROJECT })
    await waitFor(() => expect(screen.getByText("boom-str")).toBeInTheDocument())
  })

  it("记忆中心：刷新失败显示错误，非 Error 拒绝同样显示", async () => {
    const firstRender = renderSidebar({ activeView: "lint", novelMode: true, project: DEFAULT_PROJECT })
    await flushAsync()
    expect(mocks.loadMemoryCenterData).toHaveBeenCalledTimes(1)

    mocks.loadMemoryCenterData.mockRejectedValue(new Error("refresh boom"))
    fireEvent.click(screen.getByTitle("novel.memoryCenter.refresh"))
    await waitFor(() => expect(screen.getByText("refresh boom")).toBeInTheDocument())
    expect(mocks.loadMemoryCenterData).toHaveBeenCalledTimes(2)

    mocks.loadMemoryCenterData.mockRejectedValue("refresh-boom-str")
    fireEvent.click(screen.getByTitle("novel.memoryCenter.refresh"))
    await waitFor(() => expect(screen.getByText("refresh-boom-str")).toBeInTheDocument())
    expect(mocks.loadMemoryCenterData).toHaveBeenCalledTimes(3)
    firstRender.unmount()
  })

  it("记忆中心：选中条目时渲染 secondary 变体按钮", async () => {
    renderSidebar({
      activeView: "lint",
      novelMode: true,
      project: DEFAULT_PROJECT,
      selectedMemoryCenterEntry: "character-states",
    })
    await flushAsync()
    const statesBtn = screen.getByRole("button", { name: /characterStates/ })
    expect(statesBtn).toBeInTheDocument()
  })

  it("记忆决策对话框：reopen 回调不关闭", async () => {
    mocks.dialogOpen.mockResolvedValue(["/tmp/ch1.md"])
    mocks.state.project = DEFAULT_PROJECT
    const { setState } = renderSidebar()
    setState({ activeView: "wiki" })
    await flushAsync()
    fireEvent.click(screen.getByRole("button", { name: "导入" }))
    fireEvent.click(screen.getByText("导入文件"))
    await waitFor(() => expect(screen.getByText("是否提取记忆")).toBeInTheDocument())
    fireEvent.click(screen.getByTestId("dialog-reopen"))
    expect(screen.getByText("是否提取记忆")).toBeInTheDocument()
  })
})

describe("SidebarPanel 知识模式（章节）", () => {
  beforeEach(() => {
    cleanup()
    setupDomGlobals()
    vi.clearAllMocks()
    Object.assign(mocks.state, {
      project: DEFAULT_PROJECT,
      activeView: "wiki",
      novelMode: true,
      selectedFile: null,
      selectedMemoryCenterEntry: null,
      dataVersion: 0,
      searchHistory: [],
      selectedDismantlingProjectId: null,
    })
    mocks.listDirectory.mockResolvedValue([])
    mocks.readFile.mockResolvedValue("")
    mocks.fileExists.mockResolvedValue(false)
    mocks.writeFile.mockResolvedValue(undefined)
    mocks.createDirectory.mockResolvedValue(undefined)
    mocks.dialogOpen.mockResolvedValue(null)
    mocks.importChapterFiles.mockResolvedValue([])
    mocks.runImportedChapterMemoryExtraction.mockResolvedValue({ cancelled: false, completed: 0, failed: 0, errors: [] })
    mocks.getNextChapterNumber.mockResolvedValue(1)
    mocks.importProgressActions.startTask.mockReturnValue("task-1")
    mocks.flattenMdFiles.mockImplementation(
      (nodes) => nodes.filter((n) => !n.is_dir && n.name.endsWith(".md")).map((n) => ({ name: n.name, path: n.path })),
    )
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("知识模式默认渲染：标题/帮助/字数/使用指南/RawSources", async () => {
    mocks.listDirectory.mockImplementation(async (path: string) => {
      if (path === "/p/mybook/wiki/chapters") {
        return [{ name: "c1.md", path: CH1, is_dir: false }]
      }
      return []
    })
    mocks.readFile.mockResolvedValue("# 第一章\n\n正文")
    mocks.countChapterBodyWords.mockReturnValue(1234)
    renderSidebar()
    await waitFor(() => expect(screen.getByText("total:1234")).toBeInTheDocument())
    expect(screen.getByText("sidebar.knowledge")).toBeInTheDocument()
    expect(screen.getByTestId("kt-filter")).toHaveTextContent("chapter")
    expect(screen.getByTestId("raw-sources")).toBeInTheDocument()

    fireEvent.click(screen.getByText("iconSidebar.usageGuide"))
    expect(mocks.openExternalUrl).toHaveBeenCalledWith(expect.stringContaining("feishu.cn"))
  })

  it("字数统计：读取失败或非章节模式时置空", async () => {
    mocks.listDirectory.mockRejectedValue(new Error("no chapters"))
    const { setState } = renderSidebar()
    await flushAsync()
    expect(screen.queryByText(/^total:/)).not.toBeInTheDocument()

    mocks.listDirectory.mockResolvedValue([])
    setState({ activeView: "sources" })
    await flushAsync()
    expect(screen.queryByText(/^total:/)).not.toBeInTheDocument()
    expect(screen.getByTestId("kt-filter")).toHaveTextContent("outline")
  })

  it("字数统计：卸载后完成回调不更新状态", async () => {
    let resolveList!: (value: FileNode[]) => void
    mocks.listDirectory.mockReturnValue(
      new Promise((resolve) => {
        resolveList = resolve
      }),
    )
    const { unmount } = renderSidebar()
    unmount()
    act(() => {
      resolveList([{ name: "c1.md", path: CH1, is_dir: false }])
    })
    await flushAsync()
    expect(mocks.countChapterBodyWords).toHaveBeenCalled()
  })

  it("章节导入菜单：展开/折叠/Escape/外部点击", () => {
    renderSidebar()
    const menuButton = screen.getByRole("button", { name: "导入" })
    fireEvent.click(menuButton)
    expect(screen.getByText("导入文件")).toBeInTheDocument()
    expect(screen.getByText("导入文件夹")).toBeInTheDocument()

    fireEvent.keyDown(document, { key: "Escape" })
    expect(screen.queryByText("导入文件")).not.toBeInTheDocument()

    fireEvent.click(menuButton)
    expect(screen.getByText("导入文件")).toBeInTheDocument()
    fireEvent.mouseDown(document.body)
    expect(screen.queryByText("导入文件")).not.toBeInTheDocument()

    fireEvent.click(menuButton)
    fireEvent.mouseDown(screen.getByText("导入文件"))
    expect(screen.getByText("导入文件")).toBeInTheDocument()

    fireEvent.click(menuButton)
    expect(screen.queryByText("导入文件")).not.toBeInTheDocument()
  })

  it("章节导入文件：提取记忆完整链路", async () => {
    mocks.dialogOpen.mockResolvedValue(["/tmp/ch1.md", "/tmp/ch2.md"])
    mocks.importChapterFiles.mockResolvedValue([{ sourcePath: CH1, path: CH1, title: "第一章", chapterNumber: 1 }])
    mocks.runImportedChapterMemoryExtraction.mockImplementation(
      async ({ onProgress }) => {
        onProgress?.({ completed: 0, total: 1, currentPath: null })
        onProgress?.({ completed: 1, total: 1, currentPath: "/p/mybook/wiki/chapters/other.md" })
        onProgress?.({ completed: 1, total: 1, currentPath: CH1 })
        return { cancelled: false, completed: 1, failed: 0, errors: [] }
      },
    )
    renderSidebar()

    fireEvent.click(screen.getByRole("button", { name: "导入" }))
    fireEvent.click(screen.getByText("导入文件"))
    await waitFor(() => expect(screen.getByText("是否提取记忆")).toBeInTheDocument())
    const dialog = within(screen.getByTestId("dialog-content"))
    expect(dialog.getByText(/本次将导入 2 个章节文档/)).toBeInTheDocument()

    fireEvent.click(dialog.getByText("提取记忆"))
    await waitFor(() => expect(mocks.importChapterFiles).toHaveBeenCalled())
    await waitFor(() =>
      expect(mocks.importChapterFiles).toHaveBeenCalledWith("/p/mybook", ["/tmp/ch1.md", "/tmp/ch2.md"], {
        finalForMemoryExtraction: true,
      }),
    )
    await waitFor(() => expect(mocks.importProgressActions.startTask).toHaveBeenCalled())
    expect(mocks.importProgressActions.startTask).toHaveBeenCalledWith(
      expect.objectContaining({ projectPath: "/p/mybook", kind: "chapter", total: 1, currentTitle: "第一章" }),
    )
    await waitFor(() => expect(mocks.importProgressActions.updateTask).toHaveBeenCalled())
    expect(mocks.importProgressActions.updateTask).toHaveBeenCalledWith("task-1", expect.objectContaining({ currentTitle: "" }))
    expect(mocks.importProgressActions.updateTask).toHaveBeenCalledWith(
      "task-1",
      expect.objectContaining({ currentTitle: "/p/mybook/wiki/chapters/other.md" }),
    )
    expect(mocks.importProgressActions.updateTask).toHaveBeenCalledWith(
      "task-1",
      expect.objectContaining({ completed: 1, currentTitle: "第一章" }),
    )
    await waitFor(() =>
      expect(mocks.importProgressActions.finishTask).toHaveBeenCalledWith(
        "task-1",
        "done",
        expect.objectContaining({ message: "记忆提取完成：成功 1 个章节。" }),
      ),
    )
    expect(mocks.invalidateChapterCache).toHaveBeenCalledWith("/p/mybook")
    expect(mocks.state.setFileTree).toHaveBeenCalled()
    expect(mocks.state.setSelectedFile).toHaveBeenCalledWith(CH1)
    expect(mocks.getStateSnapshot.bumpDataVersion).toHaveBeenCalled()
    // 菜单已关闭
    expect(screen.queryByText("导入文件")).not.toBeInTheDocument()
  })

  it("章节导入文件：只导入不提取记忆", async () => {
    mocks.dialogOpen.mockResolvedValue(["/tmp/ch1.md"])
    mocks.importChapterFiles.mockResolvedValue([{ sourcePath: CH1, path: CH1, title: "第一章", chapterNumber: 1 }])
    renderSidebar()

    fireEvent.click(screen.getByRole("button", { name: "导入" }))
    fireEvent.click(screen.getByText("导入文件"))
    await waitFor(() => expect(screen.getByText("是否提取记忆")).toBeInTheDocument())
    fireEvent.click(screen.getByText("只导入"))
    await waitFor(() =>
      expect(mocks.importChapterFiles).toHaveBeenCalledWith("/p/mybook", ["/tmp/ch1.md"], {
        finalForMemoryExtraction: false,
      }),
    )
    await flushAsync()
    expect(mocks.importProgressActions.startTask).not.toHaveBeenCalled()
    expect(mocks.invalidateChapterCache).toHaveBeenCalledWith("/p/mybook")
  })

  it("章节导入文件：取消导入不执行导入", async () => {
    mocks.dialogOpen.mockResolvedValue(["/tmp/ch1.md"])
    renderSidebar()

    fireEvent.click(screen.getByRole("button", { name: "导入" }))
    fireEvent.click(screen.getByText("导入文件"))
    await waitFor(() => expect(screen.getByText("是否提取记忆")).toBeInTheDocument())
    fireEvent.click(screen.getByText("取消导入"))
    await flushAsync()
    expect(mocks.importChapterFiles).not.toHaveBeenCalled()
    // 取消时菜单保持打开（源码未关闭）
    expect(screen.getByText("导入文件")).toBeInTheDocument()
  })

  it("章节导入文件：关闭对话框等价于取消", async () => {
    mocks.dialogOpen.mockResolvedValue(["/tmp/ch1.md"])
    renderSidebar()

    fireEvent.click(screen.getByRole("button", { name: "导入" }))
    fireEvent.click(screen.getByText("导入文件"))
    await waitFor(() => expect(screen.getByText("是否提取记忆")).toBeInTheDocument())
    fireEvent.click(screen.getByTestId("dialog-close"))
    await flushAsync()
    expect(mocks.importChapterFiles).not.toHaveBeenCalled()
  })

  it("章节导入文件：空结果时 alert", async () => {
    const alertSpy = vi.spyOn(window, "alert").mockImplementation(() => {})
    mocks.dialogOpen.mockResolvedValue(["/tmp/ch1.md"])
    mocks.importChapterFiles.mockResolvedValue([])
    renderSidebar()

    fireEvent.click(screen.getByRole("button", { name: "导入" }))
    fireEvent.click(screen.getByText("导入文件"))
    await waitFor(() => expect(screen.getByText("是否提取记忆")).toBeInTheDocument())
    fireEvent.click(screen.getByText("提取记忆"))
    await waitFor(() => expect(alertSpy).toHaveBeenCalledWith("没有找到可导入的章节文档。"))
    await flushAsync()
    expect(mocks.importProgressActions.startTask).not.toHaveBeenCalled()
  })

  it("章节导入文件：失败时 alert 导入失败", async () => {
    const alertSpy = vi.spyOn(window, "alert").mockImplementation(() => {})
    vi.spyOn(console, "error").mockImplementation(() => {})
    mocks.dialogOpen.mockResolvedValue(["/tmp/ch1.md"])
    mocks.importChapterFiles.mockRejectedValue(new Error("chapter boom"))
    renderSidebar()

    fireEvent.click(screen.getByRole("button", { name: "导入" }))
    fireEvent.click(screen.getByText("导入文件"))
    await waitFor(() => expect(screen.getByText("是否提取记忆")).toBeInTheDocument())
    fireEvent.click(screen.getByText("提取记忆"))
    await waitFor(() => expect(alertSpy).toHaveBeenCalledWith("导入失败：chapter boom"))
    await flushAsync()
    expect(console.error).toHaveBeenCalled()
  })

  it("章节导入文件夹：提取记忆完整链路", async () => {
    mocks.dialogOpen.mockResolvedValue("/tmp/folder")
    mocks.collectChapterImportCandidatesFromFolder.mockResolvedValue([{ path: "/tmp/folder/a.md", name: "a.md" }])
    mocks.importChapterFiles.mockResolvedValue([{ sourcePath: CH1, path: CH1, title: "第一章", chapterNumber: 1 }])
    renderSidebar()

    fireEvent.click(screen.getByRole("button", { name: "导入" }))
    fireEvent.click(screen.getByText("导入文件夹"))
    await waitFor(() =>
      expect(mocks.collectChapterImportCandidatesFromFolder).toHaveBeenCalledWith("/tmp/folder"),
    )
    await waitFor(() => expect(screen.getByText("是否提取记忆")).toBeInTheDocument())
    fireEvent.click(screen.getByText("提取记忆"))
    await waitFor(() =>
      expect(mocks.importChapterFiles).toHaveBeenCalledWith("/p/mybook", ["/tmp/folder/a.md"], {
        finalForMemoryExtraction: true,
      }),
    )
    await flushAsync()
    expect(mocks.invalidateChapterCache).toHaveBeenCalledWith("/p/mybook")
  })

  it("章节导入文件夹：无候选时 alert 并关闭菜单", async () => {
    const alertSpy = vi.spyOn(window, "alert").mockImplementation(() => {})
    mocks.dialogOpen.mockResolvedValue("/tmp/folder")
    mocks.collectChapterImportCandidatesFromFolder.mockResolvedValue([])
    renderSidebar()

    fireEvent.click(screen.getByRole("button", { name: "导入" }))
    fireEvent.click(screen.getByText("导入文件夹"))
    await waitFor(() => expect(alertSpy).toHaveBeenCalledWith("没有找到可导入的章节文档。"))
    expect(screen.queryByText("导入文件")).not.toBeInTheDocument()
  })

  it("章节导入文件夹：对话框返回数组时守卫返回", async () => {
    mocks.dialogOpen.mockResolvedValue([])
    renderSidebar()
    fireEvent.click(screen.getByRole("button", { name: "导入" }))
    fireEvent.click(screen.getByText("导入文件夹"))
    await flushAsync()
    expect(mocks.collectChapterImportCandidatesFromFolder).not.toHaveBeenCalled()
  })

  it("记忆提取：失败计数与取消结果文案", async () => {
    mocks.dialogOpen.mockResolvedValue(["/tmp/ch1.md"])
    mocks.importChapterFiles.mockResolvedValue([{ sourcePath: CH1, path: CH1, title: "第一章", chapterNumber: 1 }])
    mocks.runImportedChapterMemoryExtraction.mockResolvedValue({ cancelled: false, completed: 1, failed: 1, errors: [] })
    renderSidebar()
    fireEvent.click(screen.getByRole("button", { name: "导入" }))
    fireEvent.click(screen.getByText("导入文件"))
    await waitFor(() => screen.getByText("是否提取记忆"))
    fireEvent.click(screen.getByText("提取记忆"))
    await waitFor(() =>
      expect(mocks.importProgressActions.finishTask).toHaveBeenCalledWith(
        "task-1",
        "done",
        expect.objectContaining({ message: "记忆提取完成：成功 1 个，失败 1 个。" }),
      ),
    )
  })

  it("记忆提取：取消结果时以 cancelled 收尾", async () => {
    mocks.dialogOpen.mockResolvedValue(["/tmp/ch1.md"])
    mocks.importChapterFiles.mockResolvedValue([{ sourcePath: CH1, path: CH1, title: "第一章", chapterNumber: 1 }])
    mocks.runImportedChapterMemoryExtraction.mockResolvedValue({ cancelled: true, completed: 0, failed: 0, errors: [] })
    renderSidebar()
    fireEvent.click(screen.getByRole("button", { name: "导入" }))
    fireEvent.click(screen.getByText("导入文件"))
    await waitFor(() => screen.getByText("是否提取记忆"))
    fireEvent.click(screen.getByText("提取记忆"))
    await waitFor(() =>
      expect(mocks.importProgressActions.finishTask).toHaveBeenCalledWith(
        "task-1",
        "cancelled",
        expect.objectContaining({ message: "已取消记忆提取，已完成 0/1 个章节。" }),
      ),
    )
  })

  it("记忆提取进行中点击停止：markCancelling + abort", async () => {
    let capturedSignal: AbortSignal | undefined
    let resolveExtraction!: (value: ImportedChapterMemoryResult) => void
    mocks.dialogOpen.mockResolvedValue(["/tmp/ch1.md"])
    mocks.importChapterFiles.mockResolvedValue([{ sourcePath: CH1, path: CH1, title: "第一章", chapterNumber: 1 }])
    mocks.runImportedChapterMemoryExtraction.mockImplementation(
      ({ signal }) =>
        new Promise((resolve) => {
          capturedSignal = signal
          resolveExtraction = resolve
        }),
    )
    renderSidebar()
    fireEvent.click(screen.getByRole("button", { name: "导入" }))
    fireEvent.click(screen.getByText("导入文件"))
    await waitFor(() => screen.getByText("是否提取记忆"))
    fireEvent.click(screen.getByText("提取记忆"))
    await waitFor(() => expect(mocks.importProgressActions.startTask).toHaveBeenCalled())

    fireEvent.click(screen.getByTestId("raw-cancel"))
    expect(mocks.importProgressActions.markCancelling).toHaveBeenCalledWith("task-1")
    expect(capturedSignal?.aborted).toBe(true)

    act(() => {
      resolveExtraction({ cancelled: true, completed: 0, failed: 0, errors: [] })
    })
    await waitFor(() =>
      expect(mocks.importProgressActions.finishTask).toHaveBeenCalledWith(
        "task-1",
        "cancelled",
        expect.objectContaining({ message: expect.stringContaining("已取消记忆提取") }),
      ),
    )
  })

  it("无任务时点击停止不调用 markCancelling", () => {
    renderSidebar()
    fireEvent.click(screen.getByTestId("raw-cancel"))
    expect(mocks.importProgressActions.markCancelling).not.toHaveBeenCalled()
  })

  it("导入中再次触发被 chapterImporting 守卫拦截", async () => {
    let resolveImport!: (value: ImportedChapter[]) => void
    mocks.dialogOpen.mockResolvedValue(["/tmp/ch1.md"])
    mocks.importChapterFiles.mockReturnValue(
      new Promise((resolve) => {
        resolveImport = resolve
      }),
    )
    renderSidebar()
    fireEvent.click(screen.getByRole("button", { name: "导入" }))
    fireEvent.click(screen.getByText("导入文件"))
    await waitFor(() => screen.getByText("是否提取记忆"))
    fireEvent.click(screen.getByText("提取记忆"))
    await waitFor(() => expect(screen.getByText("导入中...")).toBeInTheDocument())

    fireEvent.click(screen.getByRole("button", { name: "导入中..." }))
    await flushAsync()
    expect(mocks.dialogOpen).toHaveBeenCalledTimes(1)

    act(() => {
      resolveImport([{ sourcePath: CH1, path: CH1, title: "第一章", chapterNumber: 1 }])
    })
    await flushAsync()
  })

  it("章节导入文件：对话框返回单个字符串时归一为数组", async () => {
    mocks.dialogOpen.mockResolvedValue("/tmp/single.md")
    mocks.importChapterFiles.mockResolvedValue([{ sourcePath: CH1, path: CH1, title: "第一章", chapterNumber: 1 }])
    renderSidebar()
    fireEvent.click(screen.getByRole("button", { name: "导入" }))
    fireEvent.click(screen.getByText("导入文件"))
    await waitFor(() => screen.getByText("是否提取记忆"))
    fireEvent.click(screen.getByText("提取记忆"))
    await waitFor(() =>
      expect(mocks.importChapterFiles).toHaveBeenCalledWith("/p/mybook", ["/tmp/single.md"], {
        finalForMemoryExtraction: true,
      }),
    )
    await flushAsync()
  })

  it("章节导入文件：对话框返回空数组时守卫返回", async () => {
    mocks.dialogOpen.mockResolvedValue([])
    renderSidebar()
    fireEvent.click(screen.getByRole("button", { name: "导入" }))
    fireEvent.click(screen.getByText("导入文件"))
    await flushAsync()
    expect(screen.queryByText("是否提取记忆")).not.toBeInTheDocument()
    expect(mocks.importChapterFiles).not.toHaveBeenCalled()
  })

  it("章节导入文件：非 Error 拒绝时 alert 字符串", async () => {
    const alertSpy = vi.spyOn(window, "alert").mockImplementation(() => {})
    vi.spyOn(console, "error").mockImplementation(() => {})
    mocks.dialogOpen.mockResolvedValue(["/tmp/ch1.md"])
    mocks.importChapterFiles.mockRejectedValue("chapter-boom-str")
    renderSidebar()
    fireEvent.click(screen.getByRole("button", { name: "导入" }))
    fireEvent.click(screen.getByText("导入文件"))
    await waitFor(() => screen.getByText("是否提取记忆"))
    fireEvent.click(screen.getByText("提取记忆"))
    await waitFor(() => expect(alertSpy).toHaveBeenCalledWith("导入失败：chapter-boom-str"))
    await flushAsync()
  })

  it("章节导入文件夹：取消导入不执行导入", async () => {
    mocks.dialogOpen.mockResolvedValue("/tmp/folder")
    mocks.collectChapterImportCandidatesFromFolder.mockResolvedValue([{ path: "/tmp/folder/a.md", name: "a.md" }])
    renderSidebar()
    fireEvent.click(screen.getByRole("button", { name: "导入" }))
    fireEvent.click(screen.getByText("导入文件夹"))
    await waitFor(() => screen.getByText("是否提取记忆"))
    fireEvent.click(screen.getByText("取消导入"))
    await flushAsync()
    expect(mocks.importChapterFiles).not.toHaveBeenCalled()
  })

  it("章节导入文件夹：失败时 alert 导入失败（Error 对象）", async () => {
    const alertSpy = vi.spyOn(window, "alert").mockImplementation(() => {})
    vi.spyOn(console, "error").mockImplementation(() => {})
    mocks.dialogOpen.mockResolvedValue("/tmp/folder")
    mocks.collectChapterImportCandidatesFromFolder.mockResolvedValue([{ path: "/tmp/folder/a.md", name: "a.md" }])
    mocks.importChapterFiles.mockRejectedValue(new Error("folder-err"))
    renderSidebar()
    fireEvent.click(screen.getByRole("button", { name: "导入" }))
    fireEvent.click(screen.getByText("导入文件夹"))
    await waitFor(() => screen.getByText("是否提取记忆"))
    fireEvent.click(screen.getByText("提取记忆"))
    await waitFor(() => expect(alertSpy).toHaveBeenCalledWith("导入失败：folder-err"))
    await flushAsync()
  })

  it("章节导入文件夹：非 Error 拒绝时 alert 导入失败（非 Error）", async () => {
    const alertSpy = vi.spyOn(window, "alert").mockImplementation(() => {})
    vi.spyOn(console, "error").mockImplementation(() => {})
    mocks.dialogOpen.mockResolvedValue("/tmp/folder")
    mocks.collectChapterImportCandidatesFromFolder.mockResolvedValue([{ path: "/tmp/folder/a.md", name: "a.md" }])
    mocks.importChapterFiles.mockRejectedValue("folder-boom-str")
    renderSidebar()
    fireEvent.click(screen.getByRole("button", { name: "导入" }))
    fireEvent.click(screen.getByText("导入文件夹"))
    await waitFor(() => screen.getByText("是否提取记忆"))
    fireEvent.click(screen.getByText("提取记忆"))
    await waitFor(() => expect(alertSpy).toHaveBeenCalledWith("导入失败：folder-boom-str"))
    await flushAsync()
    expect(console.error).toHaveBeenCalled()
  })

  it("章节导入菜单：事件 target 非 Node 时早退", () => {
    const addEventListenerSpy = vi.spyOn(document, "addEventListener")
    const { unmount } = renderSidebar()
    fireEvent.click(screen.getByRole("button", { name: "导入" }))

    const call = [...addEventListenerSpy.mock.calls].reverse().find(([type]) => type === "mousedown")
    const listener = call?.[1] as unknown as (event: MouseEvent) => void
    listener({ target: {} } as unknown as MouseEvent)
    expect(screen.getByText("导入文件")).toBeInTheDocument()

    fireEvent.keyDown(document, { key: "Escape" })
    unmount()
  })

  it("章节导入：无项目时文件与文件夹入口均由守卫返回", async () => {
    renderSidebar({ project: null })
    fireEvent.click(screen.getByRole("button", { name: "导入" }))
    fireEvent.click(screen.getByText("导入文件"))
    fireEvent.click(screen.getByText("导入文件夹"))
    await flushAsync()
    expect(mocks.dialogOpen).not.toHaveBeenCalled()
  })

  it("章节记忆提取：章节标题缺失时初始标题回退为空", async () => {
    mocks.dialogOpen.mockResolvedValue(["/tmp/ch1.md"])
    mocks.importChapterFiles.mockResolvedValue([{ sourcePath: CH1, path: CH1, title: undefined as unknown as string, chapterNumber: 1 }])
    renderSidebar()

    fireEvent.click(screen.getByRole("button", { name: "导入" }))
    fireEvent.click(screen.getByText("导入文件"))
    await waitFor(() => expect(screen.getByText("是否提取记忆")).toBeInTheDocument())
    fireEvent.click(screen.getByText("提取记忆"))
    await waitFor(() =>
      expect(mocks.importProgressActions.startTask).toHaveBeenCalledWith(
        expect.objectContaining({ currentTitle: "" }),
      ),
    )
  })

  it("章节导入菜单：非 Escape 按键不关闭", () => {
    renderSidebar()
    fireEvent.click(screen.getByRole("button", { name: "导入" }))
    fireEvent.keyDown(document, { key: "ArrowDown" })
    expect(screen.getByText("导入文件")).toBeInTheDocument()
    fireEvent.keyDown(document, { key: "Escape" })
    expect(screen.queryByText("导入文件")).not.toBeInTheDocument()
  })

  it("字数统计：卸载后读取失败不更新状态", async () => {
    let rejectList!: (reason: unknown) => void
    mocks.listDirectory.mockReturnValue(
      new Promise((_resolve, reject) => {
        rejectList = reject
      }),
    )
    const { unmount } = renderSidebar()
    unmount()
    act(() => {
      rejectList(new Error("late fail"))
    })
    await flushAsync()
  })

  it("新建章节：无项目时守卫返回", async () => {
    renderSidebar({ project: null })
    fireEvent.click(screen.getByTitle("sidebar.newChapter"))
    await flushAsync()
    expect(mocks.createDirectory).not.toHaveBeenCalled()
    expect(mocks.writeFile).not.toHaveBeenCalled()
  })

  it("新建章节：写入失败时吞掉并记录 error", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    mocks.listDirectory.mockResolvedValue([])
    mocks.writeFile.mockRejectedValue(new Error("write boom"))
    renderSidebar()
    await flushAsync()
    fireEvent.click(screen.getByTitle("sidebar.newChapter"))
    await waitFor(() => expect(errorSpy).toHaveBeenCalled())
    await flushAsync()
    expect(screen.getByTitle("sidebar.newChapter")).not.toBeDisabled()
  })

  it("连续新建章节：pending 页面去重保留", async () => {
    mocks.listDirectory.mockImplementation(async (path: string) => {
      if (path === "/p/mybook/wiki/chapters") {
        return [{ name: "c1.md", path: "/p/mybook/wiki/chapters/c1.md", is_dir: false }]
      }
      return []
    })
    mocks.readFile.mockImplementation(async (path: string) => (path.endsWith("c1.md") ? "---\ntitle: \"第1章\"\n---\n" : ""))
    mocks.getNextChapterNumber.mockResolvedValueOnce(1).mockResolvedValueOnce(3)
    renderSidebar()
    await flushAsync()

    fireEvent.click(screen.getByTitle("sidebar.newChapter"))
    await waitFor(() => expect(mocks.writeFile).toHaveBeenCalledTimes(1))
    await flushAsync()
    fireEvent.click(screen.getByTitle("sidebar.newChapter"))
    await waitFor(() => expect(mocks.writeFile).toHaveBeenCalledTimes(2))
    await flushAsync()

    const pending = screen.getByTestId("kt-pending").textContent ?? ""
    expect(pending).toContain("/p/mybook/wiki/chapters/chapter-2-第2章.md")
    expect(pending).toContain("/p/mybook/wiki/chapters/chapter-3-第3章.md")
  })

  it("新建大纲：无项目时守卫返回", async () => {
    renderSidebar({ project: null, activeView: "sources" })
    fireEvent.click(screen.getByTitle("sidebar.newOutline"))
    const input = screen.getByPlaceholderText("sidebar.newOutlinePrompt")
    fireEvent.change(input, { target: { value: "标题" } })
    fireEvent.click(screen.getByText("创建"))
    await flushAsync()
    expect(mocks.writeFile).not.toHaveBeenCalled()
  })
})

describe("SidebarPanel 文件模式（大纲）", () => {
  beforeEach(() => {
    cleanup()
    setupDomGlobals()
    vi.clearAllMocks()
    Object.assign(mocks.state, {
      project: DEFAULT_PROJECT,
      activeView: "sources",
      novelMode: true,
      selectedFile: null,
      selectedMemoryCenterEntry: null,
      dataVersion: 0,
      searchHistory: [],
      selectedDismantlingProjectId: null,
    })
    mocks.listDirectory.mockResolvedValue([])
    mocks.readFile.mockResolvedValue("")
    mocks.dialogOpen.mockResolvedValue(null)
    mocks.importOutlineFiles.mockResolvedValue([])
    mocks.importOutlineCandidates.mockResolvedValue([])
    mocks.collectOutlineImportCandidatesFromFolder.mockResolvedValue([])
    mocks.runOutlineIngestTask.mockResolvedValue(undefined)
    mocks.createOutlineIngestTask.mockImplementation((_p: string, path: string) => `outline-task:${path}`)
    mocks.importProgressActions.startTask.mockReturnValue("task-1")
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("文件模式渲染 outline 过滤器与导入菜单文案", () => {
    renderSidebar()
    expect(screen.getByTestId("kt-filter")).toHaveTextContent("outline")
    expect(screen.getByRole("button", { name: "sources.import" })).toBeInTheDocument()
  })

  it("大纲导入文件：成功链路", async () => {
    mocks.dialogOpen.mockResolvedValue(["/tmp/o1.md"])
    mocks.importOutlineFiles.mockResolvedValue(["/p/mybook/wiki/outlines/o1.md"])
    renderSidebar()
    fireEvent.click(screen.getByRole("button", { name: "sources.import" }))
    fireEvent.click(screen.getByText("sources.importFiles"))
    await waitFor(() => expect(mocks.importOutlineFiles).toHaveBeenCalledWith("/p/mybook", ["/tmp/o1.md"]))
    await waitFor(() => expect(mocks.state.setSelectedFile).toHaveBeenCalledWith("/p/mybook/wiki/outlines/o1.md"))
    await flushAsync()
    expect(screen.queryByText("sources.importFiles")).not.toBeInTheDocument()
  })

  it("大纲导入文件：空结果 alert", async () => {
    const alertSpy = vi.spyOn(window, "alert").mockImplementation(() => {})
    mocks.dialogOpen.mockResolvedValue(["/tmp/o1.md"])
    renderSidebar()
    fireEvent.click(screen.getByRole("button", { name: "sources.import" }))
    fireEvent.click(screen.getByText("sources.importFiles"))
    await waitFor(() => expect(alertSpy).toHaveBeenCalledWith("novel.outlineImport.emptyResult"))
    await flushAsync()
  })

  it("大纲导入文件：失败 alert 带消息", async () => {
    const alertSpy = vi.spyOn(window, "alert").mockImplementation(() => {})
    vi.spyOn(console, "error").mockImplementation(() => {})
    mocks.dialogOpen.mockResolvedValue(["/tmp/o1.md"])
    mocks.importOutlineFiles.mockRejectedValue(new Error("outline boom"))
    renderSidebar()
    fireEvent.click(screen.getByRole("button", { name: "sources.import" }))
    fireEvent.click(screen.getByText("sources.importFiles"))
    await waitFor(() => expect(alertSpy).toHaveBeenCalledWith("novel.outlineImport.importFailed"))
    await flushAsync()
    expect(console.error).toHaveBeenCalled()
  })

  it("大纲导入文件夹：提取记忆完成链路", async () => {
    mocks.dialogOpen.mockResolvedValue("/tmp/ofolder")
    mocks.collectOutlineImportCandidatesFromFolder.mockResolvedValue([
      { path: "/tmp/ofolder/o1.md", name: "o1.md", targetFolders: [] },
      { path: "/tmp/ofolder/o2.md", name: "o2.md", targetFolders: [] },
    ])
    mocks.importOutlineCandidates.mockResolvedValue([
      "/p/mybook/wiki/outlines/o1.md",
      "/p/mybook/wiki/outlines/o2.md",
    ])
    renderSidebar()
    fireEvent.click(screen.getByRole("button", { name: "sources.import" }))
    fireEvent.click(screen.getByText("sources.importFolder"))
    await waitFor(() => expect(screen.getByText("是否提取记忆")).toBeInTheDocument())
    const dialog = within(screen.getByTestId("dialog-content"))
    expect(dialog.getByText(/本次将导入 2 个 AI 大纲文档/)).toBeInTheDocument()

    fireEvent.click(dialog.getByText("提取记忆"))
    await waitFor(() => expect(mocks.importOutlineCandidates).toHaveBeenCalled())
    expect(mocks.importOutlineCandidates).toHaveBeenCalledWith(
      "/p/mybook",
      [
        { path: "/tmp/ofolder/o1.md", name: "o1.md", targetFolders: [] },
        { path: "/tmp/ofolder/o2.md", name: "o2.md", targetFolders: [] },
      ],
    )
    await waitFor(() => expect(mocks.importProgressActions.startTask).toHaveBeenCalled())
    expect(mocks.importProgressActions.startTask).toHaveBeenCalledWith(
      expect.objectContaining({ projectPath: "/p/mybook", kind: "outline", total: 2 }),
    )
    await waitFor(() =>
      expect(mocks.importProgressActions.finishTask).toHaveBeenCalledWith(
        "task-1",
        "done",
        expect.objectContaining({ message: "大纲记忆提取完成：成功 2 个大纲。" }),
      ),
    )
    expect(mocks.createOutlineIngestTask).toHaveBeenCalledTimes(2)
    expect(mocks.runOutlineIngestTask).toHaveBeenCalledTimes(2)
    expect(mocks.state.setSelectedFile).toHaveBeenCalledWith("/p/mybook/wiki/outlines/o1.md")
  })

  it("大纲导入文件夹：提取中途取消", async () => {
    let resolveIngest!: (value: void) => void
    mocks.dialogOpen.mockResolvedValue("/tmp/ofolder")
    mocks.collectOutlineImportCandidatesFromFolder.mockResolvedValue([
      { path: "/tmp/ofolder/o1.md", name: "o1.md", targetFolders: [] },
      { path: "/tmp/ofolder/o2.md", name: "o2.md", targetFolders: [] },
    ])
    mocks.importOutlineCandidates.mockResolvedValue([
      "/p/mybook/wiki/outlines/o1.md",
      "/p/mybook/wiki/outlines/o2.md",
    ])
    mocks.runOutlineIngestTask.mockReturnValue(
      new Promise((resolve) => {
        resolveIngest = resolve
      }),
    )
    renderSidebar()
    fireEvent.click(screen.getByRole("button", { name: "sources.import" }))
    fireEvent.click(screen.getByText("sources.importFolder"))
    await waitFor(() => screen.getByText("是否提取记忆"))
    fireEvent.click(screen.getByText("提取记忆"))
    await waitFor(() => expect(mocks.importProgressActions.startTask).toHaveBeenCalled())

    fireEvent.click(screen.getByTestId("raw-cancel"))
    expect(mocks.importProgressActions.markCancelling).toHaveBeenCalledWith("task-1")
    act(() => {
      resolveIngest(undefined)
    })
    await waitFor(() =>
      expect(mocks.importProgressActions.finishTask).toHaveBeenCalledWith(
        "task-1",
        "cancelled",
        expect.objectContaining({ message: "已取消大纲记忆提取，已完成 1/2 个大纲。" }),
      ),
    )
  })

  it("大纲导入文件夹：无候选时 alert 并关闭菜单", async () => {
    const alertSpy = vi.spyOn(window, "alert").mockImplementation(() => {})
    mocks.dialogOpen.mockResolvedValue("/tmp/ofolder")
    renderSidebar()
    fireEvent.click(screen.getByRole("button", { name: "sources.import" }))
    fireEvent.click(screen.getByText("sources.importFolder"))
    await waitFor(() => expect(alertSpy).toHaveBeenCalledWith("novel.outlineImport.emptyResult"))
    expect(screen.queryByText("sources.importFolder")).not.toBeInTheDocument()
  })

  it("大纲导入文件夹：取消导入不执行导入", async () => {
    mocks.dialogOpen.mockResolvedValue("/tmp/ofolder")
    mocks.collectOutlineImportCandidatesFromFolder.mockResolvedValue([{ path: "/tmp/ofolder/o1.md", name: "o1.md", targetFolders: [] }])
    renderSidebar()
    fireEvent.click(screen.getByRole("button", { name: "sources.import" }))
    fireEvent.click(screen.getByText("sources.importFolder"))
    await waitFor(() => screen.getByText("是否提取记忆"))
    fireEvent.click(screen.getByText("取消导入"))
    await flushAsync()
    expect(mocks.importOutlineCandidates).not.toHaveBeenCalled()
  })

  it("大纲导入文件夹：对话框返回非字符串时守卫返回", async () => {
    mocks.dialogOpen.mockResolvedValue(123)
    renderSidebar()
    fireEvent.click(screen.getByRole("button", { name: "sources.import" }))
    fireEvent.click(screen.getByText("sources.importFolder"))
    await flushAsync()
    expect(mocks.collectOutlineImportCandidatesFromFolder).not.toHaveBeenCalled()
  })

  it("大纲导入中再次触发被 outlineImporting 守卫拦截", async () => {
    let resolveImport!: (value: string[]) => void
    mocks.dialogOpen.mockResolvedValue(["/tmp/o1.md"])
    mocks.importOutlineFiles.mockReturnValue(
      new Promise((resolve) => {
        resolveImport = resolve
      }),
    )
    renderSidebar()
    fireEvent.click(screen.getByRole("button", { name: "sources.import" }))
    fireEvent.click(screen.getByText("sources.importFiles"))
    await waitFor(() => expect(screen.getByRole("button", { name: "sources.importing" })).toBeInTheDocument())

    fireEvent.click(screen.getByRole("button", { name: "sources.importing" }))
    await flushAsync()
    expect(mocks.dialogOpen).toHaveBeenCalledTimes(1)

    act(() => {
      resolveImport(["/p/mybook/wiki/outlines/o1.md"])
    })
    await flushAsync()
  })

  it("大纲导入菜单：Escape 与外部点击关闭", () => {
    renderSidebar()
    fireEvent.click(screen.getByRole("button", { name: "sources.import" }))
    expect(screen.getByText("sources.importFiles")).toBeInTheDocument()
    fireEvent.keyDown(document, { key: "Escape" })
    expect(screen.queryByText("sources.importFiles")).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole("button", { name: "sources.import" }))
    fireEvent.mouseDown(document.body)
    expect(screen.queryByText("sources.importFiles")).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole("button", { name: "sources.import" }))
    fireEvent.mouseDown(screen.getByText("sources.importFiles"))
    expect(screen.getByText("sources.importFiles")).toBeInTheDocument()
  })

  it("大纲导入菜单：对话框监听器收到非法 target 时早退", () => {
    const addEventListenerSpy = vi.spyOn(document, "addEventListener")
    const { unmount } = renderSidebar()
    fireEvent.click(screen.getByRole("button", { name: "sources.import" }))

    const call = [...addEventListenerSpy.mock.calls].reverse().find(([type]) => type === "mousedown")
    const listener = call?.[1] as unknown as (event: MouseEvent) => void
    listener({ target: {} } as unknown as MouseEvent)
    expect(screen.getByText("sources.importFiles")).toBeInTheDocument()

    fireEvent.keyDown(document, { key: "Escape" })
    unmount()
  })

  it("大纲导入：无项目时文件与文件夹 handler 守卫返回", async () => {
    renderSidebar({ project: null, activeView: "sources" })
    fireEvent.click(screen.getByRole("button", { name: "sources.import" }))
    fireEvent.click(screen.getByText("sources.importFiles"))
    fireEvent.click(screen.getByText("sources.importFolder"))
    await flushAsync()
    expect(mocks.dialogOpen).not.toHaveBeenCalled()
  })

  it("大纲导入文件夹：缺失首个路径时当前标题回退为空", async () => {
    mocks.dialogOpen.mockResolvedValue("/tmp/ofolder")
    mocks.collectOutlineImportCandidatesFromFolder.mockResolvedValue([{ path: "/tmp/ofolder/o1.md", name: "o1.md", targetFolders: [] }])
    mocks.importOutlineCandidates.mockResolvedValue([undefined as unknown as string])
    mocks.getFileName
      .mockImplementationOnce((path: string) => path.split("/").pop() ?? path)
      .mockImplementationOnce(() => "")
    renderSidebar()

    fireEvent.click(screen.getByRole("button", { name: "sources.import" }))
    fireEvent.click(screen.getByText("sources.importFolder"))
    await waitFor(() => expect(screen.getByText("是否提取记忆")).toBeInTheDocument())
    fireEvent.click(screen.getByText("提取记忆"))
    await waitFor(() =>
      expect(mocks.importProgressActions.startTask).toHaveBeenCalledWith(
        expect.objectContaining({ currentTitle: "" }),
      ),
    )
    expect(mocks.createOutlineIngestTask).toHaveBeenCalledWith("/p/mybook", undefined)
  })

  it("大纲导入菜单：非 Escape 按键不关闭", () => {
    renderSidebar()
    fireEvent.click(screen.getByRole("button", { name: "sources.import" }))
    fireEvent.keyDown(document, { key: "ArrowDown" })
    expect(screen.getByText("sources.importFiles")).toBeInTheDocument()
    fireEvent.keyDown(document, { key: "Escape" })
    expect(screen.queryByText("sources.importFiles")).not.toBeInTheDocument()
  })

  it("大纲导入文件：对话框返回空数组时守卫返回", async () => {
    mocks.dialogOpen.mockResolvedValue([])
    renderSidebar()
    fireEvent.click(screen.getByRole("button", { name: "sources.import" }))
    fireEvent.click(screen.getByText("sources.importFiles"))
    await flushAsync()
    expect(mocks.importOutlineFiles).not.toHaveBeenCalled()
  })

  it("大纲导入文件：对话框返回单个字符串时归一为数组", async () => {
    mocks.dialogOpen.mockResolvedValue("/tmp/single-outline.md")
    mocks.importOutlineFiles.mockResolvedValue(["/p/mybook/wiki/outlines/single-outline.md"])
    renderSidebar()
    fireEvent.click(screen.getByRole("button", { name: "sources.import" }))
    fireEvent.click(screen.getByText("sources.importFiles"))
    await waitFor(() => expect(mocks.importOutlineFiles).toHaveBeenCalledWith("/p/mybook", ["/tmp/single-outline.md"]))
    await flushAsync()
  })

  it("大纲导入文件：非 Error 拒绝时 alert 失败", async () => {
    const alertSpy = vi.spyOn(window, "alert").mockImplementation(() => {})
    vi.spyOn(console, "error").mockImplementation(() => {})
    mocks.dialogOpen.mockResolvedValue(["/tmp/o1.md"])
    mocks.importOutlineFiles.mockRejectedValue("outline-boom-str")
    renderSidebar()
    fireEvent.click(screen.getByRole("button", { name: "sources.import" }))
    fireEvent.click(screen.getByText("sources.importFiles"))
    await waitFor(() => expect(alertSpy).toHaveBeenCalledWith("novel.outlineImport.importFailed"))
    await flushAsync()
  })

  it("大纲导入文件夹：只导入不提取记忆", async () => {
    mocks.dialogOpen.mockResolvedValue("/tmp/ofolder")
    mocks.collectOutlineImportCandidatesFromFolder.mockResolvedValue([{ path: "/tmp/ofolder/o1.md", name: "o1.md", targetFolders: [] }])
    mocks.importOutlineCandidates.mockResolvedValue(["/p/mybook/wiki/outlines/o1.md"])
    renderSidebar()
    fireEvent.click(screen.getByRole("button", { name: "sources.import" }))
    fireEvent.click(screen.getByText("sources.importFolder"))
    await waitFor(() => screen.getByText("是否提取记忆"))
    fireEvent.click(screen.getByText("只导入"))
    await waitFor(() => expect(mocks.importOutlineCandidates).toHaveBeenCalled())
    await flushAsync()
    expect(mocks.importProgressActions.startTask).not.toHaveBeenCalled()
    expect(mocks.state.setSelectedFile).toHaveBeenCalledWith("/p/mybook/wiki/outlines/o1.md")
  })

  it("大纲导入文件夹：导入结果为空时 alert 并返回", async () => {
    const alertSpy = vi.spyOn(window, "alert").mockImplementation(() => {})
    mocks.dialogOpen.mockResolvedValue("/tmp/ofolder")
    mocks.collectOutlineImportCandidatesFromFolder.mockResolvedValue([{ path: "/tmp/ofolder/o1.md", name: "o1.md", targetFolders: [] }])
    mocks.importOutlineCandidates.mockResolvedValue([])
    renderSidebar()
    fireEvent.click(screen.getByRole("button", { name: "sources.import" }))
    fireEvent.click(screen.getByText("sources.importFolder"))
    await waitFor(() => screen.getByText("是否提取记忆"))
    fireEvent.click(screen.getByText("提取记忆"))
    await waitFor(() => expect(alertSpy).toHaveBeenCalledWith("novel.outlineImport.emptyResult"))
    await flushAsync()
    expect(mocks.importProgressActions.startTask).not.toHaveBeenCalled()
  })

  it("大纲导入文件夹：非 Error 拒绝时 alert 失败", async () => {
    const alertSpy = vi.spyOn(window, "alert").mockImplementation(() => {})
    vi.spyOn(console, "error").mockImplementation(() => {})
    mocks.dialogOpen.mockResolvedValue("/tmp/ofolder")
    mocks.collectOutlineImportCandidatesFromFolder.mockResolvedValue([{ path: "/tmp/ofolder/o1.md", name: "o1.md", targetFolders: [] }])
    mocks.importOutlineCandidates.mockRejectedValue("folder-outline-boom-str")
    renderSidebar()
    fireEvent.click(screen.getByRole("button", { name: "sources.import" }))
    fireEvent.click(screen.getByText("sources.importFolder"))
    await waitFor(() => screen.getByText("是否提取记忆"))
    fireEvent.click(screen.getByText("提取记忆"))
    await waitFor(() => expect(alertSpy).toHaveBeenCalledWith("novel.outlineImport.importFailed"))
    await flushAsync()
  })

  it("大纲导入文件夹：失败时 alert（Error 对象）", async () => {
    const alertSpy = vi.spyOn(window, "alert").mockImplementation(() => {})
    vi.spyOn(console, "error").mockImplementation(() => {})
    mocks.dialogOpen.mockResolvedValue("/tmp/ofolder")
    mocks.collectOutlineImportCandidatesFromFolder.mockResolvedValue([{ path: "/tmp/ofolder/o1.md", name: "o1.md", targetFolders: [] }])
    mocks.importOutlineCandidates.mockRejectedValue(new Error("outline-folder-err"))
    renderSidebar()
    fireEvent.click(screen.getByRole("button", { name: "sources.import" }))
    fireEvent.click(screen.getByText("sources.importFolder"))
    await waitFor(() => screen.getByText("是否提取记忆"))
    fireEvent.click(screen.getByText("提取记忆"))
    await waitFor(() => expect(alertSpy).toHaveBeenCalledWith("novel.outlineImport.importFailed"))
    await flushAsync()
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining("[SidebarPanel] outline folder import failed:"),
      new Error("outline-folder-err"),
    )
  })
})

describe("SidebarPanel 创建流程", () => {
  beforeEach(() => {
    cleanup()
    setupDomGlobals()
    vi.clearAllMocks()
    Object.assign(mocks.state, {
      project: DEFAULT_PROJECT,
      activeView: "wiki",
      novelMode: true,
      selectedFile: null,
      selectedMemoryCenterEntry: null,
      dataVersion: 0,
      searchHistory: [],
      selectedDismantlingProjectId: null,
    })
    mocks.listDirectory.mockResolvedValue([])
    mocks.readFile.mockResolvedValue("")
    mocks.fileExists.mockResolvedValue(false)
    mocks.writeFile.mockResolvedValue(undefined)
    mocks.createDirectory.mockResolvedValue(undefined)
    mocks.getNextChapterNumber.mockResolvedValue(1)
    mocks.flattenMdFiles.mockImplementation(
      (nodes) => nodes.filter((n) => !n.is_dir && n.name.endsWith(".md")).map((n) => ({ name: n.name, path: n.path })),
    )
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("新建章节：无扩展名文件冲突时追加编号", async () => {
    mocks.listDirectory.mockResolvedValue([])
    mocks.makeChapterFileName.mockImplementationOnce(() => "chapter-no-ext")
    mocks.fileExists.mockImplementation(async (path: string) =>
      path === "/p/mybook/wiki/chapters/chapter-no-ext",
    )
    renderSidebar()
    await flushAsync()

    fireEvent.click(screen.getByTitle("sidebar.newChapter"))
    await waitFor(() => expect(mocks.writeFile).toHaveBeenCalled())
    expect(mocks.writeFile).toHaveBeenCalledWith(
      "/p/mybook/wiki/chapters/chapter-no-ext-2",
      expect.any(String),
    )
  })

  it("新建章节：编号递增、标题去重、写入 frontmatter、刷新树", async () => {
    mocks.listDirectory.mockImplementation(async (path: string) => {
      if (path === "/p/mybook/wiki/chapters") {
        return [
          { name: "c1.md", path: "/p/mybook/wiki/chapters/c1.md", is_dir: false },
          { name: "c2.md", path: "/p/mybook/wiki/chapters/c2.md", is_dir: false },
          { name: "c3.md", path: "/p/mybook/wiki/chapters/c3.md", is_dir: false },
        ]
      }
      return []
    })
    mocks.readFile.mockImplementation(async (path: string) => {
      if (path.endsWith("c1.md")) return "---\ntitle: \"第1章\"\n---\n"
      if (path.endsWith("c2.md")) return "# 无标题章节\n\n正文"
      throw new Error("unreadable")
    })
    mocks.getNextChapterNumber.mockResolvedValue(1)
    renderSidebar()
    await flushAsync()

    fireEvent.click(screen.getByTitle("sidebar.newChapter"))
    await waitFor(() => expect(mocks.writeFile).toHaveBeenCalled())
    await flushAsync()

    const filePath = "/p/mybook/wiki/chapters/chapter-2-第2章.md"
    expect(mocks.writeFile).toHaveBeenCalledWith(filePath, expect.stringContaining("chapter_number: 2"))
    expect(mocks.writeFile).toHaveBeenCalledWith(filePath, expect.stringContaining('title: "第2章"'))
    expect(mocks.invalidateChapterCache).toHaveBeenCalledWith("/p/mybook")
    expect(mocks.createDirectory).toHaveBeenCalledWith("/p/mybook/wiki/chapters")
    expect(mocks.state.setSelectedFile).toHaveBeenCalledWith(filePath)
    expect(mocks.state.setFileTree).toHaveBeenCalled()
    expect(screen.getByTestId("kt-pending")).toHaveTextContent(filePath)
  })

  it("新建章节：unique 路径冲突时追加 -2 后缀", async () => {
    mocks.listDirectory.mockImplementation(async (path: string) => {
      if (path === "/p/mybook/wiki/chapters") {
        return [{ name: "c1.md", path: "/p/mybook/wiki/chapters/c1.md", is_dir: false }]
      }
      return []
    })
    mocks.readFile.mockImplementation(async (path: string) => (path.endsWith("c1.md") ? "---\ntitle: \"第1章\"\n---\n" : ""))
    const firstPath = "/p/mybook/wiki/chapters/chapter-2-第2章.md"
    mocks.fileExists.mockImplementation(async (path: string) => path === firstPath)
    renderSidebar()
    await flushAsync()

    fireEvent.click(screen.getByTitle("sidebar.newChapter"))
    await waitFor(() => expect(mocks.writeFile).toHaveBeenCalled())
    await flushAsync()

    expect(mocks.writeFile).toHaveBeenCalledWith(
      "/p/mybook/wiki/chapters/chapter-2-第2章-2.md",
      expect.stringContaining("chapter_number: 2"),
    )
  })

  it("新建章节：99 次冲突后回退到 Date.now 后缀", async () => {
    mocks.listDirectory.mockResolvedValue([])
    mocks.fileExists.mockResolvedValue(true)
    renderSidebar()
    await flushAsync()

    fireEvent.click(screen.getByTitle("sidebar.newChapter"))
    await waitFor(() => expect(mocks.writeFile).toHaveBeenCalled())
    await flushAsync()

    const filePath = (mocks.writeFile.mock.calls[0]?.[0] as string) ?? ""
    expect(filePath).toMatch(/chapter-1-第1章-\d+\.md$/)
  })

  it("新建章节：getExistingChapterTitles 目录读取失败时容错", async () => {
    mocks.listDirectory.mockImplementation(async (path: string) => {
      if (path === "/p/mybook/wiki/chapters") throw new Error("no chapters dir")
      return []
    })
    renderSidebar()
    await flushAsync()
    fireEvent.click(screen.getByTitle("sidebar.newChapter"))
    await waitFor(() => expect(mocks.writeFile).toHaveBeenCalled())
    await flushAsync()
    expect(mocks.writeFile).toHaveBeenCalledWith(
      "/p/mybook/wiki/chapters/chapter-1-第1章.md",
      expect.stringContaining("chapter_number: 1"),
    )
  })

  it("新建章节：createDirectory 失败被吞掉", async () => {
    mocks.listDirectory.mockResolvedValue([])
    mocks.createDirectory.mockRejectedValue(new Error("mkdir boom"))
    renderSidebar()
    await flushAsync()
    fireEvent.click(screen.getByTitle("sidebar.newChapter"))
    await waitFor(() => expect(mocks.writeFile).toHaveBeenCalled())
    await flushAsync()
    expect(mocks.writeFile).toHaveBeenCalled()
  })

  it("新建章节：通过 KnowledgeTree 请求携带 parentDir", async () => {
    mocks.listDirectory.mockResolvedValue([])
    renderSidebar()
    await flushAsync()
    fireEvent.click(screen.getByTestId("kt-create-parent"))
    await waitFor(() => expect(mocks.writeFile).toHaveBeenCalled())
    await flushAsync()
    expect(mocks.createDirectory).toHaveBeenCalledWith("/p/mybook/wiki/chapters/v1")
  })

  it("新建大纲：输入标题后创建 outline 文件", async () => {
    renderSidebar({ activeView: "sources" })
    await flushAsync()
    fireEvent.click(screen.getByTitle("sidebar.newOutline"))
    const input = screen.getByPlaceholderText("sidebar.newOutlinePrompt")
    const user = userEvent.setup()
    await user.type(input, "新大纲{Enter}")
    await waitFor(() => expect(mocks.writeFile).toHaveBeenCalled())
    await flushAsync()

    expect(mocks.writeFile).toHaveBeenCalledWith(
      "/p/mybook/wiki/outlines/新大纲.md",
      expect.stringContaining("type: outline"),
    )
    expect(mocks.writeFile).toHaveBeenCalledWith(
      "/p/mybook/wiki/outlines/新大纲.md",
      expect.stringContaining('title: "新大纲"'),
    )
    expect(mocks.state.setSelectedFile).toHaveBeenCalledWith("/p/mybook/wiki/outlines/新大纲.md")
    expect(screen.queryByPlaceholderText("sidebar.newOutlinePrompt")).not.toBeInTheDocument()
  })

  it("新建大纲：Enter 提交", async () => {
    renderSidebar({ activeView: "sources" })
    await flushAsync()
    fireEvent.click(screen.getByTitle("sidebar.newOutline"))
    const input = screen.getByPlaceholderText("sidebar.newOutlinePrompt")
    fireEvent.change(input, { target: { value: "回车提交" } })
    fireEvent.keyDown(input, { key: "Enter" })
    await waitFor(() => expect(mocks.writeFile).toHaveBeenCalled())
    await flushAsync()
    expect(mocks.writeFile).toHaveBeenCalledWith(
      "/p/mybook/wiki/outlines/回车提交.md",
      expect.stringContaining("type: outline"),
    )
  })

  it("新建卷：知识模式创建章节卷目录", async () => {
    renderSidebar()
    await flushAsync()
    fireEvent.click(screen.getByTestId("kt-create-secondary"))
    const input = screen.getByPlaceholderText("sidebar.newVolumePrompt")
    fireEvent.change(input, { target: { value: "第一卷" } })
    fireEvent.click(screen.getByText("创建"))
    await waitFor(() => expect(mocks.createDirectory).toHaveBeenCalledWith("/p/mybook/wiki/chapters/第一卷"))
    await flushAsync()
    expect(mocks.createDirectory).toHaveBeenCalledWith("/p/mybook/wiki/chapters")
    expect(mocks.state.setSelectedFile).not.toHaveBeenCalled()
    expect(screen.queryByPlaceholderText("sidebar.newVolumePrompt")).not.toBeInTheDocument()
  })

  it("新建文件夹：文件模式创建大纲文件夹", async () => {
    renderSidebar({ activeView: "sources" })
    await flushAsync()
    fireEvent.click(screen.getByTestId("kt-create-secondary"))
    const input = screen.getByPlaceholderText("sidebar.newFolderPrompt")
    fireEvent.change(input, { target: { value: "素材库" } })
    fireEvent.click(screen.getByText("创建"))
    await waitFor(() => expect(mocks.createDirectory).toHaveBeenCalledWith("/p/mybook/wiki/outlines/素材库"))
    await flushAsync()
    expect(mocks.state.setSelectedFile).not.toHaveBeenCalled()
  })

  it("新建失败：writeFile 抛错时保留输入", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {})
    renderSidebar({ activeView: "sources" })
    await flushAsync()
    fireEvent.click(screen.getByTitle("sidebar.newOutline"))
    const input = screen.getByPlaceholderText("sidebar.newOutlinePrompt")
    fireEvent.change(input, { target: { value: "坏文件" } })
    mocks.writeFile.mockRejectedValue(new Error("write boom"))
    fireEvent.click(screen.getByText("创建"))
    await waitFor(() => expect(console.error).toHaveBeenCalled())
    await flushAsync()
    expect(screen.getByPlaceholderText("sidebar.newOutlinePrompt")).toBeInTheDocument()
  })

  it("输入框 Escape 与取消按钮关闭创建", () => {
    renderSidebar({ activeView: "sources" })
    fireEvent.click(screen.getByTitle("sidebar.newOutline"))
    const input = screen.getByPlaceholderText("sidebar.newOutlinePrompt")
    fireEvent.change(input, { target: { value: "abc" } })
    fireEvent.keyDown(input, { key: "Escape" })
    expect(screen.queryByPlaceholderText("sidebar.newOutlinePrompt")).not.toBeInTheDocument()

    fireEvent.click(screen.getByTitle("sidebar.newOutline"))
    fireEvent.click(screen.getByText("取消"))
    expect(screen.queryByPlaceholderText("sidebar.newOutlinePrompt")).not.toBeInTheDocument()
  })

  it("模式切换时取消不匹配的 pendingCreate", () => {
    const { setState } = renderSidebar({ activeView: "sources" })
    fireEvent.click(screen.getByTestId("kt-create-secondary"))
    expect(screen.getByPlaceholderText("sidebar.newFolderPrompt")).toBeInTheDocument()
    setState({ activeView: "wiki" })
    flush()
    expect(screen.queryByPlaceholderText("sidebar.newFolderPrompt")).not.toBeInTheDocument()

    fireEvent.click(screen.getByTestId("kt-create-secondary"))
    expect(screen.getByPlaceholderText("sidebar.newVolumePrompt")).toBeInTheDocument()
    setState({ activeView: "sources" })
    flush()
    expect(screen.queryByPlaceholderText("sidebar.newVolumePrompt")).not.toBeInTheDocument()
  })

  it("模式切换时关闭不匹配的导入菜单", () => {
    const { setState } = renderSidebar({ activeView: "sources" })
    fireEvent.click(screen.getByRole("button", { name: "sources.import" }))
    expect(screen.getByText("sources.importFiles")).toBeInTheDocument()
    setState({ activeView: "wiki" })
    flush()
    expect(screen.queryByText("sources.importFiles")).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole("button", { name: "导入" }))
    expect(screen.getByText("导入文件")).toBeInTheDocument()
    setState({ activeView: "sources" })
    flush()
    expect(screen.queryByText("导入文件")).not.toBeInTheDocument()
  })

  it("模式推断：wiki 强制知识模式，selectedFile 在 outlines 时切换文件模式", () => {
    // wiki 视图无视 selectedFile 路径
    const { setState } = renderSidebar({ activeView: "wiki", selectedFile: "/p/mybook/wiki/outlines/a.md" })
    expect(screen.getByTestId("kt-filter")).toHaveTextContent("chapter")

    // lint 非 novelMode 时依据 selectedFile 推断
    setState({ activeView: "lint", novelMode: false, selectedFile: "/p/mybook/wiki/outlines/a.md" })
    expect(screen.getByTestId("kt-filter")).toHaveTextContent("outline")
    setState({ activeView: "lint", novelMode: false, selectedFile: "/p/mybook/wiki/chapters/b.md" })
    expect(screen.getByTestId("kt-filter")).toHaveTextContent("chapter")
  })

  it("移除 pending 页面回调", async () => {
    renderSidebar()
    await flushAsync()
    // 先创建一章制造 pending 页面
    fireEvent.click(screen.getByTitle("sidebar.newChapter"))
    await waitFor(() => expect(mocks.writeFile).toHaveBeenCalled())
    await flushAsync()
    expect(screen.getByTestId("kt-pending")).not.toHaveTextContent("[]")

    fireEvent.click(screen.getByTestId("kt-remove"))
    expect(screen.getByTestId("kt-pending")).toHaveTextContent("[]")
  })

  it("连续新建大纲：pending 页面保留先前的条目", async () => {
    renderSidebar({ activeView: "sources" })
    await flushAsync()
    fireEvent.click(screen.getByTitle("sidebar.newOutline"))
    let input = screen.getByPlaceholderText("sidebar.newOutlinePrompt")
    fireEvent.change(input, { target: { value: "大纲A" } })
    fireEvent.keyDown(input, { key: "Enter" })
    await waitFor(() => expect(mocks.writeFile).toHaveBeenCalledTimes(1))
    await flushAsync()

    fireEvent.click(screen.getByTitle("sidebar.newOutline"))
    input = screen.getByPlaceholderText("sidebar.newOutlinePrompt")
    fireEvent.change(input, { target: { value: "大纲B" } })
    fireEvent.keyDown(input, { key: "Enter" })
    await waitFor(() => expect(mocks.writeFile).toHaveBeenCalledTimes(2))
    await flushAsync()

    const pending = screen.getByTestId("kt-pending").textContent ?? ""
    expect(pending).toContain("/p/mybook/wiki/outlines/大纲A.md")
    expect(pending).toContain("/p/mybook/wiki/outlines/大纲B.md")
  })

  it("新建大纲：createDirectory 失败被吞掉仍继续写入", async () => {
    mocks.createDirectory.mockRejectedValue(new Error("mkdir boom"))
    renderSidebar({ activeView: "sources" })
    await flushAsync()
    fireEvent.click(screen.getByTitle("sidebar.newOutline"))
    const input = screen.getByPlaceholderText("sidebar.newOutlinePrompt")
    fireEvent.change(input, { target: { value: "新大纲" } })
    fireEvent.keyDown(input, { key: "Enter" })
    await waitFor(() => expect(mocks.writeFile).toHaveBeenCalled())
    await flushAsync()
    expect(mocks.writeFile).toHaveBeenCalledWith(
      "/p/mybook/wiki/outlines/新大纲.md",
      expect.stringContaining("type: outline"),
    )
  })

  it("新建卷：createDirectory 失败被吞掉仍继续创建目录", async () => {
    mocks.createDirectory.mockImplementation(async (path: string) => {
      if (path === "/p/mybook/wiki/chapters") throw new Error("mkdir boom")
    })
    renderSidebar()
    await flushAsync()
    fireEvent.click(screen.getByTestId("kt-create-secondary"))
    const input = screen.getByPlaceholderText("sidebar.newVolumePrompt")
    fireEvent.change(input, { target: { value: "第一卷" } })
    fireEvent.click(screen.getByText("创建"))
    await waitFor(() =>
      expect(mocks.createDirectory).toHaveBeenCalledWith("/p/mybook/wiki/chapters/第一卷"),
    )
    await flushAsync()
    expect(screen.queryByPlaceholderText("sidebar.newVolumePrompt")).not.toBeInTheDocument()
  })

  it("新建大纲：通过输入框 Enter 在 KnowledgeTree 请求下创建（parentDir 分支）", async () => {
    renderSidebar({ activeView: "sources" })
    await flushAsync()
    fireEvent.click(screen.getByTestId("kt-create-parent"))
    const input = screen.getByPlaceholderText("sidebar.newOutlinePrompt")
    fireEvent.change(input, { target: { value: "父目录大纲" } })
    fireEvent.click(screen.getByText("创建"))
    await waitFor(() =>
      expect(mocks.writeFile).toHaveBeenCalledWith(
        "/p/mybook/wiki/chapters/v1/父目录大纲.md",
        expect.stringContaining("type: outline"),
      ),
    )
    await flushAsync()
  })

  it("新建文件夹：创建后关闭输入框", async () => {
    renderSidebar({ activeView: "sources" })
    await flushAsync()
    fireEvent.click(screen.getByTestId("kt-create-secondary"))
    const input = screen.getByPlaceholderText("sidebar.newFolderPrompt")
    fireEvent.change(input, { target: { value: "素材库" } })
    fireEvent.click(screen.getByText("创建"))
    await waitFor(() =>
      expect(mocks.createDirectory).toHaveBeenCalledWith("/p/mybook/wiki/outlines/素材库"),
    )
    await flushAsync()
    expect(screen.queryByPlaceholderText("sidebar.newFolderPrompt")).not.toBeInTheDocument()
  })

  it("移除 pending 页面后再次移除不报错", async () => {
    renderSidebar({ activeView: "sources" })
    await flushAsync()
    fireEvent.click(screen.getByTestId("kt-remove"))
    expect(screen.getByTestId("kt-pending")).toHaveTextContent("[]")
  })
})
