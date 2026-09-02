// @vitest-environment jsdom
/**
 * PreviewPanel 全口径覆盖 spec（W4PS 组）。
 * - vi.hoisted 可写 store state（App.spec.tsx 模式）
 * - 覆盖空态 / 数据态 / 交互 / 错误态 / 回调
 * - 不改源文件；仅此 spec 文件
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest"
import { cleanup as rtlCleanup, configure } from "@testing-library/react"
// 全量负载下持久化链变慢：放宽 waitFor 默认超时，避免时序偶发
configure({ asyncUtilTimeout: 5000 })
import { render, screen, fireEvent, waitFor, act, setupDomGlobals } from "@/test-helpers/component-test-utils"
import type { NovelReviewResult } from "@/lib/novel/review-adapter"
import type { ChapterBodySelection } from "@/lib/chapter-selection"
import type { DeAiBatchSummary, DeAiBatchOptions } from "@/lib/novel/de-ai-batch"

const CHAPTER_PATH = "/proj/wiki/chapters/第1章.md"
const OUTLINE_PATH = "/proj/wiki/outlines/大纲.md"

const CHAPTER_MD = [
  "---",
  'type: chapter',
  'title: "第一章"',
  "chapter_number: 1",
  "chapter_status: draft",
  "---",
  "",
  "# 第一章",
  "",
  "正文第一段。",
  "",
].join("\n")

const mocks = vi.hoisted(() => {
  const state: Record<string, any> = {
    project: { path: "/proj" },
    selectedFile: null,
    selectedTrashItem: null,
    fileContent: "",
    novelMode: true,
    chatExpanded: false,
    pendingEditorHighlight: null,
    finalChapterSave: null,
    novelConfig: { reviewBeforeSave: false, autoIngestOnSave: false },
    llmConfig: { provider: "openai", apiKey: "k", model: "m" },
    setSelectedTrashItem: vi.fn((v: unknown) => { state.selectedTrashItem = v }),
    setChatExpanded: vi.fn((v: unknown) => { state.chatExpanded = v }),
    setFileContent: vi.fn((v: unknown) => { state.fileContent = v }),
    setFileTree: vi.fn(),
    setSelectedFile: vi.fn((v: unknown) => { state.selectedFile = v }),
    setPendingEditorHighlight: vi.fn((v: unknown) => { state.pendingEditorHighlight = v }),
    setFinalChapterSave: vi.fn((v: unknown) => { state.finalChapterSave = v }),
    bumpDataVersion: vi.fn(),
  }
  const outlineState: Record<string, any> = { tasks: [] }
  const reviewState: Record<string, any> = { addNovelReviewEntry: vi.fn() }
  const importState: Record<string, any> = {
    startTask: vi.fn(() => "task-1"),
    finishTask: vi.fn(),
  }
  const compactToolbar: { value: boolean } = { value: true }
  const chapterMetaFinalGate = { value: true }
  const saveText = { value: "用户改动的内容" }
  const selectionText = { value: "选中文本" }
  return {
    state,
    outlineState,
    reviewState,
    importState,
    compactToolbar,
    chapterMetaFinalGate,
    saveText,
    selectionText,
    t: vi.fn<(key: string, opts?: { defaultValue?: string }) => string | number>((key, opts) => opts?.defaultValue ?? key),
    readFile: vi.fn(),
    writeFile: vi.fn(),
    writeFileAtomic: vi.fn(),
    listDirectory: vi.fn(),
    deleteFile: vi.fn(),
    fileExists: vi.fn(),
    preprocessFile: vi.fn(),
    copyFile: vi.fn(),
    copyDirectory: vi.fn(),
    findRelatedWikiPages: vi.fn(),
    createDirectory: vi.fn(),
    getFileModifiedTime: vi.fn(),
    getFileSize: vi.fn(),
    getFileMd5: vi.fn(),
    readFileAsBase64: vi.fn(),
    createProject: vi.fn(),
    openProject: vi.fn(),
    openProjectFolder: vi.fn(),
    openFileLocation: vi.fn(),
    getExecutableDir: vi.fn(),
    getResourceDir: vi.fn(),
    resolveDefaultModel: vi.fn((cfg: unknown) => cfg),
    hasUsableLlm: vi.fn(() => true),
    resolveReviewModel: vi.fn(() => "review-model"),
    buildDeAiRewriteMessages: vi.fn(() => []),
    loadSmartDeAiSkill: vi.fn(async () => null),
    runDeAiBatch: vi.fn<(projectPath: string, options: DeAiBatchOptions) => Promise<DeAiBatchSummary>>(async () => ({
      schemaVersion: "de-ai-batch/1.0",
      batchId: "de-ai-1",
      phase: "completed",
      total: 2,
      processed: 2,
      failed: [],
      skipped: 0,
      durationMs: 1000,
      startedAt: "2026-08-19T00:00:00.000Z",
      finishedAt: "2026-08-19T00:00:01.000Z",
    })),
    acceptAllDeAiBatchDrafts: vi.fn(async () => ({ accepted: 1, skipped: 0 })),
    acceptDeAiBatchDraft: vi.fn(async () => true),
    rejectDeAiBatchDraft: vi.fn(async () => true),
    loadDeAiBatchState: vi.fn(async () => ({
      schemaVersion: "de-ai-batch/1.0",
      batchId: "de-ai-1",
      phase: "completed",
      concurrency: 3,
      startedAt: "2026-08-19T00:00:00.000Z",
      updatedAt: "2026-08-19T00:00:00.000Z",
      queue: [1, 2],
      perChapter: {
        1: { status: "ready", attempts: 1 },
        2: { status: "failed", attempts: 2, lastError: "boom" },
      },
    })),
    startOutlineIngestTask: vi.fn(),
    streamChat: vi.fn(),
    reviewChapter: vi.fn<() => Promise<NovelReviewResult[]>>(async () => []),
    ingestChapter: vi.fn<() => Promise<{ snapshot: { chapterNumber: number } | null; failReason: string | null }>>(async () => ({ snapshot: null, failReason: "extract_failed" })),
    buildPolishSelectionMessages: vi.fn(() => []),
    rebuildChapterBody: vi.fn((h: string, b: string) => (h ? `# ${h}\n\n${b}` : b)),
    replaceChapterBodySelection: vi.fn<(currentBody: string, selection: ChapterBodySelection, replacement: string) => { ok: true; body: string } | { ok: false; reason: "changed" | "empty" }>(() => ({ ok: true as const, body: "new-body" })),
    replaceWholeChapterBody: vi.fn((_c: string, r: string) => r),
    splitChapterHeading: vi.fn((b: string) => ({ heading: "第一章", body: b })),
    shouldUseCompactChapterToolbar: vi.fn(() => compactToolbar.value),
    getPreviewContentContainerClass: vi.fn(() => "container-class"),
  }
})

vi.mock("@/stores/wiki-store", () => ({
  useWikiStore: Object.assign(
    (selector: (s: Record<string, any>) => unknown) => selector(mocks.state),
    { getState: () => mocks.state },
  ),
}))

vi.mock("@/stores/outline-generation-store", () => ({
  useOutlineGenerationStore: (selector: (s: Record<string, any>) => unknown) => selector(mocks.outlineState),
}))

vi.mock("@/stores/review-store", () => ({
  useReviewStore: Object.assign(
    (selector: (s: Record<string, any>) => unknown) => selector(mocks.reviewState),
    { getState: () => mocks.reviewState },
  ),
}))

vi.mock("@/stores/import-progress-store", () => ({
  useImportProgressStore: Object.assign(
    (selector: (s: Record<string, any>) => unknown) => selector(mocks.importState),
    { getState: () => mocks.importState },
  ),
}))

vi.mock("react-i18next", () => ({
  initReactI18next: { type: "3rdParty", init: vi.fn() },
  useTranslation: () => ({ t: mocks.t }),
}))

vi.mock("@/i18n", () => ({
  default: { t: mocks.t, exists: vi.fn(() => true) },
}))

vi.mock("@/commands/fs", () => ({
  readFile: mocks.readFile,
  writeFile: mocks.writeFile,
  writeFileAtomic: mocks.writeFileAtomic,
  listDirectory: mocks.listDirectory,
  copyFile: mocks.copyFile,
  copyDirectory: mocks.copyDirectory,
  preprocessFile: mocks.preprocessFile,
  deleteFile: mocks.deleteFile,
  findRelatedWikiPages: mocks.findRelatedWikiPages,
  createDirectory: mocks.createDirectory,
  fileExists: mocks.fileExists,
  getFileModifiedTime: mocks.getFileModifiedTime,
  getFileSize: mocks.getFileSize,
  getFileMd5: mocks.getFileMd5,
  readFileAsBase64: mocks.readFileAsBase64,
  createProject: mocks.createProject,
  openProject: mocks.openProject,
  openProjectFolder: mocks.openProjectFolder,
  openFileLocation: mocks.openFileLocation,
  getExecutableDir: mocks.getExecutableDir,
  getResourceDir: mocks.getResourceDir,
}))

vi.mock("@/lib/novel/model-resolver", () => ({ resolveDefaultModel: mocks.resolveDefaultModel }))
vi.mock("@/lib/has-usable-llm", () => ({ hasUsableLlm: mocks.hasUsableLlm }))
vi.mock("@/lib/novel/review-model", () => ({ resolveReviewModel: mocks.resolveReviewModel }))
vi.mock("@/lib/novel/de-ai-adapter", () => ({
  buildDeAiRewriteMessages: mocks.buildDeAiRewriteMessages,
  loadSmartDeAiSkill: mocks.loadSmartDeAiSkill,
}))
vi.mock("@/lib/novel/de-ai-batch", () => ({
  runDeAiBatch: mocks.runDeAiBatch,
  acceptAllDeAiBatchDrafts: mocks.acceptAllDeAiBatchDrafts,
  acceptDeAiBatchDraft: mocks.acceptDeAiBatchDraft,
  rejectDeAiBatchDraft: mocks.rejectDeAiBatchDraft,
  loadDeAiBatchState: mocks.loadDeAiBatchState,
}))
vi.mock("@/lib/novel/outline-generation", () => ({ startOutlineIngestTask: mocks.startOutlineIngestTask }))
vi.mock("@/lib/llm-client", () => ({ streamChat: mocks.streamChat }))
vi.mock("@/lib/chapter-selection", () => ({
  buildPolishSelectionMessages: mocks.buildPolishSelectionMessages,
  rebuildChapterBody: mocks.rebuildChapterBody,
  replaceChapterBodySelection: mocks.replaceChapterBodySelection,
  replaceWholeChapterBody: mocks.replaceWholeChapterBody,
  splitChapterHeading: mocks.splitChapterHeading,
}))
vi.mock("@/lib/novel/review-adapter", () => ({ reviewChapter: mocks.reviewChapter }))
vi.mock("@/lib/novel/chapter-ingest", () => ({ ingestChapter: mocks.ingestChapter }))
vi.mock("@/lib/workspace-layout", () => ({
  shouldUseCompactChapterToolbar: mocks.shouldUseCompactChapterToolbar,
  getPreviewContentContainerClass: mocks.getPreviewContentContainerClass,
}))

vi.mock("@/components/editor/wiki-editor", () => ({
  WikiEditor: (props: Record<string, any>) => (
    <div data-testid="wiki-editor">
      <span data-testid="editor-content">{props.content}</span>
      <span data-testid="editor-mode">{props.defaultMode}</span>
      <button data-testid="editor-save" onClick={() => props.onSave?.(mocks.saveText.value)}>save</button>
      <button
        data-testid="editor-selection-polish"
        onClick={() => props.onSelectionAction?.("polish", { start: 0, end: 4, text: mocks.selectionText.value, bodySnapshot: "body" })}
      >
        polish
      </button>
      <button
        data-testid="editor-selection-deai"
        onClick={() => props.onSelectionAction?.("de-ai", { start: 0, end: 2, text: mocks.selectionText.value, bodySnapshot: "body" })}
      >
        deai
      </button>
      <button data-testid="editor-highlight-handled" onClick={() => props.onHighlightHandled?.()}>
        hl
      </button>
      <span data-testid="editor-highlight">{props.highlightRequest ? props.highlightRequest.text : "none"}</span>
    </div>
  ),
}))

vi.mock("@/components/editor/wiki-reader", () => ({
  WikiReader: (props: { body: string }) => <div data-testid="wiki-reader">{props.body}</div>,
}))

vi.mock("@/components/editor/file-preview", () => ({
  FilePreview: (props: { filePath: string; textContent: string }) => (
    <div data-testid="file-preview">
      <span>{props.filePath}</span>
      <span>{props.textContent}</span>
    </div>
  ),
}))

vi.mock("@/components/novel/cognition-panel", () => ({
  CognitionPanel: (props: { projectPath: string; onClose: () => void }) => (
    <div data-testid="cognition-panel">
      <span>{props.projectPath}</span>
      <button data-testid="cognition-close" onClick={props.onClose}>close</button>
    </div>
  ),
}))

vi.mock("@/components/novel/persona-critique-panel", () => ({
  PersonaCritiquePanel: (props: { projectPath: string; onClose: () => void }) => (
    <div data-testid="persona-panel">
      <span>{props.projectPath}</span>
      <button data-testid="persona-close" onClick={props.onClose}>close</button>
    </div>
  ),
}))

vi.mock("@/components/novel/de-ai-preview-dialog", () => ({
  DeAiPreviewDialog: (props: Record<string, any>) => (
    <div data-testid="de-ai-dialog" data-open={String(props.open)}>
      <button data-testid="de-ai-apply" onClick={props.onApply}>apply</button>
      <button data-testid="de-ai-save-draft" onClick={props.onSaveDraft}>draft</button>
      <button data-testid="de-ai-close" onClick={props.onClose}>close</button>
    </div>
  ),
}))

vi.mock("@/components/novel/de-ai-batch-dialog", () => ({
  DeAiBatchDialog: (props: Record<string, any>) => (
    <div data-testid="de-ai-batch-dialog" data-open={String(props.open)} data-running={String(props.running)}>
      <button data-testid="de-ai-batch-cancel" onClick={props.onCancel}>cancel</button>
      <button data-testid="de-ai-batch-accept-all" onClick={props.onAcceptAll}>accept-all</button>
      <button data-testid="de-ai-batch-accept-1" onClick={() => props.onAcceptChapter(1)}>accept-1</button>
      <button data-testid="de-ai-batch-reject-1" onClick={() => props.onRejectChapter(1)}>reject-1</button>
      <button data-testid="de-ai-batch-close" onClick={props.onClose}>close</button>
    </div>
  ),
}))

vi.mock("@/components/novel/text-transform-preview-dialog", () => ({
  TextTransformPreviewDialog: (props: Record<string, any>) => (
    <div data-testid="tt-dialog" data-open={String(props.open)} data-title={props.title}>
      <button data-testid="tt-apply" onClick={props.onApply}>apply</button>
      <button data-testid="tt-close" onClick={props.onClose}>close</button>
    </div>
  ),
}))

vi.mock("@/components/novel/snapshot-viewer", () => ({
  SnapshotViewer: (props: { projectPath: string; chapterNumber: number; onClose: () => void }) => (
    <div data-testid="snapshot-viewer">
      <span>{props.projectPath}:{props.chapterNumber}</span>
      <button data-testid="snapshot-close" onClick={props.onClose}>close</button>
    </div>
  ),
}))

vi.mock("@/lib/novel/chapter-meta", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/novel/chapter-meta")>()
  return {
    ...actual,
    isFinalChapter: vi.fn((frontmatter: Record<string, unknown>) => (
      mocks.chapterMetaFinalGate.value && actual.isFinalChapter(frontmatter)
    )),
  }
})

import { PreviewPanel } from "./preview-panel"

async function flushAsync(ms = 0): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, ms))
  })
}

async function renderPanel(): Promise<{ rerender: () => void; cleanup: () => void }> {
  const view = render(<PreviewPanel />)
  await flushAsync(10)
  return {
    rerender: () => view.rerender(<PreviewPanel />),
    cleanup: () => view.unmount(),
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  setupDomGlobals()
  mocks.state.project = { path: "/proj" }
  mocks.state.selectedFile = null
  mocks.state.selectedTrashItem = null
  mocks.state.fileContent = ""
  mocks.state.novelMode = true
  mocks.state.chatExpanded = false
  mocks.state.pendingEditorHighlight = null
  mocks.state.finalChapterSave = null
  mocks.state.novelConfig = { reviewBeforeSave: false, autoIngestOnSave: false }
  mocks.state.llmConfig = { provider: "openai", apiKey: "k", model: "m" }
  mocks.outlineState.tasks = []
  mocks.compactToolbar.value = true
  mocks.chapterMetaFinalGate.value = true
  mocks.saveText.value = "用户改动的内容"
  mocks.selectionText.value = "选中文本"
  mocks.readFile.mockResolvedValue("")
  mocks.writeFile.mockResolvedValue(undefined)
  mocks.writeFileAtomic.mockResolvedValue(undefined)
  mocks.listDirectory.mockResolvedValue([])
  mocks.deleteFile.mockResolvedValue(undefined)
  mocks.fileExists.mockResolvedValue(false)
  mocks.hasUsableLlm.mockReturnValue(true)
  mocks.reviewChapter.mockResolvedValue([])
  mocks.ingestChapter.mockResolvedValue({ snapshot: null, failReason: "extract_failed" })
  mocks.streamChat.mockReset()
})

afterEach(() => {
  rtlCleanup()
  vi.restoreAllMocks()
})

describe("PreviewPanel 空态与加载态", () => {
  it("无选中文件时显示空态并清空内容", async () => {
    const { cleanup } = await renderPanel()
    expect(screen.getByText("preview.empty")).toBeInTheDocument()
    expect(mocks.state.setFileContent).toHaveBeenCalledWith("")
    cleanup()
  })

  it("无项目时同样显示空态", async () => {
    mocks.state.project = null
    const { cleanup } = await renderPanel()
    expect(screen.getByText("preview.empty")).toBeInTheDocument()
    cleanup()
  })

  it("选中二进制文件时直接进入 FilePreview 分支", async () => {
    mocks.state.selectedFile = "/proj/assets/cover.png"
    const { cleanup } = await renderPanel()
    expect(screen.getByTestId("file-preview")).toBeInTheDocument()
    expect(screen.getByText("/proj/assets/cover.png")).toBeInTheDocument()
    cleanup()
  })

  it("readFile 挂起时显示 loading 文案", async () => {
    mocks.state.selectedFile = "/proj/wiki/notes.md"
    mocks.readFile.mockReturnValue(new Promise(() => {}))
    const { cleanup } = await renderPanel()
    expect(screen.getByText("正在加载...")).toBeInTheDocument()
    cleanup()
  })

  it("非章节 markdown 读取成功 → WikiEditor(read 模式) + 非章节保存走原样写入", async () => {
    mocks.state.selectedFile = "/proj/wiki/notes.md"
    mocks.readFile.mockResolvedValue("# 笔记\n\n内容")
    const { cleanup } = await renderPanel()
    expect(screen.getByTestId("wiki-editor")).toBeInTheDocument()
    expect(screen.getByTestId("editor-mode").textContent).toBe("read")
    expect(screen.getByTestId("editor-content").textContent).toBe("# 笔记\n\n内容")
    fireEvent.click(screen.getByTestId("editor-save"))
    await waitFor(() => expect(mocks.writeFileAtomic).toHaveBeenCalledWith("/proj/wiki/notes.md", "用户改动的内容"), { timeout: 3000 })
    expect(mocks.state.bumpDataVersion).toHaveBeenCalled()
    cleanup()
  })

  it("读取失败 → 错误内容注入编辑器", async () => {
    mocks.state.selectedFile = "/proj/wiki/notes.md"
    mocks.readFile.mockRejectedValue(new Error("boom"))
    const { cleanup } = await renderPanel()
    expect(screen.getByTestId("wiki-editor")).toBeInTheDocument()
    expect(screen.getByText(/Error loading file: Error: boom/)).toBeInTheDocument()
    cleanup()
  })

  it("保存与磁盘内容一致时跳过写入（no-op save）", async () => {
    mocks.state.selectedFile = "/proj/wiki/notes.md"
    mocks.saveText.value = "# 笔记\n\n内容"
    mocks.readFile.mockResolvedValue("# 笔记\n\n内容")
    const { cleanup } = await renderPanel()
    fireEvent.click(screen.getByTestId("editor-save"))
    await flushAsync(1200)
    expect(mocks.writeFileAtomic).not.toHaveBeenCalled()
    cleanup()
  })
})

describe("PreviewPanel 章节数据态与章节标题交互", () => {
  it("章节文件加载 → 章节头渲染（draft 徽章 + 字数）+ 标题输入框交互", async () => {
    mocks.state.selectedFile = CHAPTER_PATH
    mocks.state.fileContent = CHAPTER_MD
    mocks.readFile.mockResolvedValue(CHAPTER_MD)
    const { cleanup } = await renderPanel()

    const input = screen.getByRole("textbox")
    expect(input).toHaveValue("第一章")
    expect(screen.getByText("novel.chapter.status.draft")).toBeInTheDocument()
    expect(screen.getByText(/^\d+字$/)).toBeInTheDocument()

    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: "新标题" } })
    expect(input).toHaveValue("新标题")
    // 实现：Enter 处理器只调用 e.currentTarget.blur()（preview-panel.tsx onKeyDown），
    // jsdom 中 blur() 不派发 React onBlur，需显式 fireEvent.blur 触发 commitChapterTitleDraft。
    fireEvent.keyDown(input, { key: "Enter" })
    fireEvent.blur(input)
    // 实现：commitChapterTitleDraft → syncChapterToCanonicalPath（preview-panel.tsx），
    // 标题经 makeDefaultChapterTitle 规范为「第N章-名称」并写入新的 canonical 路径，
    // 随后 deleteFile 旧路径。
    await waitFor(() => expect(mocks.writeFileAtomic).toHaveBeenCalled())
    const writeArgs = mocks.writeFileAtomic.mock.calls[0] as [string, string]
    expect(writeArgs[0]).toBe("/proj/wiki/chapters/第1章-新标题.md")
    expect(writeArgs[1]).toContain("# 第1章-新标题")
    expect(writeArgs[1]).toContain('title: "第1章-新标题"')
    expect(mocks.deleteFile).toHaveBeenCalledWith(CHAPTER_PATH)
    cleanup()
  })

  it("标题已规范时 commit 早退（nextTitle === chapterDisplayTitle）", async () => {
    const md = CHAPTER_MD.replace("# 第一章", "# 第1章-第一章").replace('title: "第一章"', 'title: "第1章-第一章"')
    mocks.state.selectedFile = CHAPTER_PATH
    mocks.state.fileContent = md
    mocks.readFile.mockResolvedValue(md)
    const { cleanup } = await renderPanel()
    const input = screen.getByRole("textbox")
    fireEvent.focus(input)
    fireEvent.blur(input)
    await flushAsync(20)
    expect(mocks.writeFileAtomic).not.toHaveBeenCalled()
    cleanup()
  })

  it("Escape 取消标题编辑", async () => {
    mocks.state.selectedFile = CHAPTER_PATH
    mocks.state.fileContent = CHAPTER_MD
    mocks.readFile.mockResolvedValue(CHAPTER_MD)
    const { cleanup } = await renderPanel()
    const input = screen.getByRole("textbox")
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: "不要这个" } })
    fireEvent.keyDown(input, { key: "Escape" })
    expect(input).toHaveValue("第一章")
    cleanup()
  })

  it("标题同步失败 → console.error", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    mocks.state.selectedFile = CHAPTER_PATH
    mocks.state.fileContent = CHAPTER_MD
    mocks.readFile.mockResolvedValue(CHAPTER_MD)
    mocks.writeFileAtomic.mockRejectedValue(new Error("write-fail"))
    const { cleanup } = await renderPanel()
    const input = screen.getByRole("textbox")
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: "新标题" } })
    fireEvent.keyDown(input, { key: "Enter" })
    fireEvent.blur(input) // jsdom 需显式 blur 触发 commit（同上用例）
    await waitFor(() => expect(errSpy).toHaveBeenCalled())
    expect(String(errSpy.mock.calls[0][0])).toContain("章节标题同步失败")
    errSpy.mockRestore()
    cleanup()
  })

  it("final 状态的章节渲染 final 徽章（Check 图标分支）", async () => {
    const finalMd = CHAPTER_MD.replace("chapter_status: draft", "chapter_status: final")
    mocks.state.selectedFile = CHAPTER_PATH
    mocks.state.fileContent = finalMd
    mocks.readFile.mockResolvedValue(finalMd)
    const { cleanup } = await renderPanel()
    expect(screen.getByText("novel.chapter.status.canon")).toBeInTheDocument()
    cleanup()
  })

  it("archived 状态章节走 else 徽章分支", async () => {
    const archivedMd = CHAPTER_MD.replace("chapter_status: draft", "chapter_status: archived")
    mocks.state.selectedFile = CHAPTER_PATH
    mocks.state.fileContent = archivedMd
    mocks.readFile.mockResolvedValue(archivedMd)
    const { cleanup } = await renderPanel()
    expect(screen.getByText("novel.chapter.status.archived")).toBeInTheDocument()
    cleanup()
  })

  it("章节头为空（无标题正文）→ 从路径推导显示标题", async () => {
    const md = [
      "---",
      'type: chapter',
      "chapter_number: 2",
      "chapter_status: draft",
      "---",
      "",
      "没有标题正文",
      "",
    ].join("\n")
    mocks.state.selectedFile = "/proj/wiki/chapters/第二章-测试.md"
    mocks.state.fileContent = md
    mocks.readFile.mockResolvedValue(md)
    const { cleanup } = await renderPanel()
    expect(screen.getByRole("textbox")).toHaveValue("第二章-测试")
    cleanup()
  })
})

describe("PreviewPanel 文件切换与保存 flush", () => {
  it("章节切换到另一文件时 flush 前一章节（canonical 路径相同 → 不删除）", async () => {
    mocks.state.selectedFile = CHAPTER_PATH
    mocks.state.fileContent = CHAPTER_MD
    mocks.readFile.mockResolvedValue(CHAPTER_MD)
    const view = render(<PreviewPanel />)
    await flushAsync(10)
    fireEvent.click(screen.getByTestId("editor-save"))
    mocks.state.selectedFile = "/proj/wiki/chapters/第二章.md"
    // 不要直接改写 state.fileContent：组件首个 effect 会把 fileContentRef 同步为最新
    // store 值（preview-panel.tsx useEffect [fileContent]），导致 flush 拿到新文件内容并
    // 把前一章节重命名到新文件的 canonical 名。真实流程中内容由 readFile 异步装载。
    mocks.readFile.mockResolvedValue("# 第二章\n\n内容")
    view.rerender(<PreviewPanel />)
    await waitFor(() => expect(mocks.writeFileAtomic).toHaveBeenCalled())
    expect(mocks.writeFileAtomic.mock.calls[0][0]).toBe(CHAPTER_PATH)
    expect(mocks.deleteFile).not.toHaveBeenCalled()
    view.unmount()
  })

  it("flush 时目标路径与当前不同 → 删除旧文件 + 刷新树 + 更新选中路径", async () => {
    const nonCanonical = "/proj/wiki/chapters/旧名字.md"
    const md = CHAPTER_MD
    mocks.state.selectedFile = nonCanonical
    mocks.state.fileContent = md
    mocks.readFile.mockResolvedValue(md)
    mocks.saveText.value = md + "\n新增段落"
    const view = render(<PreviewPanel />)
    await flushAsync(10)
    fireEvent.click(screen.getByTestId("editor-save"))
    view.unmount()
    await flushAsync(20)
    expect(mocks.writeFileAtomic).toHaveBeenCalled()
    expect(mocks.deleteFile).toHaveBeenCalledWith(nonCanonical)
    expect(mocks.state.setFileTree).toHaveBeenCalled()
    expect(mocks.state.setSelectedFile).toHaveBeenCalledWith(CHAPTER_PATH)
    expect(mocks.state.bumpDataVersion).toHaveBeenCalled()
  })

  it("finalChapterSave saving 中同路径 → flush 早退", async () => {
    mocks.state.selectedFile = CHAPTER_PATH
    mocks.state.fileContent = CHAPTER_MD
    mocks.state.finalChapterSave = { projectPath: "/proj", filePath: CHAPTER_PATH, saving: true, phase: "saving" }
    mocks.readFile.mockResolvedValue(CHAPTER_MD)
    const view = render(<PreviewPanel />)
    await flushAsync(10)
    fireEvent.click(screen.getByTestId("editor-save"))
    view.unmount()
    await flushAsync(20)
    expect(mocks.writeFileAtomic).not.toHaveBeenCalled()
  })

  it("章节文件 canonical 重命名冲突时走 -2 后缀", async () => {
    // 实现：canonical 重命名只发生在 syncChapterToCanonicalPath（preview-panel.tsx），
    // 触发点是 flush（切文件/卸载）或标题提交；editor-save 的 handleSave 只写当前路径。
    // 故用「编辑 + 卸载 flush」触发：内容带 frontmatter 标题「第一章」→ canonical 名为
    // 第1章.md；fileExists 仅占用第1章.md → getUniqueSiblingPath 返回第1章-2.md。
    mocks.state.selectedFile = "/proj/wiki/chapters/第一章.md"
    mocks.state.fileContent = CHAPTER_MD
    mocks.readFile.mockResolvedValue(CHAPTER_MD)
    mocks.saveText.value = CHAPTER_MD + "\n新增段落"
    mocks.fileExists.mockImplementation(async (p: string) => p === "/proj/wiki/chapters/第1章.md")
    const view = render(<PreviewPanel />)
    await flushAsync(10)
    fireEvent.click(screen.getByTestId("editor-save"))
    view.unmount()
    await waitFor(() => expect(mocks.writeFileAtomic).toHaveBeenCalledWith("/proj/wiki/chapters/第1章-2.md", expect.anything()), { timeout: 3000 })
    expect(mocks.deleteFile).toHaveBeenCalledWith("/proj/wiki/chapters/第一章.md")
  })

  it("canonical 全部被占 → Date.now 兜底", async () => {
    // 同上一用例：经卸载 flush 触发 syncChapterToCanonicalPath；
    // fileExists 恒 true → getUniqueSiblingPath 1..99 全占 → 第1章-<Date.now()>.md。
    mocks.state.selectedFile = "/proj/wiki/chapters/第一章.md"
    mocks.state.fileContent = CHAPTER_MD
    mocks.readFile.mockResolvedValue(CHAPTER_MD)
    mocks.saveText.value = CHAPTER_MD + "\n新增段落"
    mocks.fileExists.mockResolvedValue(true)
    const view = render(<PreviewPanel />)
    await flushAsync(10)
    fireEvent.click(screen.getByTestId("editor-save"))
    view.unmount()
    await waitFor(() => expect(mocks.writeFileAtomic).toHaveBeenCalledWith(expect.stringMatching(/第1章-\d+\.md$/), expect.anything()), { timeout: 3000 })
  })

  it("无标题内容 → canonical 路径 = 当前路径（无重命名）", async () => {
    const md = "# 无前置元数据\n\n正文"
    mocks.state.selectedFile = CHAPTER_PATH
    mocks.state.fileContent = md
    mocks.readFile.mockResolvedValue(md)
    const { cleanup } = await renderPanel()
    fireEvent.click(screen.getByTestId("editor-save"))
    await waitFor(() => expect(mocks.writeFileAtomic).toHaveBeenCalled(), { timeout: 3000 })
    expect(mocks.writeFileAtomic.mock.calls[0][0]).toBe(CHAPTER_PATH)
    expect(mocks.deleteFile).not.toHaveBeenCalled()
    cleanup()
  })

  it("切换文件时 flush 失败 → console.error", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    mocks.state.selectedFile = CHAPTER_PATH
    mocks.state.fileContent = CHAPTER_MD
    mocks.readFile.mockResolvedValue(CHAPTER_MD)
    mocks.writeFileAtomic.mockRejectedValue(new Error("flush-fail"))
    const view = render(<PreviewPanel />)
    await flushAsync(10)
    fireEvent.click(screen.getByTestId("editor-save"))
    mocks.state.selectedFile = "/proj/wiki/chapters/第二章.md"
    mocks.readFile.mockResolvedValue("# 二")
    view.rerender(<PreviewPanel />)
    await waitFor(() => expect(errSpy).toHaveBeenCalled())
    expect(String(errSpy.mock.calls[0][0])).toContain("切换章节前同步文件失败")
    errSpy.mockRestore()
    view.unmount()
  })
})

describe("PreviewPanel 大纲摄入", () => {
  it("大纲文件加载 → 检测初始记忆已提取（fileExists true）", async () => {
    mocks.state.selectedFile = OUTLINE_PATH
    mocks.state.fileContent = "# 大纲\n\n内容"
    mocks.readFile.mockResolvedValue("# 大纲\n\n内容")
    mocks.fileExists.mockResolvedValue(true)
    mocks.compactToolbar.value = false
    const { cleanup } = await renderPanel()
    await waitFor(() => expect(screen.getByText(/已提取记忆/)).toBeInTheDocument())
    expect(mocks.fileExists).toHaveBeenCalledWith(expect.stringContaining(".novel/snapshots/outline-"))
    cleanup()
  })

  it("大纲摄入按钮（compact 菜单）触发 startOutlineIngestTask", async () => {
    mocks.state.selectedFile = OUTLINE_PATH
    mocks.state.fileContent = "# 大纲"
    mocks.readFile.mockResolvedValue("# 大纲")
    mocks.fileExists.mockResolvedValue(false)
    const { cleanup } = await renderPanel()
    fireEvent.click(screen.getByLabelText("更多功能"))
    await waitFor(() => expect(screen.getByText("novel.outlineGenerator.ingest")).toBeInTheDocument())
    fireEvent.click(screen.getByText("novel.outlineGenerator.ingest"))
    expect(mocks.startOutlineIngestTask).toHaveBeenCalledWith("/proj", OUTLINE_PATH)
    cleanup()
  })

  it("摄入中任务 → 按钮禁用文案 + message 写入 saveStatus", async () => {
    // 实现：加载 effect 在 readFile 解析后调用 setSaveStatus("")（preview-panel.tsx），
    // 会覆盖任务 message；只有 currentOutlineTask 变化时 message effect 重跑，saveStatus
    // 才保留。本 mock store 无订阅，需 rerender 注入 ingesting 任务触发该 effect。
    mocks.state.selectedFile = OUTLINE_PATH
    mocks.state.fileContent = "# 大纲"
    mocks.readFile.mockResolvedValue("# 大纲")
    const view = render(<PreviewPanel />)
    await flushAsync(20)
    mocks.outlineState.tasks = [{
      id: "t1",
      projectPath: "/proj",
      kind: "ingest",
      genre: "", scale: "", premise: "", prompt: "", userRequest: "",
      selectedSectionKey: null, displayTitle: null, writeMode: null,
      targetPath: null, outlinePath: OUTLINE_PATH,
      status: "ingesting",
      message: "正在提取大纲记忆",
      error: null,
      createdAt: 1, updatedAt: 1,
    }]
    view.rerender(<PreviewPanel />)
    await waitFor(() => expect(screen.getByText("正在提取大纲记忆")).toBeInTheDocument())
    fireEvent.click(screen.getByLabelText("更多功能"))
    await waitFor(() => expect(screen.getByText("novel.outlineGenerator.ingesting")).toBeInTheDocument())
    view.unmount()
  })

  it("fileExists 拒绝 → outlineIngested false", async () => {
    mocks.state.selectedFile = OUTLINE_PATH
    mocks.state.fileContent = "# 大纲"
    mocks.readFile.mockResolvedValue("# 大纲")
    mocks.fileExists.mockRejectedValue(new Error("x"))
    const { cleanup } = await renderPanel()
    await flushAsync(20)
    fireEvent.click(screen.getByLabelText("更多功能"))
    expect(screen.getByText("novel.outlineGenerator.ingest")).toBeInTheDocument()
    cleanup()
  })

  it("非大纲文件时不触发快照存在性检查", async () => {
    mocks.state.selectedFile = "/proj/wiki/notes.md"
    mocks.state.fileContent = "# 笔记"
    mocks.readFile.mockResolvedValue("# 笔记")
    const { cleanup } = await renderPanel()
    await flushAsync(20)
    expect(mocks.fileExists).not.toHaveBeenCalled()
    cleanup()
  })
})

describe("PreviewPanel 保存为正式章节（handleSaveAsFinal）", () => {
  function chapterSetup(novelConfig: Record<string, any>): void {
    mocks.state.selectedFile = CHAPTER_PATH
    mocks.state.fileContent = CHAPTER_MD
    mocks.state.novelConfig = novelConfig
    mocks.readFile.mockResolvedValue(CHAPTER_MD)
    mocks.compactToolbar.value = false
  }

  it("reviewBeforeSave + 错误 → blocked_by_review 并写入 review entry", async () => {
    chapterSetup({ reviewBeforeSave: true, autoIngestOnSave: false })
    mocks.reviewChapter.mockResolvedValue([
      { severity: "error", type: "consistency", message: "错误", evidence: "", relatedMemory: "", suggestion: "" },
      { severity: "warning", type: "consistency", message: "警告", evidence: "", relatedMemory: "", suggestion: "" },
    ])
    const { cleanup } = await renderPanel()
    fireEvent.click(screen.getByText("novel.chapter.saveAsCanon"))
    // 实现：handleSaveAsFinal 传 chapterFrontmatter.chapterNumber（preview-panel.tsx），
    // parseFrontmatter 返回原始 YAML 键（chapter_number），故该字段为 undefined。
    await waitFor(() => expect(mocks.reviewChapter).toHaveBeenCalledWith("/proj", CHAPTER_MD, undefined))
    expect(mocks.reviewState.addNovelReviewEntry).toHaveBeenCalled()
    expect(mocks.state.setFinalChapterSave).toHaveBeenCalledWith(
      expect.objectContaining({ saving: false, phase: "blocked_by_review", params: { count: 1, warnings: 1 } }),
    )
    cleanup()
  })

  it("reviewBeforeSave + 仅警告 → review_warnings 后继续保存", async () => {
    chapterSetup({ reviewBeforeSave: true, autoIngestOnSave: false })
    mocks.reviewChapter.mockResolvedValue([
      { severity: "warning", type: "consistency", message: "警告", evidence: "", relatedMemory: "", suggestion: "" },
    ])
    const { cleanup } = await renderPanel()
    fireEvent.click(screen.getByText("novel.chapter.saveAsCanon"))
    await waitFor(() => expect(mocks.writeFileAtomic).toHaveBeenCalled())
    expect(mocks.state.setFinalChapterSave).toHaveBeenCalledWith(
      expect.objectContaining({ saving: true, phase: "review_warnings", params: { count: 1 } }),
    )
    cleanup()
  })

  it("review 抛错 → review_failed_proceed 后继续保存", async () => {
    chapterSetup({ reviewBeforeSave: true, autoIngestOnSave: false })
    mocks.reviewChapter.mockRejectedValue(new Error("llm down"))
    const { cleanup } = await renderPanel()
    fireEvent.click(screen.getByText("novel.chapter.saveAsCanon"))
    await waitFor(() => expect(mocks.writeFileAtomic).toHaveBeenCalled())
    expect(mocks.state.setFinalChapterSave).toHaveBeenCalledWith(
      expect.objectContaining({ saving: true, phase: "review_failed_proceed" }),
    )
    cleanup()
  })

  it("直接保存（无审查）→ saved", async () => {
    chapterSetup({ reviewBeforeSave: false, autoIngestOnSave: false })
    const { cleanup } = await renderPanel()
    fireEvent.click(screen.getByText("novel.chapter.saveAsCanon"))
    await waitFor(() => expect(mocks.writeFileAtomic).toHaveBeenCalled())
    expect(mocks.state.setFinalChapterSave).toHaveBeenCalledWith(
      expect.objectContaining({ saving: false, phase: "saved" }),
    )
    expect(mocks.writeFileAtomic.mock.calls[0][1]).toContain("chapter_status: final")
    cleanup()
  })

  it("autoIngestOnSave + 无可用 LLM → ingest_no_llm", async () => {
    chapterSetup({ reviewBeforeSave: false, autoIngestOnSave: true })
    mocks.hasUsableLlm.mockReturnValue(false)
    const { cleanup } = await renderPanel()
    fireEvent.click(screen.getByText("novel.chapter.saveAsCanon"))
    await waitFor(() => expect(mocks.state.setFinalChapterSave).toHaveBeenCalledWith(
      expect.objectContaining({ saving: false, phase: "ingest_no_llm" }),
    ))
    cleanup()
  })

  it("autoIngestOnSave + 快照成功 → ingested", async () => {
    chapterSetup({ reviewBeforeSave: false, autoIngestOnSave: true })
    mocks.ingestChapter.mockResolvedValue({ snapshot: { chapterNumber: 1 }, failReason: null })
    const { cleanup } = await renderPanel()
    fireEvent.click(screen.getByText("novel.chapter.saveAsCanon"))
    await waitFor(() => expect(mocks.state.setFinalChapterSave).toHaveBeenCalledWith(
      expect.objectContaining({ saving: false, phase: "ingested", params: { chapter: 1 } }),
    ), { timeout: 3000 })
    expect(mocks.importState.startTask).toHaveBeenCalled()
    expect(mocks.importState.finishTask).toHaveBeenCalledWith("task-1", "done", expect.anything())
    cleanup()
  })

  it("autoIngestOnSave + invalid_chapter_number → ingest_no_chapter_number", async () => {
    chapterSetup({ reviewBeforeSave: false, autoIngestOnSave: true })
    mocks.ingestChapter.mockResolvedValue({ snapshot: null, failReason: "invalid_chapter_number" })
    const { cleanup } = await renderPanel()
    fireEvent.click(screen.getByText("novel.chapter.saveAsCanon"))
    await waitFor(() => expect(mocks.state.setFinalChapterSave).toHaveBeenCalledWith(
      expect.objectContaining({ phase: "ingest_no_chapter_number" }),
    ))
    cleanup()
  })

  it("autoIngestOnSave + not_final → ingest_not_final", async () => {
    chapterSetup({ reviewBeforeSave: false, autoIngestOnSave: true })
    mocks.ingestChapter.mockResolvedValue({ snapshot: null, failReason: "not_final" })
    const { cleanup } = await renderPanel()
    fireEvent.click(screen.getByText("novel.chapter.saveAsCanon"))
    await waitFor(() => expect(mocks.state.setFinalChapterSave).toHaveBeenCalledWith(
      expect.objectContaining({ phase: "ingest_not_final" }),
    ))
    cleanup()
  })

  it("autoIngestOnSave + extract_failed → ingest_extract_failed", async () => {
    chapterSetup({ reviewBeforeSave: false, autoIngestOnSave: true })
    mocks.ingestChapter.mockResolvedValue({ snapshot: null, failReason: "extract_failed" })
    const { cleanup } = await renderPanel()
    fireEvent.click(screen.getByText("novel.chapter.saveAsCanon"))
    await waitFor(() => expect(mocks.state.setFinalChapterSave).toHaveBeenCalledWith(
      expect.objectContaining({ phase: "ingest_extract_failed" }),
    ))
    cleanup()
  })

  it("autoIngestOnSave + 其他 failReason → ingest_failed", async () => {
    chapterSetup({ reviewBeforeSave: false, autoIngestOnSave: true })
    mocks.ingestChapter.mockResolvedValue({ snapshot: null, failReason: "unknown" })
    const { cleanup } = await renderPanel()
    fireEvent.click(screen.getByText("novel.chapter.saveAsCanon"))
    await waitFor(() => expect(mocks.state.setFinalChapterSave).toHaveBeenCalledWith(
      expect.objectContaining({ phase: "ingest_failed" }),
    ))
    cleanup()
  })

  it("autoIngestOnSave + 磁盘验证非 final → 重写回写后提取", async () => {
    chapterSetup({ reviewBeforeSave: false, autoIngestOnSave: true })
    mocks.ingestChapter.mockResolvedValue({ snapshot: { chapterNumber: 1 }, failReason: null })
    const { cleanup } = await renderPanel()
    fireEvent.click(screen.getByText("novel.chapter.saveAsCanon"))
    await waitFor(() => expect(mocks.state.setFinalChapterSave).toHaveBeenCalledWith(
      expect.objectContaining({ phase: "ingested" }),
    ), { timeout: 3000 })
    expect(mocks.writeFileAtomic).toHaveBeenCalled()
    cleanup()
  })

  it("保存流程抛错 → ingest_failed + message", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    chapterSetup({ reviewBeforeSave: false, autoIngestOnSave: false })
    mocks.writeFileAtomic.mockRejectedValue(new Error("disk-full"))
    const { cleanup } = await renderPanel()
    fireEvent.click(screen.getByText("novel.chapter.saveAsCanon"))
    await waitFor(() => expect(mocks.state.setFinalChapterSave).toHaveBeenCalledWith(
      expect.objectContaining({ saving: false, phase: "ingest_failed", params: expect.objectContaining({ message: expect.stringContaining("快照提取异常") }) }),
    ))
    expect(errSpy).toHaveBeenCalled()
    errSpy.mockRestore()
    cleanup()
  })

  it("无项目时 save-as-final 按钮不渲染（canSaveAsFinal=false）", async () => {
    mocks.state.project = null
    mocks.state.selectedFile = CHAPTER_PATH
    mocks.state.fileContent = CHAPTER_MD
    mocks.readFile.mockResolvedValue(CHAPTER_MD)
    mocks.compactToolbar.value = false
    const { cleanup } = await renderPanel()
    expect(screen.queryByText("novel.chapter.saveAsCanon")).not.toBeInTheDocument()
    cleanup()
  })
})

describe("PreviewPanel 重新提取（handleReingest）", () => {
  function finalSetup(): void {
    mocks.state.selectedFile = CHAPTER_PATH
    mocks.state.fileContent = CHAPTER_MD.replace("chapter_status: draft", "chapter_status: final")
    mocks.readFile.mockResolvedValue(mocks.state.fileContent)
    mocks.compactToolbar.value = false
  }

  it("final 章节 → 重新提取成功 → ingested", async () => {
    finalSetup()
    mocks.ingestChapter.mockResolvedValue({ snapshot: { chapterNumber: 1 }, failReason: null })
    const { cleanup } = await renderPanel()
    fireEvent.click(screen.getByText("novel.chapter.reingestButton"))
    await waitFor(() => expect(mocks.state.setFinalChapterSave).toHaveBeenCalledWith(
      expect.objectContaining({ phase: "ingested" }),
    ))
    expect(mocks.importState.startTask).toHaveBeenCalledWith(expect.objectContaining({ kind: "chapter" }))
    cleanup()
  })

  it("final 章节 + invalid_chapter_number → ingest_no_chapter_number", async () => {
    finalSetup()
    mocks.ingestChapter.mockResolvedValue({ snapshot: null, failReason: "invalid_chapter_number" })
    const { cleanup } = await renderPanel()
    fireEvent.click(screen.getByText("novel.chapter.reingestButton"))
    await waitFor(() => expect(mocks.state.setFinalChapterSave).toHaveBeenCalledWith(
      expect.objectContaining({ phase: "ingest_no_chapter_number" }),
    ))
    cleanup()
  })

  it("final 章节 + 其他失败 → ingest_failed", async () => {
    finalSetup()
    mocks.ingestChapter.mockResolvedValue({ snapshot: null, failReason: "boom" })
    const { cleanup } = await renderPanel()
    fireEvent.click(screen.getByText("novel.chapter.reingestButton"))
    await waitFor(() => expect(mocks.state.setFinalChapterSave).toHaveBeenCalledWith(
      expect.objectContaining({ phase: "ingest_failed" }),
    ))
    cleanup()
  })

  it("reingest 抛错 → ingest_failed + finishTask error", async () => {
    finalSetup()
    mocks.ingestChapter.mockRejectedValue(new Error("reingest-fail"))
    const { cleanup } = await renderPanel()
    fireEvent.click(screen.getByText("novel.chapter.reingestButton"))
    await waitFor(() => expect(mocks.state.setFinalChapterSave).toHaveBeenCalledWith(
      expect.objectContaining({ phase: "ingest_failed" }),
    ))
    expect(mocks.importState.finishTask).toHaveBeenCalledWith("task-1", "error", expect.anything())
    cleanup()
  })
})

describe("PreviewPanel 一键排版与去AI味", () => {
  function chapterSetup(): void {
    mocks.state.selectedFile = CHAPTER_PATH
    mocks.state.fileContent = CHAPTER_MD
    mocks.readFile.mockResolvedValue(CHAPTER_MD)
    mocks.compactToolbar.value = false
  }

  it("一键排版 → 格式化写入 + bumpDataVersion", async () => {
    chapterSetup()
    const { cleanup } = await renderPanel()
    fireEvent.click(screen.getByText("一键排版"))
    await waitFor(() => expect(mocks.writeFileAtomic).toHaveBeenCalled())
    expect(mocks.state.bumpDataVersion).toHaveBeenCalled()
    cleanup()
  })

  it("一键排版写盘失败 → console.error", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    chapterSetup()
    mocks.writeFileAtomic.mockRejectedValue(new Error("fmt-fail"))
    const { cleanup } = await renderPanel()
    fireEvent.click(screen.getByText("一键排版"))
    await waitFor(() => expect(errSpy).toHaveBeenCalled())
    expect(String(errSpy.mock.calls[0][0])).toContain("格式化写作内容失败")
    errSpy.mockRestore()
    cleanup()
  })

  it("去AI味流程（onToken/onDone）→ 打开预览对话框", async () => {
    chapterSetup()
    mocks.streamChat.mockImplementation((_cfg: unknown, _msgs: unknown, cb: any) => {
      cb.onToken("改")
      cb.onToken("写")
      cb.onDone()
      return Promise.resolve()
    })
    const { cleanup } = await renderPanel()
    fireEvent.click(screen.getByText("去AI味"))
    await waitFor(() => expect(screen.getByTestId("de-ai-dialog").dataset.open).toBe("true"))
    expect(mocks.buildDeAiRewriteMessages).toHaveBeenCalled()
    expect(mocks.loadSmartDeAiSkill).toHaveBeenCalled()
    cleanup()
  })

  it("去AI味：空内容早退", async () => {
    chapterSetup()
    mocks.state.fileContent = ""
    // readFile 解析会把内容回填 store（mock setFileContent），后续重渲染（如 ResizeObserver
    // 布局 effect）会读到非空内容；因此装载内容也要置空，保证组件最后一次渲染的
    // fileContent 为空，命中 handleDeAiProcess 的空内容早退（preview-panel.tsx）。
    mocks.readFile.mockResolvedValue("")
    const { cleanup } = await renderPanel()
    fireEvent.click(screen.getByText("去AI味"))
    await flushAsync(20)
    expect(mocks.streamChat).not.toHaveBeenCalled()
    cleanup()
  })

  it("去AI味：无可用 LLM → 不调用 streamChat", async () => {
    chapterSetup()
    mocks.hasUsableLlm.mockReturnValue(false)
    const { cleanup } = await renderPanel()
    fireEvent.click(screen.getByText("去AI味"))
    await flushAsync(20)
    expect(mocks.streamChat).not.toHaveBeenCalled()
    cleanup()
  })

  it("去AI味：onError → console.error", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    chapterSetup()
    mocks.streamChat.mockImplementation((_c: unknown, _m: unknown, cb: any) => {
      cb.onError(new Error("llm error"))
      return Promise.resolve()
    })
    const { cleanup } = await renderPanel()
    fireEvent.click(screen.getByText("去AI味"))
    await waitFor(() => expect(errSpy).toHaveBeenCalled())
    expect(String(errSpy.mock.calls[0][0])).toContain("去AI味处理失败")
    errSpy.mockRestore()
    cleanup()
  })

  it("去AI味：streamChat 抛错 → console.error", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    chapterSetup()
    mocks.streamChat.mockRejectedValue(new Error("transport"))
    const { cleanup } = await renderPanel()
    fireEvent.click(screen.getByText("去AI味"))
    await waitFor(() => expect(errSpy).toHaveBeenCalled())
    expect(String(errSpy.mock.calls[0][0])).toContain("去AI味处理失败")
    errSpy.mockRestore()
    cleanup()
  })

  it("对话框应用改写 → 保存替换后的正文", async () => {
    chapterSetup()
    mocks.streamChat.mockImplementation((_c: unknown, _m: unknown, cb: any) => {
      cb.onToken("新正文")
      cb.onDone()
      return Promise.resolve()
    })
    const { cleanup } = await renderPanel()
    fireEvent.click(screen.getByText("去AI味"))
    await waitFor(() => expect(screen.getByTestId("de-ai-dialog").dataset.open).toBe("true"))
    fireEvent.click(screen.getByTestId("de-ai-apply"))
    await waitFor(() => expect(mocks.writeFileAtomic).toHaveBeenCalled(), { timeout: 3000 })
    expect(mocks.writeFileAtomic.mock.calls[0][1]).toContain("新正文")
    cleanup()
  })

  it("对话框另存草稿 → 写草稿文件 + 刷新树", async () => {
    chapterSetup()
    mocks.streamChat.mockImplementation((_c: unknown, _m: unknown, cb: any) => {
      cb.onToken("草稿内容")
      cb.onDone()
      return Promise.resolve()
    })
    const { cleanup } = await renderPanel()
    fireEvent.click(screen.getByText("去AI味"))
    await waitFor(() => expect(screen.getByTestId("de-ai-save-draft")).toBeInTheDocument())
    fireEvent.click(screen.getByTestId("de-ai-save-draft"))
    await waitFor(() => expect(mocks.writeFile).toHaveBeenCalled())
    expect(mocks.writeFile.mock.calls[0][0]).toContain("去AI味稿.md")
    expect(mocks.state.setFileTree).toHaveBeenCalled()
    expect(mocks.state.bumpDataVersion).toHaveBeenCalled()
    cleanup()
  })

  it("另存草稿失败 → console.error", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    chapterSetup()
    mocks.writeFile.mockRejectedValue(new Error("draft-fail"))
    mocks.streamChat.mockImplementation((_c: unknown, _m: unknown, cb: any) => {
      cb.onToken("x")
      cb.onDone()
      return Promise.resolve()
    })
    const { cleanup } = await renderPanel()
    fireEvent.click(screen.getByText("去AI味"))
    await waitFor(() => expect(screen.getByTestId("de-ai-save-draft")).toBeInTheDocument())
    fireEvent.click(screen.getByTestId("de-ai-save-draft"))
    await waitFor(() => expect(errSpy).toHaveBeenCalled())
    expect(String(errSpy.mock.calls[0][0])).toContain("另存去AI味草稿失败")
    errSpy.mockRestore()
    cleanup()
  })

  it("对话框关闭（handleDeAiClose）", async () => {
    chapterSetup()
    mocks.streamChat.mockImplementation((_c: unknown, _m: unknown, cb: any) => {
      cb.onToken("x")
      cb.onDone()
      return Promise.resolve()
    })
    const { cleanup } = await renderPanel()
    fireEvent.click(screen.getByText("去AI味"))
    await waitFor(() => expect(screen.getByTestId("de-ai-close")).toBeInTheDocument())
    fireEvent.click(screen.getByTestId("de-ai-close"))
    await waitFor(() => expect(screen.getByTestId("de-ai-dialog").dataset.open).toBe("false"))
    cleanup()
  })

  it("无项目时去AI味仍可打开对话框（project null 路径）", async () => {
    mocks.state.project = null
    chapterSetup()
    mocks.state.project = null
    mocks.streamChat.mockImplementation((_c: unknown, _m: unknown, cb: any) => {
      cb.onToken("x")
      cb.onDone()
      return Promise.resolve()
    })
    const { cleanup } = await renderPanel()
    fireEvent.click(screen.getByText("去AI味"))
    await waitFor(() => expect(screen.getByTestId("de-ai-dialog").dataset.open).toBe("true"))
    expect(mocks.loadSmartDeAiSkill).toHaveBeenCalledWith(null, "去AI味润色", undefined)
    cleanup()
  })

  // ── Wave 4 (v2.5.0): 批量去AI味 ──────────────────────────────────────────
  it("批量去AI味：点击 → runDeAiBatch + 对话框打开 + 完成后刷新章节列表", async () => {
    chapterSetup()
    const { cleanup } = await renderPanel()
    fireEvent.click(screen.getByText("批量去AI味"))
    await waitFor(() => expect(mocks.runDeAiBatch).toHaveBeenCalled())
    expect(mocks.runDeAiBatch.mock.calls[0][0]).toBe("/proj")
    expect(mocks.runDeAiBatch.mock.calls[0][1].llmConfig).toBeTruthy()
    expect(typeof mocks.runDeAiBatch.mock.calls[0][1].onProgress).toBe("function")
    await waitFor(() => expect(screen.getByTestId("de-ai-batch-dialog").dataset.open).toBe("true"))
    await waitFor(() => expect(mocks.loadDeAiBatchState).toHaveBeenCalled())
    expect(mocks.state.bumpDataVersion).not.toHaveBeenCalled()
    cleanup()
  })

  it("批量去AI味：无可用 LLM → 不调用 runDeAiBatch", async () => {
    chapterSetup()
    mocks.hasUsableLlm.mockReturnValue(false)
    const { cleanup } = await renderPanel()
    fireEvent.click(screen.getByText("批量去AI味"))
    await flushAsync(20)
    expect(mocks.runDeAiBatch).not.toHaveBeenCalled()
    expect(screen.getByTestId("de-ai-batch-dialog").dataset.open).toBe("false")
    cleanup()
  })

  it("批量去AI味：中止 → abort 控制器", async () => {
    chapterSetup()
    mocks.runDeAiBatch.mockImplementation(async (_p: string, options: DeAiBatchOptions) => {
      options.signal?.addEventListener("abort", () => {})
      return new Promise<DeAiBatchSummary>((resolve) => {
        setTimeout(() => {
          resolve({
            schemaVersion: "de-ai-batch/1.0",
            batchId: "de-ai-1",
            phase: "paused",
            total: 2,
            processed: 1,
            failed: [],
            skipped: 0,
            durationMs: 500,
            startedAt: "2026-08-19T00:00:00.000Z",
            finishedAt: "2026-08-19T00:00:00.500Z",
          })
        }, 50)
      })
    })
    const { cleanup } = await renderPanel()
    fireEvent.click(screen.getByText("批量去AI味"))
    await waitFor(() => expect(screen.getByTestId("de-ai-batch-dialog").dataset.open).toBe("true"))
    fireEvent.click(screen.getByTestId("de-ai-batch-cancel"))
    await waitFor(() => expect(mocks.runDeAiBatch.mock.calls[0][1].signal?.aborted).toBe(true))
    cleanup()
  })

  it("批量去AI味：运行失败 → saveStatus 显示错误", async () => {
    chapterSetup()
    mocks.runDeAiBatch.mockRejectedValue(new Error("batch-boom"))
    const { cleanup } = await renderPanel()
    fireEvent.click(screen.getByText("批量去AI味"))
    await waitFor(() => expect(screen.getByText(/批量去AI味失败/)).toBeTruthy())
    cleanup()
  })

  it("批量回填全部 → acceptAllDeAiBatchDrafts + bumpDataVersion", async () => {
    chapterSetup()
    const { cleanup } = await renderPanel()
    fireEvent.click(screen.getByText("批量去AI味"))
    await waitFor(() => expect(screen.getByTestId("de-ai-batch-accept-all")).toBeInTheDocument())
    fireEvent.click(screen.getByTestId("de-ai-batch-accept-all"))
    await waitFor(() => expect(mocks.acceptAllDeAiBatchDrafts).toHaveBeenCalledWith("/proj"))
    expect(mocks.state.bumpDataVersion).toHaveBeenCalled()
    cleanup()
  })

  it("单章回填 → acceptDeAiBatchDraft(1)", async () => {
    chapterSetup()
    const { cleanup } = await renderPanel()
    fireEvent.click(screen.getByText("批量去AI味"))
    await waitFor(() => expect(screen.getByTestId("de-ai-batch-accept-1")).toBeInTheDocument())
    fireEvent.click(screen.getByTestId("de-ai-batch-accept-1"))
    await waitFor(() => expect(mocks.acceptDeAiBatchDraft).toHaveBeenCalledWith("/proj", 1))
    expect(mocks.state.bumpDataVersion).toHaveBeenCalled()
    cleanup()
  })

  it("单章拒绝 → rejectDeAiBatchDraft(1)", async () => {
    chapterSetup()
    const { cleanup } = await renderPanel()
    fireEvent.click(screen.getByText("批量去AI味"))
    await waitFor(() => expect(screen.getByTestId("de-ai-batch-reject-1")).toBeInTheDocument())
    fireEvent.click(screen.getByTestId("de-ai-batch-reject-1"))
    await waitFor(() => expect(mocks.rejectDeAiBatchDraft).toHaveBeenCalledWith("/proj", 1))
    cleanup()
  })

  it("批量对话框关闭（handleDeAiBatchClose）", async () => {
    chapterSetup()
    const { cleanup } = await renderPanel()
    fireEvent.click(screen.getByText("批量去AI味"))
    await waitFor(() => expect(screen.getByTestId("de-ai-batch-close")).toBeInTheDocument())
    fireEvent.click(screen.getByTestId("de-ai-batch-close"))
    await waitFor(() => expect(screen.getByTestId("de-ai-batch-dialog").dataset.open).toBe("false"))
    cleanup()
  })
})

describe("PreviewPanel 选区变换（handleSelectionAction）", () => {
  function chapterSetup(): void {
    mocks.state.selectedFile = CHAPTER_PATH
    mocks.state.fileContent = CHAPTER_MD
    mocks.readFile.mockResolvedValue(CHAPTER_MD)
  }

  async function openTransformDialog(): Promise<void> {
    mocks.streamChat.mockImplementation((_c: unknown, _m: unknown, cb: any) => {
      cb.onToken("改写结果")
      cb.onDone()
      return Promise.resolve()
    })
    fireEvent.click(screen.getByTestId("editor-selection-polish"))
    await waitFor(() => expect(screen.getByTestId("tt-dialog").dataset.open).toBe("true"))
  }

  it("处理中二次点击 → 防重入只调用一次 streamChat", async () => {
    chapterSetup()
    mocks.streamChat.mockImplementation(() => new Promise(() => {}))
    const { cleanup } = await renderPanel()
    fireEvent.click(screen.getByTestId("editor-selection-polish"))
    fireEvent.click(screen.getByTestId("editor-selection-polish"))
    await flushAsync(20)
    expect(mocks.streamChat).toHaveBeenCalledTimes(1)
    cleanup()
  })

  it("处理中点击取消 → 状态「已取消」且不打开预览", async () => {
    chapterSetup()
    const captured: { cb: any; signal: AbortSignal } = {} as { cb: any; signal: AbortSignal }
    mocks.streamChat.mockImplementation((_c: unknown, _m: unknown, cb: any, signal: AbortSignal) => {
      captured.cb = cb
      captured.signal = signal
      return new Promise(() => {})
    })
    const { cleanup } = await renderPanel()
    fireEvent.click(screen.getByTestId("editor-selection-polish"))
    await waitFor(() => expect(screen.getByText(/正在调用模型/)).toBeInTheDocument())
    expect(screen.getByRole("button", { name: "取消" })).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "取消" }))
    expect(captured.signal.aborted).toBe(true)
    // 模拟真实传输层：signal 中止后回调 onDone
    act(() => {
      captured.cb.onDone()
    })
    await waitFor(() => expect(screen.getByText(/已取消/)).toBeInTheDocument())
    expect(screen.getByTestId("tt-dialog").dataset.open).toBe("false")
    cleanup()
  })

  it("零 token 超时 → 黑洞/冷启动失败文案", async () => {
    chapterSetup()
    const { cleanup } = await renderPanel()
    vi.useFakeTimers()
    const captured: { cb: any; signal: AbortSignal } = {} as { cb: any; signal: AbortSignal }
    mocks.streamChat.mockImplementation((_c: unknown, _m: unknown, cb: any, signal: AbortSignal) => {
      captured.cb = cb
      captured.signal = signal
      return new Promise(() => {})
    })
    fireEvent.click(screen.getByTestId("editor-selection-polish"))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    act(() => {
      vi.advanceTimersByTime(90_000)
    })
    expect(captured.signal.aborted).toBe(true)
    act(() => {
      captured.cb.onDone()
    })
    await act(async () => {
      await Promise.resolve()
    })
    expect(screen.getByText(/未返回任何内容/)).toBeInTheDocument()
    vi.useRealTimers()
    cleanup()
  })

  it("有 token 超时 → 生成超时文案", async () => {
    chapterSetup()
    const { cleanup } = await renderPanel()
    vi.useFakeTimers()
    const captured: { cb: any; signal: AbortSignal } = {} as { cb: any; signal: AbortSignal }
    mocks.streamChat.mockImplementation((_c: unknown, _m: unknown, cb: any, signal: AbortSignal) => {
      captured.cb = cb
      captured.signal = signal
      return new Promise(() => {})
    })
    fireEvent.click(screen.getByTestId("editor-selection-polish"))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    act(() => {
      captured.cb.onToken("部分内容")
    })
    act(() => {
      vi.advanceTimersByTime(90_000)
    })
    act(() => {
      captured.cb.onDone()
    })
    await act(async () => {
      await Promise.resolve()
    })
    expect(screen.getByText(/生成超时/)).toBeInTheDocument()
    vi.useRealTimers()
    cleanup()
  })

  it("成功后防重入护栏复位（可再次触发）", async () => {
    chapterSetup()
    mocks.streamChat.mockImplementation((_c: unknown, _m: unknown, cb: any) => {
      cb.onToken("改写结果")
      cb.onDone()
      return Promise.resolve()
    })
    const { cleanup } = await renderPanel()
    fireEvent.click(screen.getByTestId("editor-selection-polish"))
    await waitFor(() => expect(screen.getByTestId("tt-dialog").dataset.open).toBe("true"))
    fireEvent.click(screen.getByTestId("tt-close"))
    fireEvent.click(screen.getByTestId("editor-selection-polish"))
    await waitFor(() => expect(mocks.streamChat).toHaveBeenCalledTimes(2))
    cleanup()
  })

  it("选中文本为空 → 早退", async () => {
    chapterSetup()
    mocks.selectionText.value = ""
    mocks.streamChat.mockImplementation((_c: unknown, _m: unknown, cb: any) => {
      cb.onDone()
      return Promise.resolve()
    })
    const { cleanup } = await renderPanel()
    fireEvent.click(screen.getByTestId("editor-selection-polish"))
    await flushAsync(30)
    expect(mocks.streamChat).not.toHaveBeenCalled()
    cleanup()
  })

  it("无可用 LLM → saveStatus 提示", async () => {
    chapterSetup()
    mocks.hasUsableLlm.mockReturnValue(false)
    const { cleanup } = await renderPanel()
    fireEvent.click(screen.getByTestId("editor-selection-polish"))
    await waitFor(() => expect(screen.getByText(/未配置可用的 AI 模型/)).toBeInTheDocument())
    cleanup()
  })

  it("polish 流程 → 打开对话框（AI润色预览）→ 应用替换", async () => {
    chapterSetup()
    const { cleanup } = await renderPanel()
    await openTransformDialog()
    expect(screen.getByTestId("tt-dialog").dataset.title).toContain("AI润色预览")
    expect(mocks.buildPolishSelectionMessages).toHaveBeenCalledWith("选中文本")
    fireEvent.click(screen.getByTestId("tt-apply"))
    await waitFor(() => expect(mocks.writeFileAtomic).toHaveBeenCalled(), { timeout: 3000 })
    expect(mocks.state.setFileContent).toHaveBeenCalledWith(expect.stringContaining("new-body"))
    cleanup()
  })

  it("de-ai 流程 → 打开对话框（去AI味预览）", async () => {
    chapterSetup()
    mocks.streamChat.mockImplementation((_c: unknown, _m: unknown, cb: any) => {
      cb.onToken("改写结果")
      cb.onDone()
      return Promise.resolve()
    })
    const { cleanup } = await renderPanel()
    fireEvent.click(screen.getByTestId("editor-selection-deai"))
    await waitFor(() => expect(screen.getByTestId("tt-dialog").dataset.open).toBe("true"))
    expect(screen.getByTestId("tt-dialog").dataset.title).toContain("去AI味预览")
    expect(mocks.buildDeAiRewriteMessages).toHaveBeenCalledWith("选中文本", undefined)
    cleanup()
  })

  it("onError → 脱敏后的失败 saveStatus", async () => {
    chapterSetup()
    mocks.streamChat.mockImplementation((_c: unknown, _m: unknown, cb: any) => {
      cb.onError(new Error("http://secret.example.com/x Bearer abc"))
      return Promise.resolve()
    })
    const { cleanup } = await renderPanel()
    fireEvent.click(screen.getByTestId("editor-selection-polish"))
    await waitFor(() => expect(screen.getByText(/AI润色失败/)).toBeInTheDocument())
    expect(screen.getByText(/\[url\]/)).toBeInTheDocument()
    expect(screen.getByText(/\[redacted\]/)).toBeInTheDocument()
    cleanup()
  })

  it("streamChat 抛错 → 脱敏 catch 路径", async () => {
    chapterSetup()
    mocks.streamChat.mockRejectedValue(new Error("Bearer tok http://x.com"))
    const { cleanup } = await renderPanel()
    fireEvent.click(screen.getByTestId("editor-selection-polish"))
    await waitFor(() => expect(screen.getByText(/AI润色失败/)).toBeInTheDocument())
    cleanup()
  })

  it("onDone 时文件已切换 → 不打开对话框", async () => {
    chapterSetup()
    let cb: any
    mocks.streamChat.mockImplementation((_c: unknown, _m: unknown, callbacks: any) => {
      cb = callbacks
      return new Promise(() => {})
    })
    const view = render(<PreviewPanel />)
    await flushAsync(10)
    fireEvent.click(screen.getByTestId("editor-selection-polish"))
    await flushAsync(10)
    mocks.state.selectedFile = "/proj/wiki/chapters/其他.md"
    mocks.readFile.mockResolvedValue("# 其他")
    view.rerender(<PreviewPanel />)
    await flushAsync(20)
    cb.onDone()
    await flushAsync(30)
    expect(screen.getByTestId("tt-dialog").dataset.open).toBe("false")
    view.unmount()
  })

  it("应用时正文已变化（replace ok=false）→ 关闭并提示", async () => {
    chapterSetup()
    mocks.replaceChapterBodySelection.mockReturnValue({ ok: false, reason: "changed" })
    const { cleanup } = await renderPanel()
    await openTransformDialog()
    fireEvent.click(screen.getByTestId("tt-apply"))
    await waitFor(() => expect(screen.getByText("正文内容已变化，请重新选中文本后再试")).toBeInTheDocument())
    expect(screen.getByTestId("tt-dialog").dataset.open).toBe("false")
    cleanup()
  })

  it("对话框关闭（handleCloseSelectionTransform）", async () => {
    chapterSetup()
    const { cleanup } = await renderPanel()
    await openTransformDialog()
    fireEvent.click(screen.getByTestId("tt-close"))
    await waitFor(() => expect(screen.getByTestId("tt-dialog").dataset.open).toBe("false"))
    cleanup()
  })
})

describe("PreviewPanel 工具栏（compact / expanded）", () => {
  it("compact 模式：更多功能菜单开关 + 会话栏切换", async () => {
    mocks.state.selectedFile = CHAPTER_PATH
    mocks.state.fileContent = CHAPTER_MD
    mocks.readFile.mockResolvedValue(CHAPTER_MD)
    const { cleanup } = await renderPanel()
    const moreBtn = screen.getByLabelText("更多功能")
    fireEvent.click(moreBtn)
    expect(screen.getByText("打开会话栏")).toBeInTheDocument()
    fireEvent.click(screen.getByText("打开会话栏"))
    expect(mocks.state.setChatExpanded).toHaveBeenCalledWith(true)
    expect(screen.queryByText("打开会话栏")).not.toBeInTheDocument()
    cleanup()
  })

  it("compact 模式：chatExpanded=true 显示关闭会话栏", async () => {
    mocks.state.selectedFile = CHAPTER_PATH
    mocks.state.fileContent = CHAPTER_MD
    mocks.state.chatExpanded = true
    mocks.readFile.mockResolvedValue(CHAPTER_MD)
    const { cleanup } = await renderPanel()
    fireEvent.click(screen.getByLabelText("更多功能"))
    expect(screen.getByText("关闭会话栏")).toBeInTheDocument()
    fireEvent.click(screen.getByText("关闭会话栏"))
    expect(mocks.state.setChatExpanded).toHaveBeenCalledWith(false)
    cleanup()
  })

  it("compact 模式：查看快照 + 快照查看器渲染（Suspense）", async () => {
    mocks.state.selectedFile = CHAPTER_PATH
    mocks.state.fileContent = CHAPTER_MD
    mocks.readFile.mockResolvedValue(CHAPTER_MD)
    const { cleanup } = await renderPanel()
    fireEvent.click(screen.getByLabelText("更多功能"))
    fireEvent.click(screen.getByText("novel.snapshot.viewButton"))
    await waitFor(() => expect(screen.getByTestId("snapshot-viewer")).toBeInTheDocument())
    expect(screen.getByText("/proj:1")).toBeInTheDocument()
    fireEvent.click(screen.getByTestId("snapshot-close"))
    await waitFor(() => expect(screen.queryByTestId("snapshot-viewer")).not.toBeInTheDocument())
    cleanup()
  })

  it("compact 模式：大纲快照查看器", async () => {
    mocks.state.selectedFile = OUTLINE_PATH
    mocks.state.fileContent = "# 大纲"
    mocks.readFile.mockResolvedValue("# 大纲")
    mocks.fileExists.mockResolvedValue(true)
    const { cleanup } = await renderPanel()
    // compact 模式下「已提取记忆」按钮文案位于更多功能下拉内（preview-panel.tsx），
    // 先打开下拉再断言（fileExists 判定 outlineIngested 后文案才切换）。
    fireEvent.click(screen.getByLabelText("更多功能"))
    await waitFor(() => expect(screen.getByText("已提取记忆")).toBeInTheDocument())
    fireEvent.click(screen.getByText("novel.snapshot.viewButton"))
    await waitFor(() => expect(screen.getByTestId("snapshot-viewer")).toBeInTheDocument())
    cleanup()
  })

  it("compact 模式：角色认知 + 人设批判面板", async () => {
    mocks.state.selectedFile = CHAPTER_PATH
    mocks.state.fileContent = CHAPTER_MD
    mocks.readFile.mockResolvedValue(CHAPTER_MD)
    const { cleanup } = await renderPanel()
    fireEvent.click(screen.getByLabelText("更多功能"))
    fireEvent.click(screen.getByText("novel.cognition.title"))
    expect(screen.getByTestId("cognition-panel")).toBeInTheDocument()
    fireEvent.click(screen.getByTestId("cognition-close"))
    expect(screen.queryByTestId("cognition-panel")).not.toBeInTheDocument()

    fireEvent.click(screen.getByLabelText("更多功能"))
    fireEvent.click(screen.getByText("novel.persona.title"))
    expect(screen.getByTestId("persona-panel")).toBeInTheDocument()
    fireEvent.click(screen.getByTestId("persona-close"))
    expect(screen.queryByTestId("persona-panel")).not.toBeInTheDocument()
    cleanup()
  })

  it("expanded 模式：非 compact 工具栏按钮全集", async () => {
    mocks.compactToolbar.value = false
    mocks.state.selectedFile = CHAPTER_PATH
    mocks.state.fileContent = CHAPTER_MD
    mocks.readFile.mockResolvedValue(CHAPTER_MD)
    const { cleanup } = await renderPanel()
    expect(screen.getByText("AI会话")).toBeInTheDocument()
    expect(screen.getByText("去AI味")).toBeInTheDocument()
    expect(screen.getByText("novel.chapter.saveAsCanon")).toBeInTheDocument()
    expect(screen.getByText("一键排版")).toBeInTheDocument()
    expect(screen.getByText("novel.snapshot.viewButton")).toBeInTheDocument()
    expect(screen.getByText("novel.cognition.title")).toBeInTheDocument()
    expect(screen.getByText("novel.persona.title")).toBeInTheDocument()
    fireEvent.click(screen.getByText("AI会话"))
    expect(mocks.state.setChatExpanded).toHaveBeenCalledWith(true)
    fireEvent.click(screen.getByText("novel.cognition.title"))
    expect(screen.getByTestId("cognition-panel")).toBeInTheDocument()
    cleanup()
  })

  it("expanded 模式：final 章节显示重新提取按钮", async () => {
    mocks.compactToolbar.value = false
    const finalMd = CHAPTER_MD.replace("chapter_status: draft", "chapter_status: final")
    mocks.state.selectedFile = CHAPTER_PATH
    mocks.state.fileContent = finalMd
    mocks.readFile.mockResolvedValue(finalMd)
    mocks.ingestChapter.mockResolvedValue({ snapshot: null, failReason: "boom" })
    const { cleanup } = await renderPanel()
    expect(screen.getByText("novel.chapter.reingestButton")).toBeInTheDocument()
    expect(screen.queryByText("novel.chapter.saveAsCanon")).not.toBeInTheDocument()
    fireEvent.click(screen.getByText("novel.chapter.reingestButton"))
    await waitFor(() => expect(mocks.state.setFinalChapterSave).toHaveBeenCalledWith(
      expect.objectContaining({ phase: "ingest_failed" }),
    ))
    cleanup()
  })

  it("非章节文件：无章节工具按钮，关闭按钮回到空态", async () => {
    mocks.compactToolbar.value = false
    mocks.state.selectedFile = "/proj/wiki/notes.md"
    mocks.state.fileContent = "# 笔记"
    mocks.readFile.mockResolvedValue("# 笔记")
    const { cleanup } = await renderPanel()
    expect(screen.queryByText("AI会话")).not.toBeInTheDocument()
    const xBtn = document.querySelector("button svg.lucide-x")?.closest("button") as HTMLButtonElement
    fireEvent.click(xBtn)
    expect(mocks.state.setSelectedFile).toHaveBeenCalledWith(null)
    cleanup()
  })

  it("普通 markdown 无标题输入框", async () => {
    mocks.state.selectedFile = "/proj/wiki/notes.md"
    mocks.state.fileContent = "# 笔记"
    mocks.readFile.mockResolvedValue("# 笔记")
    const { cleanup } = await renderPanel()
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument()
    cleanup()
  })
})

describe("PreviewPanel 编辑器高亮与 saveStatus", () => {
  it("pendingEditorHighlight 匹配当前文件 → 传给 WikiEditor + 处理后清除", async () => {
    mocks.state.selectedFile = CHAPTER_PATH
    mocks.state.fileContent = CHAPTER_MD
    mocks.state.pendingEditorHighlight = { path: CHAPTER_PATH, text: "正文第一段", nonce: 1 }
    mocks.readFile.mockResolvedValue(CHAPTER_MD)
    const { cleanup } = await renderPanel()
    expect(screen.getByTestId("editor-highlight").textContent).toBe("正文第一段")
    fireEvent.click(screen.getByTestId("editor-highlight-handled"))
    expect(mocks.state.setPendingEditorHighlight).toHaveBeenCalledWith(null)
    cleanup()
  })

  it("pendingEditorHighlight 路径不匹配 → 不传递；onHighlightHandled 无高亮时不清除", async () => {
    mocks.state.selectedFile = CHAPTER_PATH
    mocks.state.fileContent = CHAPTER_MD
    mocks.state.pendingEditorHighlight = { path: "/other.md", text: "x", nonce: 1 }
    mocks.readFile.mockResolvedValue(CHAPTER_MD)
    const { cleanup } = await renderPanel()
    expect(screen.getByTestId("editor-highlight").textContent).toBe("none")
    fireEvent.click(screen.getByTestId("editor-highlight-handled"))
    expect(mocks.state.setPendingEditorHighlight).not.toHaveBeenCalled()
    cleanup()
  })

  it("visibleSaveStatus：finalChapterSave 带 params → t(label, params)", async () => {
    mocks.state.selectedFile = CHAPTER_PATH
    mocks.state.fileContent = CHAPTER_MD
    mocks.state.finalChapterSave = {
      projectPath: "/proj", filePath: CHAPTER_PATH, saving: false, phase: "blocked_by_review", params: { count: 2, warnings: 1 },
    }
    mocks.readFile.mockResolvedValue(CHAPTER_MD)
    const { cleanup } = await renderPanel()
    expect(mocks.t).toHaveBeenCalledWith("novel.chapter.reviewBlockedWithErrors", { count: 2, warnings: 1 })
    cleanup()
  })

  it("visibleSaveStatus：无 params → 直接 label 渲染", async () => {
    mocks.state.selectedFile = CHAPTER_PATH
    mocks.state.fileContent = CHAPTER_MD
    mocks.state.finalChapterSave = { projectPath: "/proj", filePath: CHAPTER_PATH, saving: false, phase: "ingested", params: undefined }
    mocks.readFile.mockResolvedValue(CHAPTER_MD)
    const { cleanup } = await renderPanel()
    expect(screen.getByText("novel.chapter.ingestSuccess")).toBeInTheDocument()
    cleanup()
  })

  it("visibleSaveStatus：其他项目 finalChapterSave 不匹配 → saveStatus 兜底", async () => {
    mocks.state.selectedFile = CHAPTER_PATH
    mocks.state.fileContent = CHAPTER_MD
    mocks.state.finalChapterSave = { projectPath: "/other", filePath: CHAPTER_PATH, saving: false, phase: "ingested", params: undefined }
    mocks.readFile.mockResolvedValue(CHAPTER_MD)
    const { cleanup } = await renderPanel()
    expect(screen.queryByText("novel.chapter.ingestSuccess")).not.toBeInTheDocument()
    cleanup()
  })

  it("章节输入框宽度测量：编辑态宽度变化", async () => {
    const rectSpy = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ width: 120 } as DOMRect)
    mocks.state.selectedFile = CHAPTER_PATH
    mocks.state.fileContent = CHAPTER_MD
    mocks.readFile.mockResolvedValue(CHAPTER_MD)
    const { cleanup } = await renderPanel()
    const input = screen.getByRole("textbox")
    expect(input.style.width).toBe("122px")
    fireEvent.focus(input)
    expect(input.style.width).toBe("136px")
    rectSpy.mockRestore()
    cleanup()
  })

  it("章节输入宽度不变化时保持原值（相同宽度分支）", async () => {
    mocks.state.selectedFile = CHAPTER_PATH
    mocks.state.fileContent = CHAPTER_MD
    mocks.readFile.mockResolvedValue(CHAPTER_MD)
    const { cleanup } = await renderPanel()
    const input = screen.getByRole("textbox")
    expect(input.style.width).toBe("48px")
    cleanup()
  })
})

describe("PreviewPanel 回收站预览", () => {
  it("markdown 回收项 → WikiReader + 关闭按钮", async () => {
    mocks.state.selectedTrashItem = {
      id: "t1", name: "已删章节.md", originalPath: "/proj/wiki/chapters/已删章节.md",
      trashPath: "/trash/x.md", deletedAt: 0, expiresAt: 0, kind: "chapter",
    }
    mocks.state.fileContent = "---\ntitle: 已删\n---\n\n回收站正文"
    const { cleanup } = await renderPanel()
    expect(screen.getByTestId("wiki-reader").textContent).toContain("回收站正文")
    expect(screen.getByText("已删章节.md")).toBeInTheDocument()
    fireEvent.click(screen.getByTitle("关闭预览"))
    expect(mocks.state.setSelectedTrashItem).toHaveBeenCalledWith(null)
    cleanup()
  })

  it("非 markdown 回收项（outline kind）→ FilePreview", async () => {
    mocks.state.selectedTrashItem = {
      id: "t2", name: "a.png", originalPath: "/proj/a.png",
      trashPath: "/trash/a.png", deletedAt: 0, expiresAt: 0, kind: "outline",
    }
    mocks.state.fileContent = "binary"
    const { cleanup } = await renderPanel()
    expect(screen.getByTestId("file-preview")).toBeInTheDocument()
    expect(mocks.t).toHaveBeenCalledWith("trash.kindOutline", expect.anything())
    cleanup()
  })

  it("history 与 page 种类标签", async () => {
    mocks.state.selectedTrashItem = {
      id: "t3", name: "h.md", originalPath: "/proj/history/h.md",
      trashPath: "/trash/h.md", deletedAt: 0, expiresAt: 0, kind: "history",
    }
    mocks.state.fileContent = "---\n---\n\nx"
    const { cleanup } = await renderPanel()
    expect(mocks.t).toHaveBeenCalledWith("trash.kindHistory", expect.anything())

    mocks.state.selectedTrashItem = {
      id: "t4", name: "p.md", originalPath: "/proj/pages/p.md",
      trashPath: "/trash/p.md", deletedAt: 0, expiresAt: 0, kind: "page",
    }
    mocks.state.fileContent = "---\n---\n\nx"
    const view2 = render(<PreviewPanel />)
    await flushAsync(10)
    expect(mocks.t).toHaveBeenCalledWith("trash.kindPage", expect.anything())
    view2.unmount()
    cleanup()
  })
})

describe("PreviewPanel 布局与生命周期", () => {
  it("ResizeObserver 缺失时退回 window resize 监听", async () => {
    (globalThis as Record<string, unknown>).ResizeObserver = undefined
    mocks.state.selectedFile = CHAPTER_PATH
    mocks.state.fileContent = CHAPTER_MD
    mocks.readFile.mockResolvedValue(CHAPTER_MD)
    const { cleanup } = await renderPanel()
    window.dispatchEvent(new Event("resize"))
    await flushAsync(10)
    cleanup()
  })
})

describe("PreviewPanel 全口径补盲（W4E4 迭代）", () => {
  const NO_NUM_MD = [
    "---",
    "type: chapter",
    "chapter_status: draft",
    "---",
    "",
    "# 无编号章节",
    "",
    "正文。",
    "",
  ].join("\n")

  const NO_NUM_FINAL_MD = [
    "---",
    "type: chapter",
    "chapter_status: final",
    "---",
    "",
    "# 无编号终稿",
    "",
    "正文。",
    "",
  ].join("\n")

  function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
    let resolve!: (v: T) => void
    let reject!: (e: unknown) => void
    const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
    return { promise, resolve, reject }
  }

  it("保存写盘失败 → console.error（handleSave 去抖 catch）", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    mocks.state.selectedFile = "/proj/wiki/notes.md"
    mocks.readFile.mockResolvedValue("# 笔记\n\n内容")
    mocks.writeFileAtomic.mockRejectedValue(new Error("disk-fail"))
    const { cleanup } = await renderPanel()
    fireEvent.click(screen.getByTestId("editor-save"))
    await waitFor(() => expect(errSpy).toHaveBeenCalled(), { timeout: 3000 })
    expect(String(errSpy.mock.calls[0][0])).toContain("保存失败")
    errSpy.mockRestore()
    cleanup()
  })

  it("连续两次保存 → 去抖清理前一次 timer，仅写入一次", async () => {
    mocks.state.selectedFile = CHAPTER_PATH
    mocks.state.fileContent = CHAPTER_MD
    mocks.readFile.mockResolvedValue(CHAPTER_MD)
    mocks.saveText.value = "第一次改动"
    const { cleanup } = await renderPanel()
    fireEvent.click(screen.getByTestId("editor-save"))
    mocks.saveText.value = "第二次改动"
    fireEvent.click(screen.getByTestId("editor-save"))
    await waitFor(() => expect(mocks.writeFileAtomic).toHaveBeenCalledTimes(1), { timeout: 3000 })
    expect(mocks.writeFileAtomic.mock.calls[0][1]).toContain("第二次改动")
    cleanup()
  })

  it("readFile 挂起期间切换文件 → .then 守卫返回", async () => {
    const d = deferred<string>()
    mocks.readFile.mockReturnValue(d.promise)
    mocks.state.selectedFile = CHAPTER_PATH
    mocks.state.fileContent = CHAPTER_MD
    const view = render(<PreviewPanel />)
    await flushAsync(10)
    mocks.state.selectedFile = "/proj/wiki/chapters/第二章.md"
    mocks.readFile.mockResolvedValue("# 第二章")
    view.rerender(<PreviewPanel />)
    await flushAsync(10)
    d.resolve("旧内容")
    await flushAsync(20)
    expect(mocks.state.fileContent).toBe("# 第二章")
    view.unmount()
  })

  it("readFile 挂起期间切换文件后拒绝 → .catch 守卫返回", async () => {
    const d = deferred<string>()
    mocks.readFile.mockReturnValue(d.promise)
    mocks.state.selectedFile = CHAPTER_PATH
    mocks.state.fileContent = CHAPTER_MD
    const view = render(<PreviewPanel />)
    await flushAsync(10)
    mocks.state.selectedFile = "/proj/wiki/chapters/第二章.md"
    mocks.readFile.mockResolvedValue("# 第二章")
    view.rerender(<PreviewPanel />)
    await flushAsync(10)
    d.reject(new Error("late-fail"))
    await flushAsync(20)
    expect(mocks.state.fileContent).toBe("# 第二章")
    view.unmount()
  })

  it("无 chapter_number 章节：改标题 → 重命名同步（meta null 分支）", async () => {
    mocks.state.selectedFile = "/proj/wiki/chapters/无编号章节.md"
    mocks.state.fileContent = NO_NUM_MD
    mocks.readFile.mockResolvedValue(NO_NUM_MD)
    const { cleanup } = await renderPanel()
    const input = screen.getByRole("textbox")
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: "新标题" } })
    fireEvent.keyDown(input, { key: "Enter" })
    fireEvent.blur(input)
    await waitFor(() => expect(mocks.writeFileAtomic).toHaveBeenCalled(), { timeout: 3000 })
    expect(mocks.deleteFile).toHaveBeenCalled()
    expect(mocks.state.setFileTree).toHaveBeenCalled()
    cleanup()
  })

  it("无 chapter_number 章节：清空标题 → fallback 后早退（不写盘）", async () => {
    mocks.state.selectedFile = "/proj/wiki/chapters/无编号章节.md"
    mocks.state.fileContent = NO_NUM_MD
    mocks.readFile.mockResolvedValue(NO_NUM_MD)
    const { cleanup } = await renderPanel()
    const input = screen.getByRole("textbox")
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: "" } })
    fireEvent.blur(input)
    await flushAsync(30)
    expect(mocks.writeFileAtomic).not.toHaveBeenCalled()
    cleanup()
  })

  it("多任务大纲（done/error/无 outlinePath）→ 排序取最新 message", async () => {
    const task = (id: string, status: string, outlinePath: string | null, message: string, updatedAt: number) => ({
      id, projectPath: "/proj", kind: "ingest", genre: "", scale: "", premise: "", prompt: "", userRequest: "",
      selectedSectionKey: null, displayTitle: null, writeMode: null, targetPath: null, outlinePath,
      status, message, error: status === "error" ? "x" : null, createdAt: 1, updatedAt,
    })
    mocks.state.selectedFile = OUTLINE_PATH
    mocks.state.fileContent = "# 大纲"
    mocks.readFile.mockResolvedValue("# 大纲")
    const view = render(<PreviewPanel />)
    await flushAsync(20)
    mocks.outlineState.tasks = [
      task("t1", "done", OUTLINE_PATH, "旧任务", 10),
      task("t2", "error", OUTLINE_PATH, "错误任务", 20),
      task("t3", "ingesting", null, "null路径任务", 30),
    ]
    view.rerender(<PreviewPanel />)
    await waitFor(() => expect(screen.getByText("错误任务")).toBeInTheDocument())
    expect(screen.queryByText("旧任务")).not.toBeInTheDocument()
    view.unmount()
  })

  it("标题输入框 mouseDown/click → stopPropagation 处理器", async () => {
    mocks.state.selectedFile = CHAPTER_PATH
    mocks.state.fileContent = CHAPTER_MD
    mocks.readFile.mockResolvedValue(CHAPTER_MD)
    const { cleanup } = await renderPanel()
    const input = screen.getByRole("textbox")
    fireEvent.mouseDown(input)
    fireEvent.click(input)
    expect(input).toHaveValue("第一章")
    cleanup()
  })

  it("compact 下拉：去AI味（挂起 streamChat）→ 处理中文案", async () => {
    mocks.state.selectedFile = CHAPTER_PATH
    mocks.state.fileContent = CHAPTER_MD
    mocks.readFile.mockResolvedValue(CHAPTER_MD)
    mocks.streamChat.mockReturnValue(new Promise(() => {}))
    const { cleanup } = await renderPanel()
    fireEvent.click(screen.getByLabelText("更多功能"))
    fireEvent.click(screen.getByText("去AI味"))
    await waitFor(() => expect(mocks.streamChat).toHaveBeenCalled())
    fireEvent.click(screen.getByLabelText("更多功能"))
    await waitFor(() => expect(screen.getByText("处理中")).toBeInTheDocument())
    cleanup()
  })

  it("compact 下拉：保存为正式章节按钮", async () => {
    mocks.state.selectedFile = CHAPTER_PATH
    mocks.state.fileContent = CHAPTER_MD
    mocks.readFile.mockResolvedValue(CHAPTER_MD)
    const { cleanup } = await renderPanel()
    fireEvent.click(screen.getByLabelText("更多功能"))
    fireEvent.click(screen.getByText("novel.chapter.saveAsCanon"))
    await waitFor(() => expect(mocks.state.setFinalChapterSave).toHaveBeenCalledWith(
      expect.objectContaining({ phase: "saved" }),
    ))
    cleanup()
  })

  it("compact 下拉：finalChapterSave saving 中 → 保存按钮显示处理中文案", async () => {
    mocks.state.selectedFile = CHAPTER_PATH
    mocks.state.fileContent = CHAPTER_MD
    mocks.state.finalChapterSave = { projectPath: "/proj", filePath: CHAPTER_PATH, saving: true, phase: "saving" }
    mocks.readFile.mockResolvedValue(CHAPTER_MD)
    const { cleanup } = await renderPanel()
    fireEvent.click(screen.getByLabelText("更多功能"))
    expect(screen.getAllByText("novel.chapter.savingAsFinal").length).toBeGreaterThan(0)
    cleanup()
  })

  it("compact 下拉：final 章节 → 重新提取按钮 + 点击", async () => {
    const finalMd = CHAPTER_MD.replace("chapter_status: draft", "chapter_status: final")
    mocks.state.selectedFile = CHAPTER_PATH
    mocks.state.fileContent = finalMd
    mocks.readFile.mockResolvedValue(finalMd)
    const { cleanup } = await renderPanel()
    fireEvent.click(screen.getByLabelText("更多功能"))
    expect(screen.getByText("novel.chapter.reingestButton")).toBeInTheDocument()
    fireEvent.click(screen.getByText("novel.chapter.reingestButton"))
    await waitFor(() => expect(mocks.state.setFinalChapterSave).toHaveBeenCalledWith(
      expect.objectContaining({ phase: "ingest_failed" }),
    ))
    cleanup()
  })

  it("compact 下拉：final + saving 中 → 重新提取按钮显示处理中文案", async () => {
    const finalMd = CHAPTER_MD.replace("chapter_status: draft", "chapter_status: final")
    mocks.state.selectedFile = CHAPTER_PATH
    mocks.state.fileContent = finalMd
    mocks.state.finalChapterSave = { projectPath: "/proj", filePath: CHAPTER_PATH, saving: true, phase: "saving" }
    mocks.readFile.mockResolvedValue(finalMd)
    const { cleanup } = await renderPanel()
    fireEvent.click(screen.getByLabelText("更多功能"))
    expect(screen.getAllByText("novel.chapter.savingAsFinal").length).toBeGreaterThan(0)
    cleanup()
  })

  it("compact 下拉：一键排版", async () => {
    mocks.state.selectedFile = CHAPTER_PATH
    mocks.state.fileContent = CHAPTER_MD
    mocks.readFile.mockResolvedValue(CHAPTER_MD)
    const { cleanup } = await renderPanel()
    fireEvent.click(screen.getByLabelText("更多功能"))
    fireEvent.click(screen.getByText("一键排版"))
    await waitFor(() => expect(mocks.writeFileAtomic).toHaveBeenCalled())
    cleanup()
  })

  it("expanded 大纲摄入按钮（未提取）→ startOutlineIngestTask", async () => {
    mocks.compactToolbar.value = false
    mocks.state.selectedFile = OUTLINE_PATH
    mocks.state.fileContent = "# 大纲"
    mocks.readFile.mockResolvedValue("# 大纲")
    mocks.fileExists.mockResolvedValue(false)
    const { cleanup } = await renderPanel()
    await waitFor(() => expect(screen.getByText("novel.outlineGenerator.ingest")).toBeInTheDocument())
    fireEvent.click(screen.getByText("novel.outlineGenerator.ingest"))
    expect(mocks.startOutlineIngestTask).toHaveBeenCalledWith("/proj", OUTLINE_PATH)
    cleanup()
  })

  it("expanded 大纲已提取 → ✓ 已提取记忆 文案 + 快照按钮", async () => {
    mocks.compactToolbar.value = false
    mocks.state.selectedFile = OUTLINE_PATH
    mocks.state.fileContent = "# 大纲"
    mocks.readFile.mockResolvedValue("# 大纲")
    mocks.fileExists.mockResolvedValue(true)
    const { cleanup } = await renderPanel()
    await waitFor(() => expect(screen.getByText("✓ 已提取记忆")).toBeInTheDocument())
    fireEvent.click(screen.getByText("novel.snapshot.viewButton"))
    await waitFor(() => expect(screen.getByTestId("snapshot-viewer")).toBeInTheDocument())
    cleanup()
  })

  it("expanded 大纲摄入中 → 禁用按钮文案（guard）", async () => {
    mocks.compactToolbar.value = false
    mocks.state.selectedFile = OUTLINE_PATH
    mocks.state.fileContent = "# 大纲"
    mocks.readFile.mockResolvedValue("# 大纲")
    const view = render(<PreviewPanel />)
    await flushAsync(20)
    mocks.outlineState.tasks = [{
      id: "t1", projectPath: "/proj", kind: "ingest", genre: "", scale: "", premise: "", prompt: "", userRequest: "",
      selectedSectionKey: null, displayTitle: null, writeMode: null, targetPath: null, outlinePath: OUTLINE_PATH,
      status: "ingesting", message: "正在提取", error: null, createdAt: 1, updatedAt: 1,
    }]
    view.rerender(<PreviewPanel />)
    await waitFor(() => expect(screen.getByText("novel.outlineGenerator.ingesting")).toBeInTheDocument())
    fireEvent.click(screen.getByText("novel.outlineGenerator.ingesting"))
    await flushAsync(20)
    expect(mocks.startOutlineIngestTask).not.toHaveBeenCalled()
    view.unmount()
  })

  it("expanded 快照按钮 → SnapshotViewer", async () => {
    mocks.compactToolbar.value = false
    mocks.state.selectedFile = CHAPTER_PATH
    mocks.state.fileContent = CHAPTER_MD
    mocks.readFile.mockResolvedValue(CHAPTER_MD)
    const { cleanup } = await renderPanel()
    fireEvent.click(screen.getByText("novel.snapshot.viewButton"))
    await waitFor(() => expect(screen.getByTestId("snapshot-viewer")).toBeInTheDocument())
    cleanup()
  })

  it("expanded 人设批判面板按钮", async () => {
    mocks.compactToolbar.value = false
    mocks.state.selectedFile = CHAPTER_PATH
    mocks.state.fileContent = CHAPTER_MD
    mocks.readFile.mockResolvedValue(CHAPTER_MD)
    const { cleanup } = await renderPanel()
    fireEvent.click(screen.getByText("novel.persona.title"))
    expect(screen.getByTestId("persona-panel")).toBeInTheDocument()
    cleanup()
  })

  it("大纲快照关闭 → onClose", async () => {
    mocks.state.selectedFile = OUTLINE_PATH
    mocks.state.fileContent = "# 大纲"
    mocks.readFile.mockResolvedValue("# 大纲")
    mocks.fileExists.mockResolvedValue(true)
    const { cleanup } = await renderPanel()
    fireEvent.click(screen.getByLabelText("更多功能"))
    await waitFor(() => expect(screen.getByText("novel.snapshot.viewButton")).toBeInTheDocument())
    fireEvent.click(screen.getByText("novel.snapshot.viewButton"))
    await waitFor(() => expect(screen.getByTestId("snapshot-viewer")).toBeInTheDocument())
    fireEvent.click(screen.getByTestId("snapshot-close"))
    await waitFor(() => expect(screen.queryByTestId("snapshot-viewer")).not.toBeInTheDocument())
    cleanup()
  })

  it("reviewBeforeSave 无问题 → 直接保存（results 空分支）", async () => {
    mocks.state.selectedFile = CHAPTER_PATH
    mocks.state.fileContent = CHAPTER_MD
    mocks.state.novelConfig = { reviewBeforeSave: true, autoIngestOnSave: false }
    mocks.readFile.mockResolvedValue(CHAPTER_MD)
    mocks.compactToolbar.value = false
    const { cleanup } = await renderPanel()
    fireEvent.click(screen.getByText("novel.chapter.saveAsCanon"))
    await waitFor(() => expect(mocks.state.setFinalChapterSave).toHaveBeenCalledWith(
      expect.objectContaining({ phase: "saved" }),
    ))
    expect(mocks.reviewState.addNovelReviewEntry).not.toHaveBeenCalled()
    cleanup()
  })

  it("保存为正式前有挂起去抖 timer → 清理后同步保存", async () => {
    mocks.state.selectedFile = CHAPTER_PATH
    mocks.state.fileContent = CHAPTER_MD
    mocks.readFile.mockResolvedValue(CHAPTER_MD)
    mocks.compactToolbar.value = false
    const { cleanup } = await renderPanel()
    fireEvent.click(screen.getByTestId("editor-save"))
    fireEvent.click(screen.getByText("novel.chapter.saveAsCanon"))
    await waitFor(() => expect(mocks.state.setFinalChapterSave).toHaveBeenCalledWith(
      expect.objectContaining({ phase: "saved" }),
    ), { timeout: 3000 })
    cleanup()
  })

  it("autoIngest + 磁盘已是 final → 跳过重写直接提取", async () => {
    const finalMd = CHAPTER_MD.replace("chapter_status: draft", "chapter_status: final")
    const nonCanonical = "/proj/wiki/chapters/旧名字.md"
    mocks.state.selectedFile = nonCanonical
    mocks.state.fileContent = CHAPTER_MD
    mocks.state.novelConfig = { reviewBeforeSave: false, autoIngestOnSave: true }
    // 加载读旧路径（draft）；rename 后 canonical 路径（第1章.md）与 verify 读都返回
    // final 内容 → verifyFm final → 跳过重写分支（preview-panel.tsx 634 else）。
    mocks.readFile.mockImplementation(async (p: string) => (p === nonCanonical ? CHAPTER_MD : finalMd))
    mocks.ingestChapter.mockResolvedValue({ snapshot: { chapterNumber: 1 }, failReason: null })
    mocks.compactToolbar.value = false
    const { cleanup } = await renderPanel()
    fireEvent.click(screen.getByText("novel.chapter.saveAsCanon"))
    await waitFor(() => expect(mocks.state.setFinalChapterSave).toHaveBeenCalledWith(
      expect.objectContaining({ phase: "ingested" }),
    ), { timeout: 3000 })
    cleanup()
  })

  it("autoIngest + 无标题无编号章节 → chapterTitle 兜底 第?章", async () => {
    mocks.state.selectedFile = CHAPTER_PATH
    mocks.state.fileContent = NO_NUM_MD
    mocks.state.novelConfig = { reviewBeforeSave: false, autoIngestOnSave: true }
    mocks.readFile.mockResolvedValue(NO_NUM_MD)
    mocks.compactToolbar.value = false
    const { cleanup } = await renderPanel()
    fireEvent.click(screen.getByText("novel.chapter.saveAsCanon"))
    await waitFor(() => expect(mocks.importState.startTask).toHaveBeenCalledWith(
      expect.objectContaining({ currentTitle: "第?章" }),
    ), { timeout: 3000 })
    cleanup()
  })

  it("saveAsCanon 抛非 Error → catch 用 String(message)", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    mocks.state.selectedFile = CHAPTER_PATH
    mocks.state.fileContent = CHAPTER_MD
    mocks.readFile.mockResolvedValue(CHAPTER_MD)
    mocks.writeFileAtomic.mockRejectedValue("raw-disk-error")
    mocks.compactToolbar.value = false
    const { cleanup } = await renderPanel()
    fireEvent.click(screen.getByText("novel.chapter.saveAsCanon"))
    await waitFor(() => expect(mocks.state.setFinalChapterSave).toHaveBeenCalledWith(
      expect.objectContaining({
        saving: false, phase: "ingest_failed",
        params: expect.objectContaining({ message: expect.stringContaining("raw-disk-error") }),
      }),
    ))
    errSpy.mockRestore()
    cleanup()
  })

  it("reingest 无标题无编号 final 章节 → 第?章 + ingest_failed", async () => {
    mocks.state.selectedFile = CHAPTER_PATH
    mocks.state.fileContent = NO_NUM_FINAL_MD
    mocks.readFile.mockResolvedValue(NO_NUM_FINAL_MD)
    mocks.compactToolbar.value = false
    const { cleanup } = await renderPanel()
    fireEvent.click(screen.getByText("novel.chapter.reingestButton"))
    await waitFor(() => expect(mocks.importState.startTask).toHaveBeenCalledWith(
      expect.objectContaining({ currentTitle: "第?章" }),
    ))
    await waitFor(() => expect(mocks.state.setFinalChapterSave).toHaveBeenCalledWith(
      expect.objectContaining({ phase: "ingest_failed" }),
    ))
    cleanup()
  })

  it("reingest 抛非 Error → catch 用 String", async () => {
    const finalMd = CHAPTER_MD.replace("chapter_status: draft", "chapter_status: final")
    mocks.state.selectedFile = CHAPTER_PATH
    mocks.state.fileContent = finalMd
    mocks.readFile.mockResolvedValue(finalMd)
    mocks.ingestChapter.mockRejectedValue("raw-reingest-fail")
    mocks.compactToolbar.value = false
    const { cleanup } = await renderPanel()
    fireEvent.click(screen.getByText("novel.chapter.reingestButton"))
    await waitFor(() => expect(mocks.state.setFinalChapterSave).toHaveBeenCalledWith(
      expect.objectContaining({ phase: "ingest_failed", params: expect.objectContaining({ message: expect.stringContaining("raw-reingest-fail") }) }),
    ))
    expect(mocks.importState.finishTask).toHaveBeenCalledWith("task-1", "error", expect.anything())
    cleanup()
  })

  it("无项目 + 另存草稿 → 早退（不写盘）", async () => {
    mocks.state.project = null
    mocks.state.selectedFile = CHAPTER_PATH
    mocks.state.fileContent = CHAPTER_MD
    mocks.readFile.mockResolvedValue(CHAPTER_MD)
    mocks.compactToolbar.value = false
    mocks.streamChat.mockImplementation((_c: unknown, _m: unknown, cb: any) => {
      cb.onToken("x")
      cb.onDone()
      return Promise.resolve()
    })
    const { cleanup } = await renderPanel()
    fireEvent.click(screen.getByText("去AI味"))
    await waitFor(() => expect(screen.getByTestId("de-ai-save-draft")).toBeInTheDocument())
    fireEvent.click(screen.getByTestId("de-ai-save-draft"))
    await flushAsync(30)
    expect(mocks.writeFile).not.toHaveBeenCalled()
    cleanup()
  })

  it("project null + 选区变换 → loadSmartDeAiSkill(null, 润色)", async () => {
    mocks.state.project = null
    mocks.state.selectedFile = CHAPTER_PATH
    mocks.state.fileContent = CHAPTER_MD
    mocks.readFile.mockResolvedValue(CHAPTER_MD)
    mocks.streamChat.mockImplementation((_c: unknown, _m: unknown, cb: any) => {
      cb.onToken("r")
      cb.onDone()
      return Promise.resolve()
    })
    const { cleanup } = await renderPanel()
    fireEvent.click(screen.getByTestId("editor-selection-polish"))
    await waitFor(() => expect(screen.getByTestId("tt-dialog").dataset.open).toBe("true"))
    expect(mocks.loadSmartDeAiSkill).toHaveBeenCalledWith(null, "润色", undefined)
    cleanup()
  })

  it("onError 时文件已切换 → 不显示失败状态", async () => {
    mocks.state.selectedFile = CHAPTER_PATH
    mocks.state.fileContent = CHAPTER_MD
    mocks.readFile.mockResolvedValue(CHAPTER_MD)
    let cb: any
    mocks.streamChat.mockImplementation((_c: unknown, _m: unknown, callbacks: any) => {
      cb = callbacks
      return new Promise(() => {})
    })
    const view = render(<PreviewPanel />)
    await flushAsync(10)
    fireEvent.click(screen.getByTestId("editor-selection-polish"))
    await flushAsync(10)
    mocks.state.selectedFile = "/proj/wiki/chapters/其他.md"
    mocks.readFile.mockResolvedValue("# 其他")
    view.rerender(<PreviewPanel />)
    await flushAsync(20)
    cb.onError(new Error("boom"))
    await flushAsync(30)
    expect(screen.queryByText(/AI润色失败/)).not.toBeInTheDocument()
    view.unmount()
  })

  it("onError 非 Error → String 脱敏", async () => {
    mocks.state.selectedFile = CHAPTER_PATH
    mocks.state.fileContent = CHAPTER_MD
    mocks.readFile.mockResolvedValue(CHAPTER_MD)
    mocks.streamChat.mockImplementation((_c: unknown, _m: unknown, cb: any) => {
      cb.onError("plain failure")
      return Promise.resolve()
    })
    const { cleanup } = await renderPanel()
    fireEvent.click(screen.getByTestId("editor-selection-polish"))
    await waitFor(() => expect(screen.getByText(/AI润色失败：plain failure/)).toBeInTheDocument())
    cleanup()
  })

  it("streamChat 抛非 Error → catch String 脱敏", async () => {
    mocks.state.selectedFile = CHAPTER_PATH
    mocks.state.fileContent = CHAPTER_MD
    mocks.readFile.mockResolvedValue(CHAPTER_MD)
    mocks.streamChat.mockRejectedValue("raw http://x.com Bearer tok")
    const { cleanup } = await renderPanel()
    fireEvent.click(screen.getByTestId("editor-selection-polish"))
    await waitFor(() => expect(screen.getByText(/AI润色失败/)).toBeInTheDocument())
    expect(screen.getByText(/\[url\]/)).toBeInTheDocument()
    cleanup()
  })

  it("streamChat 抛错后文件已切换 → 静默返回", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    mocks.state.selectedFile = CHAPTER_PATH
    mocks.state.fileContent = CHAPTER_MD
    mocks.readFile.mockResolvedValue(CHAPTER_MD)
    let rejectFn!: (e: unknown) => void
    mocks.streamChat.mockImplementation((_c: unknown, _m: unknown, _callbacks: any) => new Promise((_res, rej) => { rejectFn = rej }))
    const view = render(<PreviewPanel />)
    await flushAsync(10)
    fireEvent.click(screen.getByTestId("editor-selection-polish"))
    await flushAsync(10)
    mocks.state.selectedFile = "/proj/wiki/chapters/其他.md"
    mocks.readFile.mockResolvedValue("# 其他")
    view.rerender(<PreviewPanel />)
    await flushAsync(20)
    rejectFn(new Error("late-fail"))
    await flushAsync(30)
    expect(errSpy).not.toHaveBeenCalled()
    expect(screen.queryByText(/AI润色失败/)).not.toBeInTheDocument()
    errSpy.mockRestore()
    view.unmount()
  })

  it("未打开变换对话框直接应用 → 早退", async () => {
    mocks.state.selectedFile = CHAPTER_PATH
    mocks.state.fileContent = CHAPTER_MD
    mocks.readFile.mockResolvedValue(CHAPTER_MD)
    const { cleanup } = await renderPanel()
    fireEvent.click(screen.getByTestId("tt-apply"))
    await flushAsync(20)
    expect(mocks.writeFileAtomic).not.toHaveBeenCalled()
    cleanup()
  })

  it("标题输入框按其他键 → Escape 分支 else", async () => {
    mocks.state.selectedFile = CHAPTER_PATH
    mocks.state.fileContent = CHAPTER_MD
    mocks.readFile.mockResolvedValue(CHAPTER_MD)
    const { cleanup } = await renderPanel()
    const input = screen.getByRole("textbox")
    fireEvent.focus(input)
    fireEvent.keyDown(input, { key: "a" })
    expect(input).toHaveValue("第一章")
    cleanup()
  })

  it("compact + novelMode=false → 无角色认知/人设按钮", async () => {
    mocks.state.novelMode = false
    mocks.state.selectedFile = CHAPTER_PATH
    mocks.state.fileContent = CHAPTER_MD
    mocks.readFile.mockResolvedValue(CHAPTER_MD)
    const { cleanup } = await renderPanel()
    fireEvent.click(screen.getByLabelText("更多功能"))
    expect(screen.queryByText("novel.cognition.title")).not.toBeInTheDocument()
    expect(screen.queryByText("novel.persona.title")).not.toBeInTheDocument()
    cleanup()
  })

  it("visibleSaveStatus：t 返回非字符串 → saveStatus 兜底", async () => {
    mocks.t.mockImplementation((key: unknown, opts?: { defaultValue?: string }) => {
      if (key === "novel.chapter.reviewBlockedWithErrors") return 123
      return (opts && opts.defaultValue) ?? (key as string)
    })
    mocks.state.selectedFile = CHAPTER_PATH
    mocks.state.fileContent = CHAPTER_MD
    mocks.state.finalChapterSave = {
      projectPath: "/proj", filePath: CHAPTER_PATH, saving: false, phase: "blocked_by_review", params: { count: 2, warnings: 1 },
    }
    mocks.readFile.mockResolvedValue(CHAPTER_MD)
    const { cleanup } = await renderPanel()
    expect(mocks.t).toHaveBeenCalledWith(123, { count: 2, warnings: 1 })
    mocks.t.mockImplementation((key: string, opts?: { defaultValue?: string }) => opts?.defaultValue ?? key)
    cleanup()
  })

  it("project=null 时章节重命名 → 跳过树刷新", async () => {
    mocks.state.project = null
    mocks.state.selectedFile = "/proj/wiki/chapters/旧名字.md"
    mocks.state.fileContent = CHAPTER_MD
    mocks.readFile.mockResolvedValue(CHAPTER_MD)
    const { cleanup } = await renderPanel()
    const input = screen.getByRole("textbox")
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: "新标题" } })
    fireEvent.blur(input)
    await waitFor(() => expect(mocks.deleteFile).toHaveBeenCalledWith("/proj/wiki/chapters/旧名字.md"), { timeout: 3000 })
    expect(mocks.state.setFileTree).not.toHaveBeenCalled()
    cleanup()
  })

  it("切换文件 flush 重命名时选中路径已变 → 不重置选中", async () => {
    const nonCanonical = "/proj/wiki/chapters/旧名字.md"
    mocks.state.selectedFile = nonCanonical
    mocks.state.fileContent = CHAPTER_MD
    mocks.readFile.mockResolvedValue(CHAPTER_MD)
    mocks.saveText.value = CHAPTER_MD + "\n新增段落"
    const view = render(<PreviewPanel />)
    await flushAsync(10)
    fireEvent.click(screen.getByTestId("editor-save"))
    mocks.state.selectedFile = "/proj/wiki/chapters/第二章.md"
    mocks.readFile.mockResolvedValue("# 二")
    view.rerender(<PreviewPanel />)
    await waitFor(() => expect(mocks.state.setFileTree).toHaveBeenCalled())
    expect(mocks.state.setSelectedFile).not.toHaveBeenCalled()
    view.unmount()
  })

  it("frontmatter 存在但正文无标题 → syncChapterFrontmatterTitle 早退", async () => {
    const md = "---\ntype: chapter\nchapter_status: draft\n---\n\n正文无标题。"
    mocks.state.selectedFile = CHAPTER_PATH
    mocks.state.fileContent = md
    mocks.readFile.mockResolvedValue(md)
    mocks.saveText.value = md + "\n追加内容"
    const { cleanup } = await renderPanel()
    fireEvent.click(screen.getByTestId("editor-save"))
    await waitFor(() => expect(mocks.writeFileAtomic).toHaveBeenCalled(), { timeout: 3000 })
    cleanup()
  })

  it("frontmatter title 非字符串 → fmTitle 空回退", async () => {
    const md = ["---", "type: chapter", "title: 123", "chapter_status: draft", "---", "", "# 第一章", "", "正文。", ""].join("\n")
    mocks.state.selectedFile = CHAPTER_PATH
    mocks.state.fileContent = md
    mocks.readFile.mockResolvedValue(md)
    mocks.saveText.value = md + "\n追加内容"
    const { cleanup } = await renderPanel()
    fireEvent.click(screen.getByTestId("editor-save"))
    await waitFor(() => expect(mocks.writeFileAtomic).toHaveBeenCalled(), { timeout: 3000 })
    cleanup()
  })

  it("去AI味：onError 非 Error → String 化日志", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    mocks.state.selectedFile = CHAPTER_PATH
    mocks.state.fileContent = CHAPTER_MD
    mocks.readFile.mockResolvedValue(CHAPTER_MD)
    mocks.compactToolbar.value = false
    mocks.streamChat.mockImplementation((_c: unknown, _m: unknown, cb: any) => {
      cb.onError("plain-llm-error")
      return Promise.resolve()
    })
    const { cleanup } = await renderPanel()
    fireEvent.click(screen.getByText("去AI味"))
    await waitFor(() => expect(errSpy).toHaveBeenCalled())
    expect(String(errSpy.mock.calls[0][0])).toContain("去AI味处理失败")
    expect(String(errSpy.mock.calls[0][1])).toBe("plain-llm-error")
    errSpy.mockRestore()
    cleanup()
  })

  it("去AI味：streamChat 抛非 Error → catch String 化日志", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    mocks.state.selectedFile = CHAPTER_PATH
    mocks.state.fileContent = CHAPTER_MD
    mocks.readFile.mockResolvedValue(CHAPTER_MD)
    mocks.compactToolbar.value = false
    mocks.streamChat.mockRejectedValue("plain-transport-error")
    const { cleanup } = await renderPanel()
    fireEvent.click(screen.getByText("去AI味"))
    await waitFor(() => expect(errSpy).toHaveBeenCalled())
    expect(String(errSpy.mock.calls[0][1])).toBe("plain-transport-error")
    errSpy.mockRestore()
    cleanup()
  })

  it("章节标题与路径均无标题 → 标题回退链路保持空值", async () => {
    const md = "---\ntype: chapter\nchapter_status: draft\n---\n\n正文无标题。"
    mocks.state.selectedFile = "/proj/wiki/chapters/.md"
    mocks.state.fileContent = md
    mocks.readFile.mockResolvedValue(md)
    const { cleanup } = await renderPanel()
    const input = screen.getByRole("textbox")
    expect(input).toHaveValue("")
    fireEvent.focus(input)
    fireEvent.blur(input)
    await flushAsync(30)
    expect(mocks.writeFileAtomic).not.toHaveBeenCalled()
    cleanup()
  })

  it("章节编号存在但标题与路径均为空 → 标题回退为默认章节名", async () => {
    const md = "---\ntype: chapter\nchapter_number: 1\nchapter_status: draft\n---\n\n正文无标题。"
    mocks.state.selectedFile = "/proj/wiki/chapters/.md"
    mocks.state.fileContent = md
    mocks.readFile.mockResolvedValue(md)
    const { cleanup } = await renderPanel()
    const input = screen.getByRole("textbox")
    expect(input).toHaveValue("")
    fireEvent.focus(input)
    fireEvent.blur(input)
    await waitFor(() => expect(mocks.writeFileAtomic).toHaveBeenCalledWith(
      "/proj/wiki/chapters/第1章.md",
      expect.stringContaining("# 第1章"),
    ), { timeout: 3000 })
    cleanup()
  })
  it("重新提取时章节状态已变为非 final → 显示守卫提示并早退", async () => {
    const finalMd = CHAPTER_MD.replace("chapter_status: draft", "chapter_status: final")
    mocks.compactToolbar.value = false
    mocks.state.selectedFile = CHAPTER_PATH
    mocks.state.fileContent = finalMd
    mocks.readFile.mockResolvedValue(finalMd)
    const { cleanup } = await renderPanel()
    expect(screen.getByText("novel.chapter.reingestButton")).toBeInTheDocument()
    mocks.chapterMetaFinalGate.value = false
    fireEvent.click(screen.getByText("novel.chapter.reingestButton"))
    await waitFor(() => expect(screen.getByText("novel.chapter.reingestNotFinal")).toBeInTheDocument())
    expect(mocks.importState.startTask).not.toHaveBeenCalled()
    cleanup()
  })

  it("章节正文只有标题行 → updateChapterHeading bodyWithoutHeading 空分支", async () => {
    const headingOnlyMd = [
      "---",
      "type: chapter",
      'title: "第一章"',
      "chapter_number: 1",
      "chapter_status: draft",
      "---",
      "",
      "# 第一章",
      "",
    ].join("\n")
    mocks.state.selectedFile = CHAPTER_PATH
    mocks.state.fileContent = headingOnlyMd
    mocks.readFile.mockResolvedValue(headingOnlyMd)
    const { cleanup } = await renderPanel()
    const input = screen.getByRole("textbox")
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: "新标题" } })
    fireEvent.blur(input)
    await waitFor(() => expect(mocks.writeFileAtomic).toHaveBeenCalled(), { timeout: 3000 })
    expect(mocks.writeFileAtomic.mock.calls[0][1]).toContain("# 第1章-新标题")
    cleanup()
  })
})
