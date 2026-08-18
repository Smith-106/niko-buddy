// @vitest-environment jsdom
import type { ReactNode } from "react"
import { act, fireEvent, render, screen, waitFor, within, userEvent, setupDomGlobals } from "@/test-helpers/component-test-utils"
import { cleanup } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ReviewView } from "./review-view"
import type { ReviewItem } from "@/stores/review-store"
import type { NovelReviewResult } from "@/lib/novel/review-adapter"
import type { NovelReviewActionItem } from "@/lib/novel-review-action-items"
import type { GenerationHistoryEntry } from "@/lib/novel/generation-history"
import type { CognitionState } from "@/lib/novel/character-cognition"
import type { DashboardIssueState, DashboardIssueRewriteBackup } from "@/lib/dashboard-issue-actions"
import type { ReviewRewriteEdit, ReviewRewriteApplyResult } from "@/lib/review-rewrite-plan"
interface FileEntry {
  name: string
  isDirectory: boolean
}

interface Deferred<T> {
  promise: Promise<T>
  resolve: (v: T) => void
  reject: (e: unknown) => void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

// ── hoisted mutable state + mocks (PAT-G2: mirror every export a live
//    module might call at runtime) ──────────────────────────────────────
const mocks = vi.hoisted(() => {
  const state: Record<string, unknown> = {}
  return {

    state,
    reviewItems: [] as ReviewItem[],
    t: vi.fn((key: string) => key),
    i18nExists: vi.fn(() => true),
    resolveItem: vi.fn<(id: string) => void>(),
    dismissItem: vi.fn<(id: string) => void>(),
    clearResolved: vi.fn<() => void>(),
    // @/commands/fs mirror
    readFile: vi.fn<(path: string) => Promise<string>>(),
    writeFile: vi.fn<(path: string, content: string) => Promise<void>>(),
    writeFileAtomic: vi.fn<(path: string, content: string) => Promise<void>>(),
    listDirectory: vi.fn<(path: string) => Promise<FileEntry[]>>(),
    deleteFile: vi.fn<(path: string) => Promise<void>>(),
    copyFile: vi.fn<(src: string, dest: string) => Promise<void>>(),
    copyDirectory: vi.fn<(src: string, dest: string) => Promise<void>>(),
    preprocessFile: vi.fn<(path: string, content: string) => Promise<string>>(),
    findRelatedWikiPages: vi.fn<(path: string) => Promise<string[]>>(),
    createDirectory: vi.fn<(path: string) => Promise<void>>(),
    fileExists: vi.fn<(path: string) => Promise<boolean>>(),
    getFileModifiedTime: vi.fn<(path: string) => Promise<number | null>>(),
    getFileSize: vi.fn<(path: string) => Promise<number | null>>(),
    getFileMd5: vi.fn<(path: string) => Promise<string | null>>(),
    readFileAsBase64: vi.fn<(path: string) => Promise<string>>(),
    createProject: vi.fn<(path: string) => Promise<void>>(),
    openProject: vi.fn<(path: string) => Promise<void>>(),
    openProjectFolder: vi.fn<(path: string) => Promise<void>>(),
    openFileLocation: vi.fn<(path: string) => Promise<void>>(),
    // lib deps
    resolveDefaultModel: vi.fn<() => string | null>(() => null),
    hasUsableLlm: vi.fn<() => boolean>(() => true),
    loadCognitionState: vi.fn<() => Promise<CognitionState | null>>(),
    listGenerationHistory: vi.fn<() => Promise<GenerationHistoryEntry[]>>(),
    deleteGenerationHistoryEntry: vi.fn<(id: string) => Promise<void>>(),
    startNovelReviewRun: vi.fn<() => Promise<void>>(),
    startSixDimensionReviewRun: vi.fn<() => Promise<void>>(),
    dismissFinding: vi.fn<(finding: unknown) => Promise<void>>(),
    exportEvidenceChainForReview: vi.fn<(review: unknown) => { json: string }>(() => ({ json: "{}" })),
    formatMeasurementFingerprintSummary: vi.fn<(_fp: unknown) => string>((_fp: unknown) => "fp-summary"),
    buildVisibleNovelReviewActionItems: vi.fn<(targetPath: string | null | undefined, results: NovelReviewResult[], ignored: Record<string, true>) => NovelReviewActionItem[]>(() => []),
    buildVisibleNovelReviewActionItemsForScoreDimensions: vi.fn<() => NovelReviewActionItem[]>(() => []),
    buildVisibleNovelReviewActionItemsForDimensionResults: vi.fn<() => NovelReviewActionItem[]>(() => []),
    findReviewRewriteAnchors: vi.fn<() => unknown[]>(() => []),
    generateReviewRewriteEdits: vi.fn<(...args: unknown[]) => Promise<ReviewRewriteEdit[]>>(),
    applyReviewRewriteEditsToMarkdown: vi.fn<(markdown: string, edits: ReviewRewriteEdit[]) => ReviewRewriteApplyResult>(),
    loadDashboardIssueState: vi.fn<() => Promise<DashboardIssueState>>(),
    saveDashboardIssueState: vi.fn<(state: DashboardIssueState) => Promise<void>>(),
    restoreDashboardRewriteInMarkdown: vi.fn<(markdown: string, backup: DashboardIssueRewriteBackup) => string | null>(),
  }
})


vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: mocks.t }),
}))

vi.mock("@/i18n", () => ({
  default: { exists: mocks.i18nExists, t: mocks.t },
}))

vi.mock("@/stores/wiki-store", () => ({
  useWikiStore: Object.assign(
    (selector: (s: unknown) => unknown) => selector(mocks.state),
    { getState: () => mocks.state },
  ),
}))

vi.mock("@/stores/review-store", () => ({
  useReviewStore: (selector: (s: unknown) => unknown) =>
    selector({
      items: mocks.reviewItems,
      resolveItem: mocks.resolveItem,
      dismissItem: mocks.dismissItem,
      clearResolved: mocks.clearResolved,
    }),
}))

vi.mock("@/commands/fs", () => ({
  readFile: mocks.readFile,
  writeFile: mocks.writeFile,
  writeFileAtomic: mocks.writeFileAtomic,
  listDirectory: mocks.listDirectory,
  deleteFile: mocks.deleteFile,
  copyFile: mocks.copyFile,
  copyDirectory: mocks.copyDirectory,
  preprocessFile: mocks.preprocessFile,
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
}))

vi.mock("@/lib/novel/model-resolver", () => ({ resolveDefaultModel: mocks.resolveDefaultModel }))
vi.mock("@/lib/has-usable-llm", () => ({ hasUsableLlm: mocks.hasUsableLlm }))
vi.mock("@/lib/novel/character-cognition", () => ({ loadCognitionState: mocks.loadCognitionState }))
vi.mock("@/lib/novel/generation-history", () => ({
  listGenerationHistory: mocks.listGenerationHistory,
  deleteGenerationHistoryEntry: mocks.deleteGenerationHistoryEntry,
}))
vi.mock("@/lib/novel/start-review-run", () => ({ startNovelReviewRun: mocks.startNovelReviewRun }))
vi.mock("@/lib/novel/start-six-dimension-review-run", () => ({ startSixDimensionReviewRun: mocks.startSixDimensionReviewRun }))
vi.mock("@/lib/novel/continuity-overrides-store", () => ({ dismissFinding: mocks.dismissFinding }))
vi.mock("@/lib/novel/evidence-chain-export", () => ({ exportEvidenceChainForReview: mocks.exportEvidenceChainForReview }))
vi.mock("@/lib/novel/measurement-fingerprint", () => ({ formatMeasurementFingerprintSummary: mocks.formatMeasurementFingerprintSummary }))
vi.mock("@/lib/novel/dimension-review-adapter", () => ({
  SIX_REVIEW_DIMENSIONS: {
    thrill: { label: "惊悚" },
    consistency: { label: "一致性" },
    pacing: { label: "节奏" },
    character: { label: "人物" },
    continuity: { label: "连续性" },
    pull: { label: "拉力" },
  },
}))
vi.mock("@/lib/novel-review-action-items", () => ({
  buildVisibleNovelReviewActionItems: mocks.buildVisibleNovelReviewActionItems,
  buildVisibleNovelReviewActionItemsForScoreDimensions: mocks.buildVisibleNovelReviewActionItemsForScoreDimensions,
  buildVisibleNovelReviewActionItemsForDimensionResults: mocks.buildVisibleNovelReviewActionItemsForDimensionResults,
}))
vi.mock("@/lib/review-rewrite-plan", () => ({
  findReviewRewriteAnchors: mocks.findReviewRewriteAnchors,
  generateReviewRewriteEdits: mocks.generateReviewRewriteEdits,
  applyReviewRewriteEditsToMarkdown: mocks.applyReviewRewriteEditsToMarkdown,
}))
vi.mock("@/lib/dashboard-issue-actions", () => ({
  createEmptyDashboardIssueState: () => ({ ignored: {}, rewrites: {} }),
  loadDashboardIssueState: mocks.loadDashboardIssueState,
  saveDashboardIssueState: mocks.saveDashboardIssueState,
  restoreDashboardRewriteInMarkdown: mocks.restoreDashboardRewriteInMarkdown,
}))

// ── UI primitives ──────────────────────────────────────────────────────
vi.mock("@/components/novel/review-job-status-strip", () => ({
  ReviewJobStatusStrip: () => <div data-testid="job-status-strip" />,
}))

vi.mock("@/components/ui/button", () => ({
  Button: (props: Record<string, unknown>) => <button type="button" data-slot="button" {...props} />,
}))

vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({ open, onOpenChange, children }: { open: boolean; onOpenChange?: (v: boolean) => void; children: ReactNode }) =>
    open ? (
      <div data-testid="dialog">
        {children}
        <button type="button" data-testid="dialog-dismiss-trigger" onClick={() => onOpenChange?.(false)}>
          close-dialog
        </button>
      </div>
    ) : null,
  DialogContent: ({ children }: { children: ReactNode }) => <div data-testid="dialog-content">{children}</div>,
  DialogDescription: ({ children }: { children: ReactNode }) => <div data-testid="dialog-description">{children}</div>,
  DialogFooter: ({ children }: { children: ReactNode }) => <div data-testid="dialog-footer">{children}</div>,
  DialogHeader: ({ children }: { children: ReactNode }) => <div data-testid="dialog-header">{children}</div>,
  DialogTitle: ({ children }: { children: ReactNode }) => <div data-testid="dialog-title">{children}</div>,
}))

vi.mock("./finding-compare-dialog", () => ({
  FindingCompareDialog: (props: {
    onAccept: () => void
    onReject: () => void
    onClose: () => void
  }) => (
    <div data-testid="finding-compare-dialog">
      <button type="button" data-testid="fcd-accept" onClick={() => props.onAccept()}>
        accept
      </button>
      <button type="button" data-testid="fcd-reject" onClick={() => props.onReject()}>
        reject
      </button>
      <button type="button" data-testid="fcd-close" onClick={() => props.onClose()}>
        close
      </button>
    </div>
  ),
}))

// ── factories ──────────────────────────────────────────────────────────
function makeReviewItem(over: Partial<ReviewItem> = {}): ReviewItem {
  return {
    id: "review-1",
    type: "contradiction",
    title: "矛盾标题",
    description: "描述文本",
    options: [
      { label: "接受", action: "accept:1" },
      { label: "创建页面", action: "create:page" },
    ],
    resolved: false,
    createdAt: 0,
    ...over,
  }
}

function makeResult(
  over: Omit<Partial<NovelReviewResult>, "severity" | "type"> & { severity?: string; type?: string } = {},
): NovelReviewResult {
  const base: NovelReviewResult = {
    severity: "error",
    type: "character_consistency",
    message: "结果消息",
    evidence: "结果证据",
    relatedMemory: "",
    suggestion: "结果建议",
  }
  // severity/type 放宽为 string：组件对空串走 `|| "quality"/"info"` 回退分支。
  return { ...base, ...over } as NovelReviewResult
}

function makeActionItem(over: Partial<NovelReviewActionItem> = {}): NovelReviewActionItem {
  return {
    id: "item-1",
    severity: "high",
    reviewSeverity: "error",
    source: "review",
    message: "行动项消息",
    detail: "character_consistency",
    evidence: "行动项证据",
    suggestion: "行动项建议",
    targetPath: "E:/Novel/chapter-8.md",
    ...over,
  }
}

function makeHistoryEntry(over: Partial<GenerationHistoryEntry> = {}): GenerationHistoryEntry {
  return {
    id: "h-1",
    kind: "review",
    title: "第8章审稿",
    chapterNumber: 8,
    sourcePath: "E:/Novel/chapter-8.md",
    results: [makeResult()],
    createdAt: "2026-07-01T10:00:00.000Z",
    filePath: "E:/Novel/.novel/history/h-1.json",
    ...over,
  }
}

function makeCognition(over: Partial<CognitionState> = {}): CognitionState {
  return {
    characters: [],
    readerKnows: [],
    lastUpdatedChapter: 0,
    ...over,
  }
}

// ── helpers ────────────────────────────────────────────────────────────
function renderView(props: Partial<React.ComponentProps<typeof ReviewView>> = {}) {
  return render(<ReviewView {...props} />)
}

function setRun(run: unknown) {
  mocks.state.reviewRun = run
}

function actionItemCard(message: string): HTMLElement {
  const el = screen.getByText(message)
  const card = el.closest("div[role=button]")
  if (!card) throw new Error(`no card for ${message}`)
  return card as HTMLElement
}

function defaultFsPaths(indexContent: string, logContent: string) {
  mocks.readFile.mockImplementation(async (path: string) => {
    if (String(path).endsWith("index.md")) return indexContent
    if (String(path).endsWith("log.md")) return logContent
    return "# Chapter\n正文"
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.state.novelMode = true
  mocks.state.project = { path: "E:/Novel" }
  mocks.state.selectedFile = null
  mocks.state.selectedReviewFilePath = null
  mocks.state.fileContent = ""
  mocks.state.dataVersion = 0
  mocks.state.reviewRun = null
  mocks.state.llmConfig = null
  mocks.state.setSelectedFile = vi.fn()
  mocks.state.setFileContent = vi.fn()
  mocks.state.setActiveView = vi.fn()
  mocks.state.setFileTree = vi.fn()
  mocks.state.setPendingEditorHighlight = vi.fn()
  mocks.state.bumpDataVersion = vi.fn()
  mocks.reviewItems = []
  mocks.i18nExists.mockReturnValue(true)
  mocks.t.mockImplementation((key: string) => key)
  mocks.hasUsableLlm.mockReturnValue(true)
  mocks.readFile.mockResolvedValue("# Chapter\n正文")
  mocks.writeFile.mockResolvedValue(undefined)
  mocks.listDirectory.mockResolvedValue([])
  mocks.deleteFile.mockResolvedValue(undefined)
  mocks.loadCognitionState.mockResolvedValue(makeCognition())
  mocks.listGenerationHistory.mockResolvedValue([])
  mocks.deleteGenerationHistoryEntry.mockResolvedValue(undefined)
  mocks.dismissFinding.mockResolvedValue(undefined)
  mocks.exportEvidenceChainForReview.mockReturnValue({ json: "{}" })
  mocks.generateReviewRewriteEdits.mockResolvedValue([])
  mocks.applyReviewRewriteEditsToMarkdown.mockReturnValue({ ok: true, markdown: "# new", applied: [] })
  mocks.loadDashboardIssueState.mockResolvedValue({ ignored: {}, rewrites: {} })
  mocks.saveDashboardIssueState.mockResolvedValue(undefined)
  mocks.restoreDashboardRewriteInMarkdown.mockReturnValue("restored-md")
  mocks.buildVisibleNovelReviewActionItems.mockReturnValue([])
  mocks.buildVisibleNovelReviewActionItemsForScoreDimensions.mockReturnValue([])
  mocks.buildVisibleNovelReviewActionItemsForDimensionResults.mockReturnValue([])
  ;(globalThis as unknown as { confirm: () => boolean }).confirm = vi.fn(() => true)
  setupDomGlobals()
})

afterEach(() => {
  vi.restoreAllMocks()
  cleanup()
})

describe("ReviewView — 空态 / 头部 / 基础渲染", () => {
  it("非 novelMode 空态: 默认标题, allClear 文案, 无 job strip / 无 novel 按钮", () => {
    mocks.state.novelMode = false
    renderView()
    expect(screen.getByText("review.title")).toBeInTheDocument()
    expect(screen.getByText("review.allClear")).toBeInTheDocument()
    expect(screen.getByText("review.allClearHint")).toBeInTheDocument()
    expect(screen.queryByTestId("job-status-strip")).not.toBeInTheDocument()
    expect(screen.queryByTestId("export-evidence-chain")).not.toBeInTheDocument()
    expect(screen.queryByText("novel.review.startReview")).not.toBeInTheDocument()
  })

  it("novelMode 空态: novel 标题, job strip, export 禁用, review 按钮禁用 (无选中文件)", () => {
    renderView()
    expect(screen.getByText("novel.review.title")).toBeInTheDocument()
    expect(screen.getByTestId("job-status-strip")).toBeInTheDocument()
    expect(screen.getByText("novel.review.allClear")).toBeInTheDocument()
    const exportBtn = screen.getByTestId("export-evidence-chain")
    expect(exportBtn).toBeDisabled()
    const reviewBtn = screen.getByText("novel.review.startReview")
    expect(reviewBtn).toBeDisabled()
  })

  it("title prop 覆盖默认标题; headerCount 徽标仅在 count>0 渲染", () => {
    renderView({ title: "自定义标题" })
    expect(screen.getByText("自定义标题")).toBeInTheDocument()
    expect(screen.queryByText("novel.review.title")).not.toBeInTheDocument()
  })

  it("resolved store 项存在时渲染 clearResolved 按钮并触发回调", () => {
    mocks.reviewItems = [makeReviewItem({ id: "r1", resolved: true, resolvedAction: "accept:1" })]
    renderView()
    const btn = screen.getByText("novel.review.clearResolved")
    fireEvent.click(btn)
    expect(mocks.clearResolved).toHaveBeenCalledTimes(1)
  })
})

describe("ReviewView — ReviewCard (review store items)", () => {
  it("五种 type 渲染 novelLabelKey + title/description, 选项触发 onResolve, X 触发 dismissItem", () => {
    mocks.reviewItems = [
      makeReviewItem({ id: "t1", type: "contradiction" }),
      makeReviewItem({ id: "t2", type: "duplicate", title: "重复" }),
      makeReviewItem({ id: "t3", type: "missing-page", title: "缺页" }),
      makeReviewItem({ id: "t4", type: "confirm", title: "确认" }),
      makeReviewItem({ id: "t5", type: "suggestion", title: "建议" }),
    ]
    renderView()
    expect(screen.getByText("novel.review.typeLabels.contradiction")).toBeInTheDocument()
    expect(screen.getByText("novel.review.typeLabels.duplicate")).toBeInTheDocument()
    expect(screen.getByText("novel.review.typeLabels.missingPage")).toBeInTheDocument()
    expect(screen.getByText("novel.review.typeLabels.confirm")).toBeInTheDocument()
    expect(screen.getByText("novel.review.typeLabels.suggestion")).toBeInTheDocument()
    // 选项按钮 → onResolve(id, action): "accept:1" 不属于 save/open/delete/create 前缀,
    // handleResolve 落入 generic 分支 (review-view.tsx:917-919), 通知文案用 genericActionLabel
    fireEvent.click(screen.getAllByText("接受")[0])
    expect(mocks.resolveItem).toHaveBeenCalledWith("t1", "review.fallbacks.genericActionLabel")
    // X dismiss → dismissItem(id)
    const dismissButtons = screen.getAllByLabelText("common.dismiss")
    fireEvent.click(dismissButtons[0])
    expect(mocks.dismissItem).toHaveBeenCalledWith("t1")
  })

  it("非 novelMode 用 labelKey; resolved 项显示 resolvedAction; affectedPages 渲染", () => {
    mocks.state.novelMode = false
    mocks.reviewItems = [
      makeReviewItem({ id: "r1", type: "suggestion", title: "建议", affectedPages: ["a.md", "b.md"], resolved: true, resolvedAction: "accept:9" }),
    ]
    renderView()
    expect(screen.getByText("review.typeLabels.suggestion")).toBeInTheDocument()
    // 实际渲染为 "review.pages: a.md, b.md" 拼接文本 (review-view.tsx:1473-1478)
    expect(screen.getByText(/review\.pages/)).toBeInTheDocument()
    expect(screen.getByText("accept:9")).toBeInTheDocument()
    // 无 options 按钮渲染
    expect(screen.queryByText("接受")).not.toBeInTheDocument()
  })

  it("pending + resolved 同时存在时渲染分隔线", () => {
    mocks.reviewItems = [
      makeReviewItem({ id: "p1" }),
      makeReviewItem({ id: "r1", resolved: true, resolvedAction: "accept:1" }),
    ]
    renderView()
    // 分隔线文本为 "— {key} —" 拼接 (review-view.tsx:1085), 用正则匹配
    expect(screen.getByText(/novel\.review\.resolvedSeparator/)).toBeInTheDocument()
  })

  it("pending 无 resolved 时不渲染分隔线", () => {
    mocks.reviewItems = [makeReviewItem({ id: "p1" })]
    renderView()
    expect(screen.queryByText("novel.review.resolvedSeparator")).not.toBeInTheDocument()
  })
})

describe("ReviewView — handleResolve (save/open/delete/create/generic)", () => {
  it("save: 写 query 页面 + index/log 更新 + setFileTree + resolveItem (novel 通知)", async () => {
    defaultFsPaths(
      "# Wiki Index\n\n## Queries\n- [[existing]]\n",
      "# Wiki Log\n- 2026-01-01: old\n",
    )
    const encoded = btoa("<!-- save-worthy: yes -->\n\n# My Query Page\ncontent line")
    mocks.reviewItems = [
      makeReviewItem({
        id: "sv1",
        title: "查询标题",
        options: [{ label: "保存", action: `save:${encoded}` }],
      }),
    ]
    renderView()
    fireEvent.click(screen.getByText("保存"))
    await waitFor(() => expect(mocks.writeFile).toHaveBeenCalled())
    const [targetPath, content] = mocks.writeFile.mock.calls.find((c) => String(c[0]).includes("/wiki/queries/")) as [string, string]
    expect(content).toContain("type: query")
    expect(content).toContain("My Query Page")
    expect(content).not.toContain("save-worthy")
    // index.md 被更新 (包含新 entry)
    const indexCall = mocks.writeFile.mock.calls.find((c) => String(c[0]).endsWith("index.md")) as [string, string]
    expect(indexCall[1]).toContain("- [[queries/")
    expect(indexCall[1]).toContain("My Query Page")
    const logCall = mocks.writeFile.mock.calls.find((c) => String(c[0]).endsWith("log.md")) as [string, string]
    expect(logCall[1]).toContain("Saved query page")
    expect(mocks.listDirectory).toHaveBeenCalledWith("E:/Novel")
    expect(mocks.state.setFileTree).toHaveBeenCalled()
    expect(mocks.resolveItem).toHaveBeenCalledWith("sv1", "novel.review.notifications.savedToChapterLibrary")
    void targetPath
  })

  it("save: index 无 ## Queries 段 → 追加段; index/log 读取失败 → 默认内容", async () => {
    // btoa 仅支持 Latin-1, 中文会抛 InvalidCharacterError; 用 ASCII 内容
    mocks.reviewItems = [makeReviewItem({ id: "sv1", options: [{ label: "保存", action: `save:${btoa("# Title")}` }] })]
    // index 读取失败 → 默认 "# Wiki Index\n" (仍追加 ## Queries); log 读取失败 → 默认 "# Wiki Log\n"
    mocks.readFile
      .mockRejectedValueOnce(new Error("no index"))
      .mockRejectedValueOnce(new Error("no log"))
    renderView()
    fireEvent.click(screen.getByText("保存"))
    await waitFor(() => expect(mocks.writeFile).toHaveBeenCalled())
    const indexCall = mocks.writeFile.mock.calls.find((c) => String(c[0]).endsWith("index.md")) as [string, string]
    expect(indexCall[1]).toContain("## Queries")
    const logCall = mocks.writeFile.mock.calls.find((c) => String(c[0]).endsWith("log.md")) as [string, string]
    expect(logCall[1]).toContain("Saved query page")
  })

  it("save: 非 novelMode → savedToWiki 通知; writeFile 失败 → saveFailed", async () => {
    mocks.state.novelMode = false
    mocks.reviewItems = [makeReviewItem({ id: "sv1", options: [{ label: "保存", action: `save:${btoa("Title Line")}` }] })]
    mocks.writeFile.mockRejectedValueOnce(new Error("disk full"))
    renderView()
    fireEvent.click(screen.getByText("保存"))
    await waitFor(() =>
      expect(mocks.resolveItem).toHaveBeenCalledWith("sv1", "review.notifications.saveFailed"),
    )
  })

  it("open: 首个候选命中 → 打开 wiki 并 resolve openedChapter; 全部 miss 仍 resolve", async () => {
    mocks.reviewItems = [makeReviewItem({ id: "op1", options: [{ label: "打开", action: "open:chapter-8" }] })]
    mocks.readFile.mockImplementation(async (path: string) => {
      if (String(path).endsWith("chapter-8.md")) return "# Chapter 8"
      throw new Error("miss")
    })
    renderView()
    fireEvent.click(screen.getByText("打开"))
    await waitFor(() => expect(mocks.resolveItem).toHaveBeenCalled())
    expect(mocks.state.setSelectedFile).toHaveBeenCalledWith("E:/Novel/wiki/chapter-8.md")
    expect(mocks.state.setFileContent).toHaveBeenCalledWith("# Chapter 8")
    expect(mocks.state.setActiveView).toHaveBeenCalledWith("wiki")
    expect(mocks.resolveItem).toHaveBeenCalledWith("op1", "novel.review.notifications.openedChapter")
  })

  it("open: 两个候选都失败 → 仍 resolve openedChapter; 非 novelMode → openedPage", async () => {
    mocks.state.novelMode = false
    mocks.reviewItems = [makeReviewItem({ id: "op1", options: [{ label: "打开", action: "open:missing" }] })]
    mocks.readFile.mockRejectedValue(new Error("miss"))
    renderView()
    fireEvent.click(screen.getByText("打开"))
    await waitFor(() =>
      expect(mocks.resolveItem).toHaveBeenCalledWith("op1", "review.notifications.openedPage"),
    )
  })

  it("delete: 删除成功 → setFileTree + resolve deleted; 失败 → deleteFailed", async () => {
    mocks.reviewItems = [makeReviewItem({ id: "d1", options: [{ label: "删除", action: "delete:E:/Novel/target.md" }] })]
    renderView()
    fireEvent.click(screen.getByText("删除"))
    await waitFor(() => expect(mocks.resolveItem).toHaveBeenCalledWith("d1", "review.notifications.deleted"))
    expect(mocks.deleteFile).toHaveBeenCalledWith("E:/Novel/target.md")
    expect(mocks.state.setFileTree).toHaveBeenCalled()
    cleanup()
    mocks.reviewItems = [makeReviewItem({ id: "d2", options: [{ label: "删除", action: "delete:E:/Novel/target.md" }] })]
    mocks.deleteFile.mockRejectedValue(new Error("locked"))
    renderView()
    fireEvent.click(screen.getByText("删除"))
    await waitFor(() => expect(mocks.resolveItem).toHaveBeenCalledWith("d2", "review.notifications.deleteFailed"))
  })

  it("create page: query 类型 (action 含 query) → queries 目录 + index ## Queries 替换", async () => {
    defaultFsPaths("# Wiki Index\n\n## Queries\n- [[old]]\n", "# Wiki Log\n")
    mocks.reviewItems = [makeReviewItem({ id: "c1", title: "问题标题", options: [{ label: "建页", action: "__create_page__:query:new" }] })]
    renderView()
    fireEvent.click(screen.getByText("建页"))
    await waitFor(() => expect(mocks.writeFile).toHaveBeenCalled())
    const created = mocks.writeFile.mock.calls.find((c) => String(c[0]).includes("/wiki/queries/")) as [string, string]
    expect(created[1]).toContain("type: query")
    const indexCall = mocks.writeFile.mock.calls.find((c) => String(c[0]).endsWith("index.md")) as [string, string]
    // slug 由标题经 [^a-z0-9\s-] 剥离生成, 中文标题 → slug 为空, 条目为 "- [[queries/-<date>|问题标题]]" (review-view.tsx:882-889)
    expect(indexCall[1]).toContain("- [[queries/")
    expect(indexCall[1]).toContain("问题标题")
    expect(mocks.state.bumpDataVersion).toHaveBeenCalled()
    expect(mocks.resolveItem).toHaveBeenCalledWith("c1", "novel.review.notifications.created")
  })

  it("create page: detectPageType 分支 (entity/人物/地点/组织/concept/设定/概念/itemType 兜底)", async () => {
    const runCreate = async (id: string, action: string, title: string, type: ReviewItem["type"]) => {
      cleanup()
      mocks.writeFile.mockClear()
      mocks.reviewItems = [makeReviewItem({ id, title, type, options: [{ label: "建页", action }] })]
      renderView()
      fireEvent.click(screen.getByText("建页"))
      await waitFor(() => expect(mocks.writeFile).toHaveBeenCalled())
      const created = mocks.writeFile.mock.calls.find((c) => String(c[0]).includes("/wiki/")) as [string, string]
      return created[1]
    }
    // 只有 __create_page__:/create:/new:/含"创建/新增" 的 action 才进入建页分支
    // (review-view.tsx:871 actionLooksLikeCreate 门控); 其余走 genericActionLabel。
    expect((await runCreate("e1", "create:entity", "人物甲", "contradiction"))).toContain("type: entity")
    expect((await runCreate("e2", "create:人物", "人物乙", "contradiction"))).toContain("type: entity")
    expect((await runCreate("e3", "create:地点", "地点丙", "contradiction"))).toContain("type: entity")
    expect((await runCreate("e4", "create:组织", "组织丁", "contradiction"))).toContain("type: entity")
    expect((await runCreate("e5", "create:concept", "概念戊", "contradiction"))).toContain("type: concept")
    expect((await runCreate("e6", "create:设定", "设定己", "contradiction"))).toContain("type: concept")
    expect((await runCreate("e7", "create:概念", "概念庚", "contradiction"))).toContain("type: concept")
    // itemType 兜底 (character/location/organization → entity) 无法经 UI 触达:
    // ReviewItem["type"] 仅 5 种 (review-store.ts:33), ReviewCard 的 typeConfig 只覆盖这 5 种
    // (review-view.tsx:86-95), 传 character/location 会直接崩溃 → 删除该分支用例。
    // 兜底 → query (detectPageType 无 keyword 命中, review-view.tsx:112)
    expect((await runCreate("e11", "create:x", "其他子", "contradiction"))).toContain("type: query")
    // actionLooksLikeCreate: 创建 / 新增 / new: / create: (review-view.tsx:98-101)
    expect((await runCreate("e12", "创建:page", "创建页", "contradiction"))).toContain("type: query")
    expect((await runCreate("e13", "新增:page", "新增页", "contradiction"))).toContain("type: query")
    expect((await runCreate("e14", "new:page", "新页", "contradiction"))).toContain("type: query")
    expect((await runCreate("e15", "create:page", "创建页标题", "contradiction"))).toContain("type: query")
    // 标题带前缀 → stripTitlePrefixes 剥离 (review-view.tsx:879-880)
    mocks.t.mockImplementation((key: string) => (key === "review.fallbacks.stripTitlePrefixes" ? "问题" : key))
    const e16 = await runCreate("e16", "create:query:x", "问题: 剥离标题", "contradiction")
    expect(e16).toContain("type: query")
    expect(e16).toContain("剥离标题")
  })

  it("create page: 标题为空 → untitled 兜底; 写入失败 → createFailed; item 缺失 → genericActionLabel", async () => {
    mocks.reviewItems = [makeReviewItem({ id: "c2", title: "   ", options: [{ label: "建页", action: "__create_page__:query:x" }] })]
    renderView()
    fireEvent.click(screen.getByText("建页"))
    await waitFor(() => expect(mocks.writeFile).toHaveBeenCalled())
    const created = mocks.writeFile.mock.calls.find((c) => String(c[0]).includes("/wiki/queries/")) as [string, string]
    expect(created[1]).toContain("review.fallbacks.untitled")
    cleanup()
    mocks.reviewItems = [makeReviewItem({ id: "c3", title: "失败页", options: [{ label: "建页", action: "__create_page__:query:x" }] })]
    mocks.writeFile.mockRejectedValue(new Error("no space"))
    renderView()
    fireEvent.click(screen.getByText("建页"))
    await waitFor(() => expect(mocks.resolveItem).toHaveBeenCalledWith("c3", "novel.review.notifications.createFailed"))
    cleanup()
    // item 不在 items 中 → genericActionLabel (handleResolve 用点击项的 id "other")
    mocks.reviewItems = [makeReviewItem({ id: "other" })]
    renderView()
    fireEvent.click(screen.getByText("接受"))
    expect(mocks.resolveItem).toHaveBeenCalledWith("other", "review.fallbacks.genericActionLabel")
  })

  it("未知 action / 无 project → genericActionLabel", () => {
    mocks.reviewItems = [makeReviewItem({ id: "g1", options: [{ label: "奇怪", action: "weird:x" }] })]
    renderView()
    fireEvent.click(screen.getByText("奇怪"))
    expect(mocks.resolveItem).toHaveBeenCalledWith("g1", "review.fallbacks.genericActionLabel")
    cleanup()
    mocks.state.project = null
    mocks.reviewItems = [
      makeReviewItem({ id: "g2", options: [{ label: "保存", action: "save:abc" }] }),
      makeReviewItem({ id: "g3", options: [{ label: "打开", action: "open:x" }] }),
      makeReviewItem({ id: "g4", options: [{ label: "删除", action: "delete:x" }] }),
      makeReviewItem({ id: "g5", options: [{ label: "建页", action: "__create_page__:query:x" }] }),
    ]
    renderView()
    for (const label of ["保存", "打开", "删除", "建页"]) {
      fireEvent.click(screen.getByText(label))
      expect(mocks.resolveItem).toHaveBeenCalledWith(
        expect.stringMatching(/^g[2-5]$/),
        "review.fallbacks.genericActionLabel",
      )
    }
  })
})

describe("ReviewView — novel review 结果 / 行动项 / action bar", () => {
  it("action item 渲染 severity/detail/evidence/suggestion; exists=false 回退原文", () => {
    setRun({
      runId: "r1",
      filePath: "E:/Novel/chapter-8.md",
      results: [makeResult({ severity: "warning", type: "pacing_issue" })],
      running: false,
      error: null,
    })
    mocks.buildVisibleNovelReviewActionItems.mockReturnValue([makeActionItem({ id: "a1", reviewSeverity: "warning", detail: "pacing_issue" })])
    renderView()
    expect(screen.getByText("novel.review.resultsTitle")).toBeInTheDocument()
    expect(screen.getByText("review.results.severity.warning")).toBeInTheDocument()
    expect(screen.getByText("review.results.dimension.pacing_issue")).toBeInTheDocument()
    expect(screen.getByText("行动项消息")).toBeInTheDocument()
    expect(screen.getByText(/行动项证据/)).toBeInTheDocument()
    expect(screen.getByText(/行动项建议/)).toBeInTheDocument()
    cleanup()
    // exists=false → 回退 item.reviewSeverity / item.detail
    mocks.i18nExists.mockReturnValue(false)
    setRun({
      runId: "r2",
      filePath: "E:/Novel/chapter-8.md",
      results: [makeResult({ severity: "info", type: "quality_soft" })],
      running: false,
      error: null,
    })
    mocks.buildVisibleNovelReviewActionItems.mockReturnValue([makeActionItem({ id: "a2", reviewSeverity: "info", detail: "quality_soft" })])
    renderView()
    expect(screen.getByText("info")).toBeInTheDocument()
    expect(screen.getByText("quality_soft")).toBeInTheDocument()
  })

  it("点击行动项卡片 → 打开 wiki (readFile + setSelectedFile/Content/ActiveView); Enter/Space 键盘等价", async () => {
    setRun({
      runId: "r1",
      filePath: "E:/Novel/chapter-8.md",
      results: [makeResult()],
      running: false,
      error: null,
    })
    mocks.buildVisibleNovelReviewActionItems.mockReturnValue([makeActionItem({ id: "a1" })])
    renderView()
    const card = actionItemCard("行动项消息")
    fireEvent.click(card)
    await waitFor(() => expect(mocks.state.setSelectedFile).toHaveBeenCalledWith("E:/Novel/chapter-8.md"))
    expect(mocks.readFile).toHaveBeenCalledWith("E:/Novel/chapter-8.md")
    expect(mocks.state.setActiveView).toHaveBeenCalledWith("wiki")
    // openNovelReviewActionItem 是异步 (await readFile), 键盘等价后需 waitFor
    fireEvent.keyDown(card, { key: "Enter" })
    await waitFor(() => expect(mocks.state.setSelectedFile).toHaveBeenCalledTimes(2))
    fireEvent.keyDown(card, { key: " " })
    await waitFor(() => expect(mocks.state.setSelectedFile).toHaveBeenCalledTimes(3))
  })

  it("openNovelReviewActionItem: readFile 失败 → console.error + 返回 null", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    setRun({
      runId: "r1",
      filePath: "E:/Novel/chapter-8.md",
      results: [makeResult()],
      running: false,
      error: null,
    })
    mocks.buildVisibleNovelReviewActionItems.mockReturnValue([makeActionItem({ id: "a1" })])
    mocks.readFile.mockRejectedValue(new Error("boom"))
    renderView()
    fireEvent.click(actionItemCard("行动项消息"))
    await waitFor(() => expect(errSpy).toHaveBeenCalled())
    expect(mocks.state.setSelectedFile).not.toHaveBeenCalled()
    errSpy.mockRestore()
  })

  it("reviewError 渲染错误横幅; running+thinking 渲染思考块", () => {
    setRun({
      runId: "r1",
      filePath: "E:/Novel/chapter-8.md",
      results: [],
      running: true,
      error: "运行失败",
      thinking: "思考过程文本",
    })
    renderView()
    expect(screen.getByText("运行失败")).toBeInTheDocument()
    expect(screen.getByText("review.stagedDeepTitle")).toBeInTheDocument()
    expect(screen.getByText("思考过程文本")).toBeInTheDocument()
  })

  it("review 按钮: 运行中 label + 禁用; export evidence 点击导出 + clipboard; 导出异常被吞", () => {
    setRun({
      runId: "r1",
      filePath: "E:/Novel/chapter-8.md",
      results: [makeResult()],
      running: true,
      error: null,
    })
    renderView()
    expect(screen.getByText("novel.review.reviewing")).toBeInTheDocument()
    const reviewBtn = screen.getByText("novel.review.reviewing")
    expect(reviewBtn).toBeDisabled()
    const exportBtn = screen.getByTestId("export-evidence-chain")
    expect(exportBtn).not.toBeDisabled()
    fireEvent.click(exportBtn)
    expect(mocks.exportEvidenceChainForReview).toHaveBeenCalledWith(
      expect.objectContaining({ pretty: true, findings: expect.any(Array) }),
    )
    cleanup()
    // 导出抛异常 → 软吞 (无崩溃)
    mocks.exportEvidenceChainForReview.mockImplementationOnce(() => {
      throw new Error("export boom")
    })
    setRun({
      runId: "r1",
      filePath: "E:/Novel/chapter-8.md",
      results: [makeResult()],
      running: false,
      error: null,
    })
    renderView()
    expect(() => fireEvent.click(screen.getByTestId("export-evidence-chain"))).not.toThrow()
  })

  it("连续 finding: dismiss 按钮展开面板 → 修改 reason/note → confirm 调 dismissFinding (error→critical)", async () => {
    const user = userEvent.setup()
    setRun({
      runId: "r1",
      filePath: "E:/Novel/chapter-8.md",
      results: [makeResult({
        type: "consistency_mechanical",
        continuityMeta: { subtype: "consistency_mechanical", ref: "character:死者", chapter: 8 },
      })],
      running: false,
      error: null,
    })
    mocks.buildVisibleNovelReviewActionItems.mockReturnValue([
      makeActionItem({
        id: "a1",
        reviewSeverity: "error",
        continuityMeta: { subtype: "consistency_mechanical", ref: "character:死者", chapter: 8 },
      }),
    ])
    renderView()
    const card = actionItemCard("行动项消息")
    const dismissBtn = within(card).getByText("review.results.dismiss.dismissButton")
    fireEvent.click(dismissBtn)
    // 面板展开 (region) + select/textarea
    expect(within(card).getByRole("region")).toBeInTheDocument()
    await user.selectOptions(within(card).getByRole("combobox"), "intentional_death")
    await user.type(within(card).getByRole("textbox"), "理由备注")
    fireEvent.click(within(card).getByText("review.results.dismiss.confirmButton"))
    await waitFor(() =>
      expect(mocks.dismissFinding).toHaveBeenCalledWith(
        "E:/Novel",
        { ref: "character:死者", reasonCode: "intentional_death", note: "理由备注", severity: "critical" },
        8,
      ),
    )
    // 反馈走 alertMessage
    expect(screen.getByRole("alert")).toHaveTextContent("character:死者")
    // 面板已关闭
    expect(within(card).queryByRole("region")).not.toBeInTheDocument()
  })

  it("dismiss: warning 项 → severity warning; dismissFinding 失败 → 错误 alert; cancel 关闭面板", async () => {
    const user = userEvent.setup()
    setRun({
      runId: "r1",
      filePath: "E:/Novel/chapter-8.md",
      results: [makeResult({ severity: "warning", type: "consistency_mechanical", continuityMeta: { subtype: "consistency_mechanical", ref: "x:1", chapter: 3 } })],
      running: false,
      error: null,
    })
    mocks.buildVisibleNovelReviewActionItems.mockReturnValue([
      makeActionItem({ id: "a1", reviewSeverity: "warning", continuityMeta: { subtype: "consistency_mechanical", ref: "x:1", chapter: 3 } }),
    ])
    mocks.dismissFinding.mockRejectedValue(new Error("写盘失败"))
    renderView()
    fireEvent.click(screen.getByText("review.results.dismiss.dismissButton"))
    fireEvent.click(screen.getByText("review.results.dismiss.confirmButton"))
    await waitFor(() =>
      expect(mocks.dismissFinding).toHaveBeenCalledWith("E:/Novel", expect.objectContaining({ severity: "warning" }), 3),
    )
    expect(screen.getByRole("alert")).toHaveTextContent("写盘失败")
    cleanup()
    // cancel 分支
    mocks.dismissFinding.mockResolvedValue(undefined)
    renderView()
    fireEvent.click(screen.getByText("review.results.dismiss.dismissButton"))
    const cancelBtn = screen.getByText("review.results.dismiss.cancelButton")
    expect(cancelBtn).toBeInTheDocument()
    // cancel 分支: 不新增 dismissFinding 调用 (第一部分已调用 1 次)
    fireEvent.click(cancelBtn)
    expect(screen.queryByRole("region")).not.toBeInTheDocument()
    expect(mocks.dismissFinding).toHaveBeenCalledTimes(1)
    void user
  })

  it("dismiss: 无 project → alert 'no project'; data_gap subtype 不渲染 dismiss 按钮", () => {
    mocks.state.project = null
    setRun({
      runId: "r1",
      filePath: "E:/Novel/chapter-8.md",
      results: [makeResult({ type: "consistency_mechanical", continuityMeta: { subtype: "consistency_mechanical", ref: "r:1", chapter: 1 } })],
      running: false,
      error: null,
    })
    mocks.buildVisibleNovelReviewActionItems.mockReturnValue([
      makeActionItem({ id: "a1", continuityMeta: { subtype: "consistency_mechanical", ref: "r:1", chapter: 1 } }),
    ])
    renderView()
    fireEvent.click(screen.getByText("review.results.dismiss.dismissButton"))
    fireEvent.click(screen.getByText("review.results.dismiss.confirmButton"))
    expect(screen.getByRole("alert")).toHaveTextContent("no project")
    cleanup()
    mocks.state.project = { path: "E:/Novel" }
    setRun({
      runId: "r2",
      filePath: "E:/Novel/chapter-8.md",
      results: [makeResult({ severity: "info", type: "consistency_mechanical", continuityMeta: { subtype: "data_gap", ref: "g:1", chapter: 2, missingField: "lastSeenChapter" } })],
      running: false,
      error: null,
    })
    mocks.buildVisibleNovelReviewActionItems.mockReturnValue([
      makeActionItem({ id: "a2", reviewSeverity: "info", continuityMeta: { subtype: "data_gap", ref: "g:1", chapter: 2 } }),
    ])
    renderView()
    expect(screen.queryByText("review.results.dismiss.dismissButton")).not.toBeInTheDocument()
  })

  it("ignore: 首次写 ignored, 二次点击 no-op; alert 关闭按钮清除 alertMessage", async () => {
    setRun({
      runId: "r1",
      filePath: "E:/Novel/chapter-8.md",
      results: [makeResult()],
      running: false,
      error: null,
    })
    mocks.buildVisibleNovelReviewActionItems.mockReturnValue([makeActionItem({ id: "a1" })])
    renderView()
    // 等 loadDashboardIssueState 异步回写落地, 否则其 setIssueState 会覆盖首次 ignore 的持久化
    // (review-view.tsx:217-234 effect; handleIgnoreNovelReviewItem 依赖 issueState 闭包)
    await waitFor(() => expect(mocks.loadDashboardIssueState).toHaveBeenCalled())
    await act(async () => {})
    const card = actionItemCard("行动项消息")
    fireEvent.click(within(card).getByText("dashboard.actions.ignore"))
    await waitFor(() => expect(mocks.saveDashboardIssueState).toHaveBeenCalled())
    expect(mocks.saveDashboardIssueState).toHaveBeenCalledWith("E:/Novel", expect.objectContaining({ ignored: { "a1": true } }))
    // 二次点击 (issueState 已含 ignored) → no-op
    const ignoreBtn = screen.getAllByText("dashboard.actions.ignore")[0]
    fireEvent.click(ignoreBtn)
    expect(mocks.saveDashboardIssueState).toHaveBeenCalledTimes(1)
    // alertMessage 路径 (走 runAiRewrite alert) + 关闭
    mocks.hasUsableLlm.mockReturnValue(false)
    fireEvent.click(screen.getByText("dashboard.actions.aiRewrite"))
    expect(screen.getByRole("alert")).toBeInTheDocument()
    fireEvent.click(screen.getByText("common.dismiss"))
    expect(screen.queryByRole("alert")).not.toBeInTheDocument()
  })

  it("AI 改写: alertNoProject / alertNoModel / alertNoChapter 三个前置守卫", async () => {
    setRun({
      runId: "r1",
      filePath: "E:/Novel/chapter-8.md",
      results: [makeResult()],
      running: false,
      error: null,
    })
    mocks.buildVisibleNovelReviewActionItems.mockReturnValue([makeActionItem({ id: "a1" })])
    // no project
    mocks.state.project = null
    renderView()
    fireEvent.click(screen.getByText("dashboard.actions.aiRewrite"))
    expect(screen.getByRole("alert")).toHaveTextContent("review.rewrite.alertNoProject")
    cleanup()
    // no model
    mocks.state.project = { path: "E:/Novel" }
    mocks.hasUsableLlm.mockReturnValue(false)
    renderView()
    fireEvent.click(screen.getByText("dashboard.actions.aiRewrite"))
    expect(screen.getByRole("alert")).toHaveTextContent("review.rewrite.alertNoModel")
    cleanup()
    // no chapter (readFile → ""): 该守卫在 await readFile 之后 (review-view.tsx:341-343), 需 waitFor
    mocks.hasUsableLlm.mockReturnValue(true)
    mocks.readFile.mockResolvedValue("")
    renderView()
    fireEvent.click(screen.getByText("dashboard.actions.aiRewrite"))
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("review.rewrite.alertNoChapter"))
  })

  it("AI 改写: 生成 0 edits → errorNoEdits; 生成 edits → 对话框行渲染", async () => {
    const user = userEvent.setup()
    setRun({
      runId: "r1",
      filePath: "E:/Novel/chapter-8.md",
      results: [makeResult()],
      running: false,
      error: null,
    })
    mocks.buildVisibleNovelReviewActionItems.mockReturnValue([makeActionItem({ id: "a1" })])
    mocks.generateReviewRewriteEdits.mockResolvedValue([])
    renderView()
    fireEvent.click(screen.getByText("dashboard.actions.aiRewrite"))
    await waitFor(() => expect(screen.getByText("review.rewrite.errorNoEdits")).toBeInTheDocument())
    cleanup()
    mocks.generateReviewRewriteEdits.mockResolvedValue([
      { id: "edit-1", originalText: "原文1", replacementText: "替换1", note: "备注1" },
      { id: "edit-2", originalText: "原文2", replacementText: "替换2", note: "" },
    ])
    renderView()
    fireEvent.click(screen.getByText("dashboard.actions.aiRewrite"))
    await waitFor(() => expect(screen.getByText("原文1")).toBeInTheDocument())
    expect(screen.getByText("原文2")).toBeInTheDocument()
    expect(screen.getByText("备注1")).toBeInTheDocument()
    // edits 已生成 → waiting 不渲染; 用 queryByText 断言 (getByText 在缺失时直接抛错)
    expect(screen.queryByText("review.rewrite.waiting")).not.toBeInTheDocument()
    // 编辑 replacement → onReplacementChange
    const textareas = screen.getAllByRole("textbox")
    await user.clear(textareas[0])
    await user.type(textareas[0], "新替换1")
    await waitFor(() => expect(screen.getByDisplayValue("新替换1")).toBeInTheDocument())
    void user
  })

  it("AI 改写: 生成异常 → 脱敏错误 (URL→[url], key→[redacted]); busy 状态按钮文案", async () => {
    setRun({
      runId: "r1",
      filePath: "E:/Novel/chapter-8.md",
      results: [makeResult()],
      running: false,
      error: null,
    })
    mocks.buildVisibleNovelReviewActionItems.mockReturnValue([makeActionItem({ id: "a1" })])
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    const d = deferred<never>()
    mocks.generateReviewRewriteEdits.mockReturnValue(d.promise)
    renderView()
    fireEvent.click(screen.getByText("dashboard.actions.aiRewrite"))
    // busy: aiRewrite 按钮显示 rewriting + disabled
    await waitFor(() => expect(screen.getByText("dashboard.actions.rewriting")).toBeInTheDocument())
    const rewriteBtn = screen.getByText("dashboard.actions.rewriting")
    expect(rewriteBtn).toBeDisabled()
    expect(screen.getByText("review.rewrite.generating")).toBeInTheDocument()
    await act(async () => {
      d.reject(new Error("https://api.example.com/v1 failed Authorization: Bearer abc123"))
    })
    await waitFor(() => expect(screen.getByText(/\[url\]/)).toBeInTheDocument())
    expect(screen.getByText(/\[redacted\]/)).toBeInTheDocument()
    expect(errSpy).toHaveBeenCalled()
    errSpy.mockRestore()
  })

  it("改写对话框: ignore 单条 / ignoreAll / editAll / regenerateAll / apply / cancel / rowBusy", async () => {
    const user = userEvent.setup()
    setRun({
      runId: "r1",
      filePath: "E:/Novel/chapter-8.md",
      results: [makeResult()],
      running: false,
      error: null,
    })
    mocks.buildVisibleNovelReviewActionItems.mockReturnValue([makeActionItem({ id: "a1" })])
    mocks.generateReviewRewriteEdits.mockResolvedValue([
      { id: "edit-3", originalText: "原文1", replacementText: "替换1", note: "" },
    ])
    renderView()
    fireEvent.click(screen.getByText("dashboard.actions.aiRewrite"))
    await waitFor(() => expect(screen.getByText("原文1")).toBeInTheDocument())
    // regenerateAll
    fireEvent.click(screen.getByText("review.rewrite.regenerateAll"))
    await waitFor(() => expect(mocks.generateReviewRewriteEdits).toHaveBeenCalledTimes(2))
    // ignoreAll → 所有行 ignored → apply 禁用
    fireEvent.click(screen.getByText("review.rewrite.ignoreAll"))
    await waitFor(() => expect(screen.getByText("review.rewrite.restore")).toBeInTheDocument())
    const applyBtn = screen.getByText("review.rewrite.apply")
    expect(applyBtn).toBeDisabled()
    // editAll → 全部恢复 pending + editing
    fireEvent.click(screen.getByText("review.rewrite.editAll"))
    await waitFor(() => expect(screen.getByText("review.rewrite.ignore")).toBeInTheDocument())
    expect(applyBtn).not.toBeDisabled()
    // 单条 ignore 切换 (ignore → restore)
    fireEvent.click(screen.getByText("review.rewrite.ignore"))
    await waitFor(() => expect(screen.getByText("review.rewrite.restore")).toBeInTheDocument())
    // regenerateOne (rowBusy 分支): busyId === edit.id
    const d = deferred<never>()
    mocks.generateReviewRewriteEdits.mockReturnValueOnce(d.promise)
    fireEvent.click(screen.getByText("review.rewrite.regenerate"))
    await waitFor(() => expect(screen.getByText("review.rewrite.generatingShort")).toBeInTheDocument())
    await act(async () => {
      d.reject(new Error("single fail"))
    })
    await waitFor(() => expect(screen.getByText(/\[url\]|single fail/)).toBeInTheDocument())
    // apply (替换后) → handleApplyRewrite 成功路径
    mocks.generateReviewRewriteEdits.mockResolvedValue([
      { id: "edit-4", originalText: "原文1", replacementText: "替换1", note: "" },
    ])
    fireEvent.click(screen.getByText("review.rewrite.regenerateAll"))
    await waitFor(() => expect(screen.getByText("原文1")).toBeInTheDocument())
    fireEvent.click(applyBtn)
    await waitFor(() => expect(mocks.writeFile).toHaveBeenCalled())
    expect(mocks.state.bumpDataVersion).toHaveBeenCalled()
    // 对话框关闭
    await waitFor(() => expect(screen.queryByTestId("dialog")).not.toBeInTheDocument())
    void user
  })

  it("handleApplyRewrite: 无活动 edits → errorNoActiveEdits; applyResult !ok → errorAnchorFailed", async () => {
    setRun({
      runId: "r1",
      filePath: "E:/Novel/chapter-8.md",
      results: [makeResult()],
      running: false,
      error: null,
    })
    mocks.buildVisibleNovelReviewActionItems.mockReturnValue([makeActionItem({ id: "a1" })])
    // 生成一个空白 replacement 的 edit → 无活动 edits
    mocks.generateReviewRewriteEdits.mockResolvedValue([{ id: "edit-5", originalText: "原文1", replacementText: "   ", note: "" }])
    renderView()
    fireEvent.click(screen.getByText("dashboard.actions.aiRewrite"))
    await waitFor(() => expect(screen.getByText("原文1")).toBeInTheDocument())
    const applyBtn = screen.getByText("review.rewrite.apply")
    // 空白替换 → hasPendingContent false → apply 禁用 (ReviewRewritePreviewDialog 的
    // disabled={busy || !hasPendingContent || activeCount === 0}); 禁用按钮的点击被
    // React 吞掉, handleApplyRewrite 的 errorNoActiveEdits 守卫分支 UI 不可达 → 断言禁用态。
    expect(applyBtn).toBeDisabled()
    cleanup()
    // applyResult !ok
    mocks.generateReviewRewriteEdits.mockResolvedValue([{ id: "edit-6", originalText: "原文1", replacementText: "替换1", note: "" }])
    mocks.applyReviewRewriteEditsToMarkdown.mockReturnValue({ ok: false, markdown: "", applied: [], failed: [{ id: "f1", originalText: "x", replacementText: "y" }, { id: "f2", originalText: "a", replacementText: "b" }] })
    renderView()
    fireEvent.click(screen.getByText("dashboard.actions.aiRewrite"))
    await waitFor(() => expect(screen.getByText("原文1")).toBeInTheDocument())
    fireEvent.click(screen.getByText("review.rewrite.apply"))
    await waitFor(() => expect(screen.getByText(/review.rewrite.errorAnchorFailed/)).toBeInTheDocument())
  })

  it("handleApplyRewrite: readFile 失败静默返回; selectedFile 匹配 → 回填 content + highlight", async () => {
    setRun({
      runId: "r1",
      filePath: "E:/Novel/chapter-8.md",
      results: [makeResult()],
      running: false,
      error: null,
    })
    mocks.buildVisibleNovelReviewActionItems.mockReturnValue([makeActionItem({ id: "a1" })])
    mocks.generateReviewRewriteEdits.mockResolvedValue([{ id: "edit-7", originalText: "原文1", replacementText: "替换1", note: "" }])
    mocks.state.selectedFile = "E:/Novel/chapter-8.md"
    renderView()
    fireEvent.click(screen.getByText("dashboard.actions.aiRewrite"))
    await waitFor(() => expect(screen.getByText("原文1")).toBeInTheDocument())
    // readFile 在改写对话框 apply 时读取最新 markdown — 失败 → 静默 return
    // (对话框打开时的 readFile 已消耗默认 mock; 这里只需给第一次 apply 注册 reject Once)
    mocks.readFile.mockRejectedValueOnce(new Error("gone")) // 第一次 apply: 读取失败
    fireEvent.click(screen.getByText("review.rewrite.apply"))
    await waitFor(() => expect(mocks.writeFile).not.toHaveBeenCalled())
    // 成功路径 + selectedFile === targetPath
    mocks.readFile.mockResolvedValueOnce("# latest\n正文")
    fireEvent.click(screen.getByText("review.rewrite.apply"))
    await waitFor(() => expect(mocks.writeFile).toHaveBeenCalled())
    expect(mocks.state.setFileContent).toHaveBeenCalled()
    expect(mocks.state.setPendingEditorHighlight).toHaveBeenCalledWith(
      expect.objectContaining({ path: "E:/Novel/chapter-8.md", text: "替换1" }),
    )
  })

  it("viewRewrite / restore 按钮 (hasBackup): 打开并恢复改写", async () => {
    setRun({
      runId: "r1",
      filePath: "E:/Novel/chapter-8.md",
      results: [makeResult()],
      running: false,
      error: null,
    })
    mocks.buildVisibleNovelReviewActionItems.mockReturnValue([makeActionItem({ id: "a1" })])
    mocks.loadDashboardIssueState.mockResolvedValue({
      ignored: {},
      rewrites: {
        "a1": { itemId: "a1", targetPath: "E:/Novel/chapter-8.md", evidence: "ev", originalText: "旧文", replacementText: "新文", updatedAt: "t" },
      },
    })
    renderView()
    // loadDashboardIssueState 异步落地后 hasBackup 才为 true (review-view.tsx:576-598), 需 waitFor
    await waitFor(() => expect(screen.getByText("dashboard.actions.viewRewrite")).toBeInTheDocument())
    // viewRewrite
    fireEvent.click(screen.getByText("dashboard.actions.viewRewrite"))
    await waitFor(() => expect(mocks.state.setSelectedFile).toHaveBeenCalledWith("E:/Novel/chapter-8.md"))
    expect(mocks.state.setFileContent).toHaveBeenCalled()
    expect(mocks.state.setActiveView).toHaveBeenCalledWith("wiki")
    expect(mocks.state.setPendingEditorHighlight).toHaveBeenCalledWith(expect.objectContaining({ text: "新文" }))
    // viewRewrite: readFile 失败 → 静默
    mocks.readFile.mockRejectedValueOnce(new Error("gone"))
    fireEvent.click(screen.getByText("dashboard.actions.viewRewrite"))
    await waitFor(() => expect(mocks.state.setActiveView).toHaveBeenCalledTimes(1))
    // restore
    fireEvent.click(screen.getByText("dashboard.actions.restore"))
    await waitFor(() => expect(mocks.writeFile).toHaveBeenCalled())
    expect(mocks.writeFile).toHaveBeenCalledWith("E:/Novel/chapter-8.md", "restored-md")
    expect(mocks.saveDashboardIssueState).toHaveBeenCalledWith(
      "E:/Novel",
      expect.objectContaining({ rewrites: {} }),
    )
    // restore: restoreDashboardRewriteInMarkdown 返回 null → 保持 latestMarkdown 写入
    // (restore 成功后 rewrites 被清空, 按钮消失 → 重新 render 重新加载 backup)
    cleanup()
    mocks.restoreDashboardRewriteInMarkdown.mockReturnValueOnce(null)
    renderView()
    await waitFor(() => expect(screen.getByText("dashboard.actions.restore")).toBeInTheDocument())
    fireEvent.click(screen.getByText("dashboard.actions.restore"))
    await waitFor(() => expect(mocks.writeFile).toHaveBeenCalledTimes(2))
    expect(mocks.writeFile.mock.calls[1]).toEqual(["E:/Novel/chapter-8.md", "# Chapter\n正文"])
  })

  it("对比改写: FindingCompareDialog 打开, accept/reject/close 关闭", () => {
    setRun({
      runId: "r1",
      filePath: "E:/Novel/chapter-8.md",
      results: [makeResult()],
      running: false,
      error: null,
    })
    mocks.buildVisibleNovelReviewActionItems.mockReturnValue([makeActionItem({ id: "a1" })])
    renderView()
    expect(screen.queryByTestId("finding-compare-dialog")).not.toBeInTheDocument()
    fireEvent.click(screen.getByText("对比改写"))
    expect(screen.getByTestId("finding-compare-dialog")).toBeInTheDocument()
    fireEvent.click(screen.getByTestId("fcd-accept"))
    expect(screen.queryByTestId("finding-compare-dialog")).not.toBeInTheDocument()
    fireEvent.click(screen.getByText("对比改写"))
    fireEvent.click(screen.getByTestId("fcd-reject"))
    expect(screen.queryByTestId("finding-compare-dialog")).not.toBeInTheDocument()
    fireEvent.click(screen.getByText("对比改写"))
    fireEvent.click(screen.getByTestId("fcd-close"))
    expect(screen.queryByTestId("finding-compare-dialog")).not.toBeInTheDocument()
  })

  it("continuity subtype 标签: exists=true 渲染 i18n key, exists=false 不渲染", () => {
    setRun({
      runId: "r1",
      filePath: "E:/Novel/chapter-8.md",
      results: [makeResult({ type: "consistency_mechanical", continuityMeta: { subtype: "consistency_mechanical", ref: "r:1", chapter: 1 } })],
      running: false,
      error: null,
    })
    mocks.buildVisibleNovelReviewActionItems.mockReturnValue([
      makeActionItem({ id: "a1", continuityMeta: { subtype: "consistency_mechanical", ref: "r:1", chapter: 1 } }),
    ])
    renderView()
    expect(screen.getByText("review.results.subtype.consistency_mechanical")).toBeInTheDocument()
    cleanup()
    mocks.i18nExists.mockReturnValue(false)
    renderView()
    expect(screen.queryByText("review.results.subtype.consistency_mechanical")).not.toBeInTheDocument()
  })
})

describe("ReviewView — 维度模式 (dimensionKey / resultScoreDimensionKeys)", () => {
  it("dimensionKey=thrill: 评分箱 (trackB 徽标 + notProductGate + fingerprint + summary), rereview 按钮", () => {
    setRun({
      runId: "d1",
      filePath: "E:/Novel/chapter-8.md",
      results: [],
      running: false,
      error: null,
      dimensionResults: {
        thrill: { dimensionKey: "thrill", score: 8.5, status: "pass", summary: "惊喜度总结", issues: [] },
      },
      measurementFingerprint: { pack: "x" },
    })
    mocks.buildVisibleNovelReviewActionItemsForDimensionResults.mockReturnValue([makeActionItem({ id: "a1" })])
    renderView({ dimensionKey: "thrill" })
    expect(screen.getByText(/惊悚评分：8.5/)).toBeInTheDocument()
    expect(screen.getByText("pass")).toBeInTheDocument()
    expect(screen.getByText("reviewCenter.trackBDimBadge")).toBeInTheDocument()
    expect(screen.getByText("reviewCenter.notProductGate")).toBeInTheDocument()
    expect(screen.getByTestId("measurement-fingerprint-summary")).toHaveTextContent("fp-summary")
    expect(screen.getByText("reviewCenter.perDimOnly")).toBeInTheDocument()
    expect(screen.getByText("惊喜度总结")).toBeInTheDocument()
    expect(screen.getByText("review.rereviewDimension")).toBeInTheDocument()
    // headerCount = actionItems.length → 徽标
    expect(screen.getByText("1")).toBeInTheDocument()
  })

  it("dimensionKey=consistency: trackA 徽标 (无 notProductGate); 无 dimensionResults → 无评分箱", () => {
    setRun({
      runId: "d1",
      filePath: "E:/Novel/chapter-8.md",
      results: [],
      running: false,
      error: null,
      dimensionResults: {
        consistency: { dimensionKey: "consistency", score: 9.2, status: "pass", summary: "", issues: [] },
      },
    })
    renderView({ dimensionKey: "consistency" })
    expect(screen.getByText("reviewCenter.trackADimBadge")).toBeInTheDocument()
    expect(screen.queryByText("reviewCenter.notProductGate")).not.toBeInTheDocument()
    cleanup()
    renderView({ dimensionKey: "pacing" })
    // 无 selectedDimensionResult → 无评分箱
    expect(screen.queryByText(/评分：/)).not.toBeInTheDocument()
  })

  it("dimensionKey 运行中: dimensionProgress 优先; 无 progress → reviewingDimension; thinking 渲染", () => {
    setRun({
      runId: "d1",
      filePath: "E:/Novel/chapter-8.md",
      results: [],
      running: true,
      error: null,
      dimensionResults: { thrill: { dimensionKey: "thrill", score: 0, status: "low", issues: [] } },
      dimensionProgress: "正在分析第 5/8 章…",
      dimensionThinking: { thrill: "维度思考" },
    })
    renderView({ dimensionKey: "thrill" })
    expect(screen.getByText("正在分析第 5/8 章…")).toBeInTheDocument()
    expect(screen.getByText("review.sixDimensionTitle")).toBeInTheDocument()
    expect(screen.getByText("维度思考")).toBeInTheDocument()
    cleanup()
    setRun({
      runId: "d1",
      filePath: "E:/Novel/chapter-8.md",
      results: [],
      running: true,
      error: null,
      dimensionResults: { thrill: { dimensionKey: "thrill", score: 0, status: "low", issues: [] } },
    })
    renderView({ dimensionKey: "thrill" })
    expect(screen.getByText("review.reviewingDimension")).toBeInTheDocument()
  })

  it("dimensionKey: 点击 review 按钮 → startSixDimensionReviewRun; 无文件 → 守卫 return", async () => {
    setRun({
      runId: "d1",
      filePath: "E:/Novel/chapter-8.md",
      results: [],
      running: false,
      error: null,
    })
    mocks.state.fileContent = "# 正文"
    mocks.state.selectedFile = "E:/Novel/chapter-8.md"
    renderView({ dimensionKey: "thrill" })
    fireEvent.click(screen.getByText("review.rereviewDimension"))
    await waitFor(() =>
      expect(mocks.startSixDimensionReviewRun).toHaveBeenCalledWith(
        expect.objectContaining({ dimensionKey: "thrill", projectPath: "E:/Novel", selectedFile: "E:/Novel/chapter-8.md" }),
      ),
    )
    cleanup()
    // 无选中文件 → 守卫: 按钮 disabled (review-view.tsx:988), React 吞掉禁用按钮点击,
    // 不新增调用 (第一部分已调用 1 次)
    mocks.state.selectedFile = null
    mocks.state.selectedReviewFilePath = null
    renderView({ dimensionKey: "thrill" })
    fireEvent.click(screen.getByText("review.rereviewDimension"))
    expect(mocks.startSixDimensionReviewRun).toHaveBeenCalledTimes(1)
  })

  it("resultScoreDimensionKeys (dimensionScoped): ForScoreDimensions 被调用, 无 resultsTitle", () => {
    setRun({
      runId: "d1",
      filePath: "E:/Novel/chapter-8.md",
      results: [makeResult()],
      running: false,
      error: null,
    })
    mocks.buildVisibleNovelReviewActionItemsForScoreDimensions.mockReturnValue([makeActionItem({ id: "a1" })])
    renderView({ resultScoreDimensionKeys: ["consistency"] })
    expect(mocks.buildVisibleNovelReviewActionItemsForScoreDimensions).toHaveBeenCalledWith(
      "E:/Novel/chapter-8.md",
      expect.any(Array),
      expect.any(Object),
      ["consistency"],
    )
    expect(screen.queryByText("novel.review.resultsTitle")).not.toBeInTheDocument()
  })

  it("非维度模式: handleNovelReview → startNovelReviewRun (fileContent 直用 / readFile 分支)", async () => {
    setRun({
      runId: "r1",
      filePath: "E:/Novel/chapter-8.md",
      results: [],
      running: false,
      error: null,
    })
    mocks.state.fileContent = "# 正文内容"
    mocks.state.selectedFile = "E:/Novel/chapter-8.md"
    renderView()
    fireEvent.click(screen.getByText("novel.review.startReview"))
    await waitFor(() =>
      expect(mocks.startNovelReviewRun).toHaveBeenCalledWith(
        expect.objectContaining({
          fileContent: "# 正文内容",
          projectPath: "E:/Novel",
          selectedFile: "E:/Novel/chapter-8.md",
        }),
      ),
    )
    cleanup()
    // selectedReviewFilePath 优先, 且 ≠ selectedFile → readFile 分支
    setRun({
      runId: "r2",
      filePath: "E:/Novel/chapter-9.md",
      results: [],
      running: false,
      error: null,
    })
    mocks.state.fileContent = "# 正文9"
    mocks.state.selectedFile = "E:/Novel/chapter-8.md"
    mocks.state.selectedReviewFilePath = "E:/Novel/chapter-9.md"
    mocks.readFile.mockResolvedValue("# 来自文件")
    renderView()
    fireEvent.click(screen.getByText("novel.review.startReview"))
    await waitFor(() =>
      expect(mocks.startNovelReviewRun).toHaveBeenCalledWith(expect.objectContaining({ fileContent: "# 来自文件" })),
    )
    cleanup()
    // fileContent 空 → 守卫 return (前两部分已调用 2 次)
    mocks.state.fileContent = ""
    mocks.state.selectedFile = "E:/Novel/chapter-8.md"
    renderView()
    fireEvent.click(screen.getByText("novel.review.startReview"))
    expect(mocks.startNovelReviewRun).toHaveBeenCalledTimes(2)
  })
})

describe("ReviewView — 审稿历史", () => {
  it("历史条目展开/折叠, error/warning 计数, 结果行渲染, 删除(confirm) → 重载", async () => {
    mocks.listGenerationHistory.mockResolvedValue([
      makeHistoryEntry({
        id: "h1",
        results: [
          makeResult({ severity: "error", type: "contradiction", message: "历史错误" }),
          makeResult({ severity: "warning", type: "pacing_issue", message: "历史警告", suggestion: "历史建议" }),
        ],
      }),
    ])
    renderView()
    // 历史异步加载 (loadReviewHistory → listGenerationHistory), 需 waitFor
    await waitFor(() => expect(screen.getByText("novel.review.historyTitle")).toBeInTheDocument())
    expect(screen.getByText("第8章审稿")).toBeInTheDocument()
    // 展开
    fireEvent.click(screen.getByText("第8章审稿"))
    expect(screen.getByText("历史错误")).toBeInTheDocument()
    expect(screen.getByText("历史警告")).toBeInTheDocument()
    expect(screen.getByText("历史建议")).toBeInTheDocument()
    // 删除 (confirm=true) → deleteGenerationHistoryEntry + 重载
    fireEvent.click(screen.getByLabelText("novel.history.delete"))
    await waitFor(() => expect(mocks.deleteGenerationHistoryEntry).toHaveBeenCalledWith("E:/Novel", "E:/Novel/.novel/history/h-1.json"))
    expect(mocks.listGenerationHistory).toHaveBeenCalledTimes(2)
  })

  it("删除 confirm=false → 不删除; 空结果 → emptyResult", async () => {
    mocks.listGenerationHistory.mockResolvedValue([makeHistoryEntry({ id: "h2", results: [] })])
    ;(globalThis as unknown as { confirm: () => boolean }).confirm = vi.fn(() => false)
    renderView()
    // 历史异步加载, 需 waitFor
    await waitFor(() => expect(screen.getByText("第8章审稿")).toBeInTheDocument())
    fireEvent.click(screen.getByText("第8章审稿"))
    expect(screen.getByText("novel.history.emptyResult")).toBeInTheDocument()
    fireEvent.click(screen.getByLabelText("novel.history.delete"))
    await waitFor(() => expect(mocks.deleteGenerationHistoryEntry).not.toHaveBeenCalled())
  })

  it("无 project → 历史为空; 非 novelMode → 历史清空且不渲染", async () => {
    mocks.state.project = null
    renderView()
    expect(screen.queryByText("novel.review.historyTitle")).not.toBeInTheDocument()
    cleanup()
    mocks.state.novelMode = false
    mocks.listGenerationHistory.mockResolvedValue([makeHistoryEntry()])
    renderView()
    expect(screen.queryByText("novel.review.historyTitle")).not.toBeInTheDocument()
  })
})

describe("ReviewView — 角色认知面板", () => {
  it("认知数据: 角色 knows/doesNotKnow + readerKnows + lastUpdated 渲染, 折叠/展开", async () => {
    mocks.loadCognitionState.mockResolvedValue(
      makeCognition({
        characters: [
          { character: "林烬", knows: ["真相A"], doesNotKnow: ["真相B"] },
          { character: "苏晚", knows: [], doesNotKnow: [] },
        ],
        readerKnows: ["读者知道X"],
        lastUpdatedChapter: 5,
      }),
    )
    // 认知面板渲染在非空态分支内 (review-view.tsx:1222 showCognition 在 else 分支), 需要一个 pending 项
    mocks.reviewItems = [makeReviewItem({ id: "p1" })]
    renderView()
    // loadCognitionState 异步落地后才渲染面板, 需 waitFor
    await waitFor(() => expect(screen.getByText("novel.cognition.title")).toBeInTheDocument())
    fireEvent.click(screen.getByText("novel.cognition.title"))
    expect(screen.getByText("novel.cognition.lastUpdated")).toBeInTheDocument()
    expect(screen.getByText("林烬")).toBeInTheDocument()
    expect(screen.getByText(/真相A/)).toBeInTheDocument()
    expect(screen.getByText(/真相B/)).toBeInTheDocument()
    expect(screen.getByText("苏晚")).toBeInTheDocument()
    expect(screen.getByText("novel.cognition.readerKnows")).toBeInTheDocument()
    expect(screen.getByText(/读者知道X/)).toBeInTheDocument()
    // 折叠: 内容仍挂载 (collapsible-panel 用 CSS data-open 控制可见性, review-view.tsx:1223)
    const panel = document.getElementById("review-cognition-panel")
    expect(panel?.getAttribute("data-open")).toBe("true")
    fireEvent.click(screen.getByText("novel.cognition.title"))
    expect(panel?.getAttribute("data-open")).toBe("false")
  })

  it("认知空数据 → noData; lastUpdatedChapter=0 不渲染 lastUpdated 行", async () => {
    // 认知面板渲染在非空态分支内, 需要一个 pending 项
    mocks.reviewItems = [makeReviewItem({ id: "p1" })]
    renderView()
    await waitFor(() => expect(screen.getByText("novel.cognition.title")).toBeInTheDocument())
    fireEvent.click(screen.getByText("novel.cognition.title"))
    expect(screen.getByText("novel.cognition.noData")).toBeInTheDocument()
    expect(screen.queryByText("novel.cognition.lastUpdated")).not.toBeInTheDocument()
  })

  it("loadCognitionState 失败 → 不渲染认知面板; 非 novelMode → 不渲染", async () => {
    mocks.loadCognitionState.mockRejectedValue(new Error("read fail"))
    renderView()
    await waitFor(() => expect(screen.queryByText("novel.cognition.title")).not.toBeInTheDocument())
    cleanup()
    mocks.state.novelMode = false
    renderView()
    expect(screen.queryByText("novel.cognition.title")).not.toBeInTheDocument()
  })
})

describe("ReviewView — W4 边界与异步分支", () => {
  it("characterOnly 仅把角色一致性结果交给 action builder; issue state 加载失败回退空状态", async () => {
    const character = makeResult({ type: "character_consistency" })
    const pacing = makeResult({ type: "pacing_issue" })
    setRun({ runId: "co1", filePath: "E:/Novel/chapter-8.md", results: [character, pacing], running: false, error: null })
    mocks.buildVisibleNovelReviewActionItems.mockReturnValue([makeActionItem({ id: "co-action" })])
    mocks.loadDashboardIssueState.mockRejectedValueOnce(new Error("state read failed"))
    renderView({ characterOnly: true })
    await waitFor(() => expect(mocks.buildVisibleNovelReviewActionItems).toHaveBeenCalled())
    const [, results] = mocks.buildVisibleNovelReviewActionItems.mock.calls[mocks.buildVisibleNovelReviewActionItems.mock.calls.length - 1]
    expect(results).toEqual([character])
    expect(screen.getByText("行动项消息")).toBeInTheDocument()
  })

  it("项目切换到空值时清理历史; loadReviewHistory 的无项目早退可执行", async () => {
    mocks.listGenerationHistory.mockResolvedValue([makeHistoryEntry({ id: "switch-h" })])
    const view = renderView()
    await waitFor(() => expect(screen.getByText("第8章审稿")).toBeInTheDocument())
    mocks.state.project = null
    view.rerender(<ReviewView />)
    await waitFor(() => expect(screen.queryByText("第8章审稿")).not.toBeInTheDocument())
    expect(mocks.listGenerationHistory).toHaveBeenCalledWith("E:/Novel", "review")
    view.unmount()
  })

  it("并发启动第二个改写时，首个生成完成后的陈旧 dialog updater 保持当前对话框", async () => {
    const first = deferred<ReviewRewriteEdit[]>()
    const second = deferred<ReviewRewriteEdit[]>()
    setRun({ runId: "rw-concurrent", filePath: "E:/Novel/chapter-8.md", results: [makeResult()], running: false, error: null })
    mocks.buildVisibleNovelReviewActionItems.mockReturnValue([
      makeActionItem({ id: "a1", message: "首个行动项" }),
      makeActionItem({ id: "a2", message: "第二个行动项", targetPath: "E:/Novel/chapter-9.md" }),
    ])
    mocks.generateReviewRewriteEdits.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    renderView()
    fireEvent.click(within(actionItemCard("首个行动项")).getByText("dashboard.actions.aiRewrite"))
    await waitFor(() => expect(screen.getByText("review.rewrite.waiting")).toBeInTheDocument())
    fireEvent.click(within(actionItemCard("第二个行动项")).getByText("dashboard.actions.aiRewrite"))
    await act(async () => first.resolve([{ id: "edit-8", originalText: "旧一", replacementText: "新一", note: "" }]))
    expect(screen.queryByText("旧一")).not.toBeInTheDocument()
    await act(async () => second.resolve([{ id: "edit-9", originalText: "旧二", replacementText: "新二", note: "" }]))
    await waitFor(() => expect(screen.getByText("旧二")).toBeInTheDocument())
  })

  it("改写生成空错误消息使用默认错误文案", async () => {
    setRun({ runId: "rw-empty-error", filePath: "E:/Novel/chapter-8.md", results: [makeResult()], running: false, error: null })
    mocks.buildVisibleNovelReviewActionItems.mockReturnValue([makeActionItem({ id: "a1" })])
    mocks.generateReviewRewriteEdits.mockRejectedValueOnce(new Error(""))
    renderView()
    fireEvent.click(screen.getByText("dashboard.actions.aiRewrite"))
    await waitFor(() => expect(screen.getByText("review.rewrite.errorRegenerate")).toBeInTheDocument())
  })

  it("应用改写写入 applied backup, 选中文件回填并持久化 rewrites", async () => {
    setRun({ runId: "rw-applied", filePath: "E:/Novel/chapter-8.md", results: [makeResult()], running: false, error: null })
    mocks.state.selectedFile = "E:/Novel/chapter-8.md"
    mocks.buildVisibleNovelReviewActionItems.mockReturnValue([makeActionItem({ id: "a1" })])
    mocks.generateReviewRewriteEdits.mockResolvedValue([{ id: "edit-10", originalText: "旧文", replacementText: "新文", note: "说明" }])
    mocks.applyReviewRewriteEditsToMarkdown.mockReturnValue({
      ok: true,
      markdown: "# 已改写",
      applied: [{
        edit: { id: "a1:edit-1", originalText: "旧文", replacementText: "新文", note: "说明" },
        backup: { itemId: "a1:edit-1", targetPath: "E:/Novel/chapter-8.md", originalText: "旧文", replacementText: "新文", evidence: "证据", updatedAt: "now" },
      }],
    })
    renderView()
    fireEvent.click(screen.getByText("dashboard.actions.aiRewrite"))
    // 生成器返回的 originalText 直接作为行内容，等待对话框出现后点击应用。
    await waitFor(() => expect(screen.getByText("旧文")).toBeInTheDocument())
    fireEvent.click(screen.getByText("review.rewrite.apply"))
    await waitFor(() => expect(mocks.saveDashboardIssueState).toHaveBeenCalledWith(
      "E:/Novel",
      expect.objectContaining({ rewrites: expect.objectContaining({ "a1:edit-1": expect.objectContaining({ itemId: "a1:edit-1", targetPath: "E:/Novel/chapter-8.md" }) }) }),
    ))
    expect(mocks.state.setFileContent).toHaveBeenCalledWith("# 已改写")
    expect(screen.queryByTestId("dialog")).not.toBeInTheDocument()
  })

  it("单条重生成读取失败回退原章节, 空结果显示 errorSingleNoResult", async () => {
    setRun({ runId: "rw-one", filePath: "E:/Novel/chapter-8.md", results: [makeResult()], running: false, error: null })
    mocks.buildVisibleNovelReviewActionItems.mockReturnValue([makeActionItem({ id: "a1" })])
    mocks.generateReviewRewriteEdits.mockResolvedValueOnce([{ id: "edit-11", originalText: "旧文", replacementText: "新文", note: "" }])
    renderView()
    fireEvent.click(screen.getByText("dashboard.actions.aiRewrite"))
    await waitFor(() => expect(screen.getByText("旧文")).toBeInTheDocument())
    mocks.readFile.mockRejectedValueOnce(new Error("latest missing"))
    mocks.generateReviewRewriteEdits.mockResolvedValueOnce([])
    fireEvent.click(screen.getByText("review.rewrite.regenerate"))
    await waitFor(() => expect(screen.getByText("review.rewrite.errorSingleNoResult")).toBeInTheDocument())
    expect(mocks.generateReviewRewriteEdits).toHaveBeenLastCalledWith(
      expect.anything(),
      "# Chapter\n正文",
      null,
      expect.objectContaining({ targetOriginalText: "旧文" }),
    )
  })

  it("单条重生成空错误消息使用默认错误文案", async () => {
    setRun({ runId: "rw-one-error", filePath: "E:/Novel/chapter-8.md", results: [makeResult()], running: false, error: null })
    mocks.buildVisibleNovelReviewActionItems.mockReturnValue([makeActionItem({ id: "a1" })])
    mocks.generateReviewRewriteEdits.mockResolvedValueOnce([{ id: "edit-12", originalText: "旧文", replacementText: "新文", note: "" }])
    renderView()
    fireEvent.click(screen.getByText("dashboard.actions.aiRewrite"))
    await waitFor(() => expect(screen.getByText("旧文")).toBeInTheDocument())
    mocks.generateReviewRewriteEdits.mockRejectedValueOnce(new Error(""))
    fireEvent.click(screen.getByText("review.rewrite.regenerate"))
    await waitFor(() => expect(screen.getByText("review.rewrite.errorRegenerate")).toBeInTheDocument())
  })

  it("恢复改写时读取空内容静默返回; 选中文件恢复时回填正文与高亮", async () => {
    setRun({ runId: "rw-restore", filePath: "E:/Novel/chapter-8.md", results: [makeResult()], running: false, error: null })
    mocks.buildVisibleNovelReviewActionItems.mockReturnValue([makeActionItem({ id: "a1" })])
    mocks.loadDashboardIssueState.mockResolvedValue({
      ignored: {},
      rewrites: { "a1": { itemId: "a1", targetPath: "E:/Novel/chapter-8.md", evidence: "ev", originalText: "旧文", replacementText: "新文", updatedAt: "t" } },
    })
    const view = renderView()
    await waitFor(() => expect(screen.getByText("dashboard.actions.restore")).toBeInTheDocument())
    mocks.readFile.mockResolvedValueOnce("")
    fireEvent.click(screen.getByText("dashboard.actions.restore"))
    await waitFor(() => expect(mocks.writeFile).not.toHaveBeenCalled())
    view.unmount()

    mocks.state.selectedFile = "E:/Novel/chapter-8.md"
    mocks.loadDashboardIssueState.mockResolvedValue({
      ignored: {},
      rewrites: { "a1": { itemId: "a1", targetPath: "E:/Novel/chapter-8.md", evidence: "ev", originalText: "旧文", replacementText: "新文", updatedAt: "t" } },
    })
    mocks.readFile.mockResolvedValue("# 最新\n新文")
    const view2 = renderView()
    await waitFor(() => expect(screen.getByText("dashboard.actions.restore")).toBeInTheDocument())
    fireEvent.click(screen.getByText("dashboard.actions.restore"))
    await waitFor(() => expect(mocks.state.setFileContent).toHaveBeenCalledWith("restored-md"))
    expect(mocks.state.setPendingEditorHighlight).toHaveBeenCalledWith(expect.objectContaining({ text: "旧文" }))
    view2.unmount()
  })

  it("创建页 index/log 读取失败使用默认内容; 缺失 item 的创建 action 走 generic", async () => {
    mocks.reviewItems = [makeReviewItem({ id: "create-fallback", options: [{ label: "建页", action: "create:query" }] })]
    mocks.readFile.mockRejectedValue(new Error("missing index or log"))
    renderView()
    fireEvent.click(screen.getByText("建页"))
    await waitFor(() => expect(mocks.resolveItem).toHaveBeenCalledWith("create-fallback", "novel.review.notifications.created"))
    expect(mocks.writeFile.mock.calls.some(([path, content]) => String(path).endsWith("index.md") && String(content).includes("## Queries"))).toBe(true)
    cleanup()
    mocks.reviewItems = [makeReviewItem({ id: "create-missing", options: [{ label: "建页", action: "create:query" }] })]
    renderView()
    mocks.reviewItems.length = 0
    fireEvent.click(screen.getByText("建页"))
    expect(mocks.resolveItem).toHaveBeenCalledWith("create-missing", "review.fallbacks.genericActionLabel")
  })

  it("审稿按钮覆盖无 project 与空正文守卫; compare 对话框使用 project/session fallback", async () => {
    mocks.state.project = null
    mocks.state.selectedFile = "E:/Novel/chapter-8.md"
    mocks.state.fileContent = "# 正文"
    renderView()
    fireEvent.click(screen.getByText("novel.review.startReview"))
    expect(mocks.startNovelReviewRun).not.toHaveBeenCalled()
    cleanup()

    mocks.state.project = { path: "E:/Novel" }
    mocks.state.selectedFile = "E:/Novel/chapter-8.md"
    mocks.state.fileContent = "   "
    renderView()
    fireEvent.click(screen.getByText("novel.review.startReview"))
    expect(mocks.startNovelReviewRun).not.toHaveBeenCalled()
    cleanup()

    mocks.state.project = null
    mocks.state.selectedFile = null
    mocks.state.reviewRun = null
    mocks.buildVisibleNovelReviewActionItems.mockReturnValue([makeActionItem({ id: "compare-fallback" })])
    renderView()
    fireEvent.click(screen.getByText("对比改写"))
    expect(screen.getByTestId("finding-compare-dialog")).toBeInTheDocument()
    fireEvent.click(screen.getByTestId("fcd-close"))
  })

  it("历史结果可折叠复原, 无 suggestion 与未知维度使用原文", async () => {
    mocks.i18nExists.mockReturnValue(false)
    mocks.listGenerationHistory.mockResolvedValue([makeHistoryEntry({
      id: "history-toggle",
      results: [makeResult({ type: "unknown_dimension", suggestion: "" })],
    })])
    renderView()
    await waitFor(() => expect(screen.getByText("第8章审稿")).toBeInTheDocument())
    fireEvent.click(screen.getByText("第8章审稿"))
    expect(screen.getByText("unknown_dimension")).toBeInTheDocument()
    fireEvent.click(screen.getByText("第8章审稿"))
    expect(document.getElementById("review-history-history-toggle")?.getAttribute("data-open")).toBe("false")
  })

  it("novelMode 下 ReviewCard affectedPages 使用 novel pages 文案, action item 缺 evidence/suggestion 仍可渲染", () => {
    mocks.reviewItems = [makeReviewItem({ id: "pages-novel", affectedPages: ["chapter.md"] })]
    setRun({ runId: "no-text", filePath: "E:/Novel/chapter-8.md", results: [makeResult()], running: false, error: null })
    mocks.buildVisibleNovelReviewActionItems.mockReturnValue([makeActionItem({ id: "no-text-action", evidence: "", suggestion: "" })])
    renderView()
    expect(screen.getByText(/novel\.review\.pages/)).toBeInTheDocument()
    expect(screen.getByText("行动项消息")).toBeInTheDocument()
    expect(screen.queryByText(/行动项证据/)).not.toBeInTheDocument()
    expect(screen.queryByText(/行动项建议/)).not.toBeInTheDocument()
    fireEvent.keyDown(actionItemCard("行动项消息"), { key: "x" })
  })
})

describe("ReviewView — 对话框生命周期与守卫", () => {
  it("对话框 onOpenChange(false) busy=false → onClose; busy=true → 不关闭", async () => {
    setRun({
      runId: "r1",
      filePath: "E:/Novel/chapter-8.md",
      results: [makeResult()],
      running: false,
      error: null,
    })
    mocks.buildVisibleNovelReviewActionItems.mockReturnValue([makeActionItem({ id: "a1" })])
    mocks.generateReviewRewriteEdits.mockResolvedValue([{ id: "edit-13", originalText: "原文1", replacementText: "替换1", note: "" }])
    renderView()
    fireEvent.click(screen.getByText("dashboard.actions.aiRewrite"))
    await waitFor(() => expect(screen.getByText("原文1")).toBeInTheDocument())
    fireEvent.click(screen.getByTestId("dialog-dismiss-trigger"))
    await waitFor(() => expect(screen.queryByTestId("dialog")).not.toBeInTheDocument())
    // busy 场景: 重新打开 + 挂起生成 → dialog-dismiss-trigger 不应关闭
    const d = deferred<never>()
    mocks.generateReviewRewriteEdits.mockReturnValueOnce(d.promise)
    fireEvent.click(screen.getByText("dashboard.actions.aiRewrite"))
    await waitFor(() => expect(screen.getByText("review.rewrite.waiting")).toBeInTheDocument())
    fireEvent.click(screen.getByTestId("dialog-dismiss-trigger"))
    expect(screen.getByTestId("dialog")).toBeInTheDocument()
    await act(async () => d.reject(new Error("cancel")))
  })

  it("错误横幅在对话框内渲染; cancel 禁用当 busy", async () => {
    setRun({
      runId: "r1",
      filePath: "E:/Novel/chapter-8.md",
      results: [makeResult()],
      running: false,
      error: null,
    })
    mocks.buildVisibleNovelReviewActionItems.mockReturnValue([makeActionItem({ id: "a1" })])
    const d = deferred<never>()
    mocks.generateReviewRewriteEdits.mockReturnValue(d.promise)
    renderView()
    fireEvent.click(screen.getByText("dashboard.actions.aiRewrite"))
    await waitFor(() => expect(screen.getByText("review.rewrite.waiting")).toBeInTheDocument())
    // busy → cancel disabled
    expect(screen.getByText("common.cancel")).toBeDisabled()
    await act(async () => d.reject(new Error("https://x/y fail")))
    await waitFor(() => expect(screen.getByText(/\[url\]/)).toBeInTheDocument())
  })
})

describe("ReviewView — 覆盖率终局：可达边界", () => {
  function setNovelRun(over: Partial<NovelReviewActionItem> = {}) {
    setRun({
      runId: "fin2-r1",
      filePath: "E:/Novel/chapter-8.md",
      results: [makeResult({ type: "consistency_mechanical", continuityMeta: { subtype: "consistency_mechanical", ref: "c:1", chapter: 3 } })],
      running: false,
      error: null,
    })
    mocks.buildVisibleNovelReviewActionItems.mockReturnValue([
      makeActionItem({ id: "a1", reviewSeverity: "error", continuityMeta: { subtype: "consistency_mechanical", ref: "c:1", chapter: 3 }, ...over }),
    ])
  }

  it("dismissFinding 以非 Error 拒绝 → String(error) 提示 (catch 非 Error 分支)", async () => {
    setNovelRun()
    mocks.dismissFinding.mockRejectedValue("写盘失败")
    renderView()
    fireEvent.click(screen.getByText("review.results.dismiss.dismissButton"))
    fireEvent.click(screen.getByText("review.results.dismiss.confirmButton"))
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("review.results.dismiss.titleLabel: 写盘失败"))
    expect(mocks.dismissFinding).toHaveBeenCalledTimes(1)
  })

  it("dismiss 面板二次点击关闭：toggle 关闭分支（不触发 dismissFinding）", async () => {
    setNovelRun()
    mocks.dismissFinding.mockResolvedValue(undefined)
    renderView()
    const dismissBtn = screen.getByText("review.results.dismiss.dismissButton")
    fireEvent.click(dismissBtn)
    expect(screen.getByRole("region")).toBeInTheDocument()
    // 再次点击同一 finding → dismissTarget 置空 (toggle 关闭分支, 跳过 reason/note 重置)
    fireEvent.click(dismissBtn)
    expect(screen.queryByRole("region")).not.toBeInTheDocument()
    expect(mocks.dismissFinding).not.toHaveBeenCalled()
    // 重开仍可用（打开分支再次重置为默认值）
    fireEvent.click(screen.getByText("review.results.dismiss.dismissButton"))
    expect(screen.getByRole("combobox")).toHaveValue("false_positive")
    fireEvent.click(screen.getByText("review.results.dismiss.cancelButton"))
  })

  it("AI 改写: readFile 拒绝 → 走 catch 兜底空串 → alertNoChapter", async () => {
    setNovelRun()
    mocks.readFile.mockRejectedValueOnce(new Error("gone"))
    renderView()
    fireEvent.click(screen.getByText("dashboard.actions.aiRewrite"))
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("review.rewrite.alertNoChapter"))
  })

  it("AI 改写: 生成以非 Error 拒绝 → String(error) 脱敏后上屏", async () => {
    setNovelRun()
    mocks.generateReviewRewriteEdits.mockRejectedValue("boom-plain")
    renderView()
    fireEvent.click(screen.getByText("dashboard.actions.aiRewrite"))
    await waitFor(() => expect(screen.getByText(/boom-plain/)).toBeInTheDocument())
  })

  it("单条重生成成功: updater 替换匹配行并保留其他行", async () => {
    setNovelRun()
    mocks.generateReviewRewriteEdits.mockResolvedValueOnce([
      { id: "edit-14", originalText: "旧1", replacementText: "新1", note: "" },
      { id: "edit-15", originalText: "旧2", replacementText: "新2", note: "" },
    ])
    renderView()
    fireEvent.click(screen.getByText("dashboard.actions.aiRewrite"))
    await waitFor(() => expect(screen.getByDisplayValue("新1")).toBeInTheDocument())
    mocks.generateReviewRewriteEdits.mockResolvedValueOnce([
      { id: "edit-16", originalText: "旧1", replacementText: "再生成1", note: "" },
    ])
    fireEvent.click(screen.getAllByText("review.rewrite.regenerate")[0])
    await waitFor(() => expect(screen.getByDisplayValue("再生成1")).toBeInTheDocument())
    // 非匹配行原样保留 (map else 分支)
    expect(screen.getByDisplayValue("新2")).toBeInTheDocument()
  })

  it("单条重生成以非 Error 拒绝后 apply 被 rewriteError 守卫拦截", async () => {
    setNovelRun()
    mocks.generateReviewRewriteEdits.mockResolvedValueOnce([
      { id: "edit-17", originalText: "旧1", replacementText: "新1", note: "" },
    ])
    renderView()
    fireEvent.click(screen.getByText("dashboard.actions.aiRewrite"))
    await waitFor(() => expect(screen.getByDisplayValue("新1")).toBeInTheDocument())
    mocks.generateReviewRewriteEdits.mockRejectedValueOnce("single-boom")
    fireEvent.click(screen.getAllByText("review.rewrite.regenerate")[0])
    await waitFor(() => expect(screen.getByText(/single-boom/)).toBeInTheDocument())
    // apply 未禁用 (仅 busy/无内容禁用) → rewriteError 守卫拦截
    fireEvent.click(screen.getByText("review.rewrite.apply"))
    expect(mocks.writeFile).not.toHaveBeenCalled()
    expect(screen.getByTestId("dialog")).toBeInTheDocument()
  })

  it("多编辑行: 单条 ignore 命中一行 (else 保留其他行), 再 restore 解禁为 pending", async () => {
    setNovelRun()
    mocks.generateReviewRewriteEdits.mockResolvedValueOnce([
      { id: "edit-18", originalText: "旧1", replacementText: "新1", note: "" },
      { id: "edit-19", originalText: "旧2", replacementText: "新2", note: "" },
    ])
    renderView()
    fireEvent.click(screen.getByText("dashboard.actions.aiRewrite"))
    await waitFor(() => expect(screen.getByDisplayValue("新2")).toBeInTheDocument())
    // ignore 第一行 → 命中行 ignored, 第二行保持不变
    fireEvent.click(screen.getAllByText("review.rewrite.ignore")[0])
    await waitFor(() => expect(screen.getAllByText("review.rewrite.restore")).toHaveLength(1))
    expect(screen.getAllByText("review.rewrite.ignore")).toHaveLength(1)
    // 解除 ignore → 回 pending
    fireEvent.click(screen.getAllByText("review.rewrite.restore")[0])
    await waitFor(() => expect(screen.getAllByText("review.rewrite.ignore")).toHaveLength(2))
  })

  it("viewRewrite/restore: 兼容 `itemId:` 前缀备份键; restore 读取拒绝走 catch", async () => {
    setNovelRun()
    const backup = { itemId: "a1", targetPath: "E:/Novel/chapter-8.md", evidence: "ev", originalText: "旧文", replacementText: "新文", updatedAt: "t" }
    mocks.loadDashboardIssueState.mockResolvedValue({
      ignored: {},
      rewrites: { "a1": backup, "a1:next": { ...backup, itemId: "a1:next" } },
    })
    renderView()
    await waitFor(() => expect(screen.getByText("dashboard.actions.viewRewrite")).toBeInTheDocument())
    // viewRewrite: 精确键 + 前缀键都进入备份列表 (filter 双分支)
    fireEvent.click(screen.getByText("dashboard.actions.viewRewrite"))
    await waitFor(() => expect(mocks.state.setSelectedFile).toHaveBeenCalledWith("E:/Novel/chapter-8.md"))
    // restore: readFile 拒绝 → catch 兜底空串 → 静默 return
    mocks.readFile.mockRejectedValueOnce(new Error("gone"))
    fireEvent.click(screen.getByText("dashboard.actions.restore"))
    await waitFor(() => expect(mocks.writeFile).not.toHaveBeenCalled())
    // restore 再次点击成功: 双备份回写后清理 rewrites
    fireEvent.click(screen.getByText("dashboard.actions.restore"))
    await waitFor(() => expect(mocks.writeFile).toHaveBeenCalledWith("E:/Novel/chapter-8.md", "restored-md"))
    expect(mocks.saveDashboardIssueState).toHaveBeenCalledWith("E:/Novel", expect.objectContaining({ rewrites: {} }))
  })

  it("save: 内容全为注释/空白 → 标题回退 savedQueryTitle", async () => {
    setNovelRun()
    const content = "<!-- save-worthy: note -->\n<!-- sources: src -->\n"
    mocks.reviewItems = [makeReviewItem({ id: "svq", options: [{ label: "保存", action: `save:${btoa(content)}` }] })]
    renderView()
    fireEvent.click(screen.getByText("保存"))
    await waitFor(() =>
      expect(mocks.writeFile).toHaveBeenCalledWith(
        expect.stringContaining("/wiki/queries/reviewfallbackssavedquerytitle-"),
        expect.any(String),
      ),
    )
    expect(mocks.resolveItem).toHaveBeenCalledWith("svq", "novel.review.notifications.savedToChapterLibrary")
  })

  it("save: 非 novelMode 成功 → savedToWiki 通知", async () => {
    mocks.state.novelMode = false
    mocks.reviewItems = [makeReviewItem({ id: "svw", options: [{ label: "保存", action: `save:${btoa("Title Line")}` }] })]
    renderView()
    fireEvent.click(screen.getByText("保存"))
    await waitFor(() => expect(mocks.resolveItem).toHaveBeenCalledWith("svw", "review.notifications.savedToWiki"))
  })

  it("create page: 非 novelMode 成功 → createdPage; 写入失败 → createFailed", async () => {
    mocks.state.novelMode = false
    mocks.reviewItems = [makeReviewItem({ id: "cp1", title: "新知", options: [{ label: "建页", action: "create:page" }] })]
    renderView()
    fireEvent.click(screen.getByText("建页"))
    await waitFor(() => expect(mocks.resolveItem).toHaveBeenCalledWith("cp1", "review.notifications.createdPage"))
    cleanup()
    mocks.writeFile.mockRejectedValueOnce(new Error("disk full"))
    mocks.reviewItems = [makeReviewItem({ id: "cp2", title: "新页", options: [{ label: "建页", action: "create:page" }] })]
    renderView()
    fireEvent.click(screen.getByText("建页"))
    await waitFor(() => expect(mocks.resolveItem).toHaveBeenCalledWith("cp2", "review.notifications.createFailed"))
  })

  it("save: novelMode 写入失败 → novel saveFailed 通知", async () => {
    setNovelRun()
    mocks.reviewItems = [makeReviewItem({ id: "svf", options: [{ label: "保存", action: `save:${btoa("Title Line")}` }] })]
    mocks.writeFile.mockRejectedValueOnce(new Error("disk full"))
    renderView()
    fireEvent.click(screen.getByText("保存"))
    await waitFor(() => expect(mocks.resolveItem).toHaveBeenCalledWith("svf", "novel.review.notifications.saveFailed"))
  })

  it("create page: entity/concept 类型写入对应目录 (entities/concepts)", async () => {
    const runCreatePath = async (id: string, action: string, title: string) => {
      cleanup()
      mocks.writeFile.mockClear()
      mocks.reviewItems = [makeReviewItem({ id, title, options: [{ label: "建页", action }] })]
      renderView()
      fireEvent.click(screen.getByText("建页"))
      await waitFor(() => expect(mocks.writeFile).toHaveBeenCalled())
      return String(mocks.writeFile.mock.calls.find((c) => String(c[0]).includes("/wiki/"))?.[0] ?? "")
    }
    // action 含关键词 → detectPageType 返回 entity / concept → 目录实体化
    expect(await runCreatePath("en1", "create:entity", "人物甲")).toContain("/wiki/entities/")
    expect(await runCreatePath("cp1", "create:concept", "概念甲")).toContain("/wiki/concepts/")
    expect(await runCreatePath("qy1", "create:page", "常规页")).toContain("/wiki/queries/")
  })

  it("非 novelMode: pending + resolved 同时存在渲染分隔线", () => {
    mocks.state.novelMode = false
    mocks.reviewItems = [
      makeReviewItem({ id: "p1", resolved: false }),
      makeReviewItem({ id: "p2", resolved: true }),
    ]
    renderView()
    expect(screen.getByText(/review\.resolvedSeparator/)).toBeInTheDocument()
  })

  it("export evidence: 空 type/severity 结果回退 quality/info", () => {
    setRun({ runId: "fin2-export", filePath: "E:/Novel/chapter-8.md", results: [makeResult({ type: "", severity: "" })], running: false, error: null })
    renderView()
    fireEvent.click(screen.getByTestId("export-evidence-chain"))
    expect(mocks.exportEvidenceChainForReview).toHaveBeenCalledWith(
      expect.objectContaining({
        findings: [expect.objectContaining({ type: "quality", severity: "info" })],
      }),
    )
  })

  it("历史: 删除未展开条目不折叠当前展开项", async () => {
    mocks.listGenerationHistory.mockResolvedValue([
      makeHistoryEntry({ id: "h-a", title: "第1章审稿" }),
      makeHistoryEntry({ id: "h-b", title: "第2章审稿" }),
    ])
    renderView()
    await waitFor(() => expect(screen.getByText("第1章审稿")).toBeInTheDocument())
    // 展开 h-a
    fireEvent.click(screen.getByText("第1章审稿"))
    await waitFor(() => expect(screen.getByText("第1章审稿").closest("button")?.getAttribute("aria-expanded")).toBe("true"))
    // 删除未展开的 h-b → expandedHistoryId 保持不变 (h-a 仍展开)
    fireEvent.click(screen.getAllByLabelText("novel.history.delete")[1])
    await waitFor(() => expect(mocks.deleteGenerationHistoryEntry).toHaveBeenCalled())
    expect(screen.getByText("第1章审稿").closest("button")?.getAttribute("aria-expanded")).toBe("true")
  })

  it("issue state 加载在卸载后拒绝 → cancelled 守卫跳过写回", async () => {
    const d = deferred<DashboardIssueState>()
    mocks.loadDashboardIssueState.mockReturnValueOnce(d.promise)
    const view = renderView()
    view.unmount()
    await act(async () => d.reject(new Error("late")))
    expect(mocks.loadDashboardIssueState).toHaveBeenCalledTimes(1)
  })
})
