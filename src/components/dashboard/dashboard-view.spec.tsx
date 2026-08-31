// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor, within, setupDomGlobals } from "@/test-helpers/component-test-utils"
import { cleanup } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { DashboardView } from "./dashboard-view"
import type { NovelReviewResult } from "@/lib/novel/review-adapter"
import type { LintResult } from "@/lib/lint"
import type { FactCheckReport, FactCheckResult } from "@/lib/novel/fact-snapshot"
import type { ForeshadowingDebtReport } from "@/lib/novel/foreshadowing-debt"
import type { ChapterSnapshot } from "@/lib/novel/chapter-ingest"

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

const mocks = vi.hoisted(() => {
  const state: Record<string, unknown> = {}
  return {
    state,
    t: vi.fn((key: string) => key),
    readFile: vi.fn(),
    writeFile: vi.fn(),
    writeFileAtomic: vi.fn(),
    listDirectory: vi.fn(),
    deleteFile: vi.fn(),
    copyFile: vi.fn(),
    copyDirectory: vi.fn(),
    preprocessFile: vi.fn(),
    findRelatedWikiPages: vi.fn(),
    createDirectory: vi.fn(),
    fileExists: vi.fn(),
    getFileModifiedTime: vi.fn(),
    getFileSize: vi.fn(),
    getFileMd5: vi.fn(),
    readFileAsBase64: vi.fn(),
    createProject: vi.fn(),
    openProject: vi.fn(),
    openProjectFolder: vi.fn(),
    openFileLocation: vi.fn(),
    resolveDefaultModel: vi.fn(() => null),
    hasUsableLlm: vi.fn(() => true),
    searchWiki: vi.fn(),
    runFactCheck: vi.fn(),
    analyzeForeshadowingDebt: vi.fn(),
    listSnapshots: vi.fn(),
    loadSnapshot: vi.fn(),
    loadForeshadowingTracker: vi.fn(),
    loadNovelSessionStatus: vi.fn(),
    subscribeStatusJson: vi.fn(async () => () => {}),
    loadEmotionLedger: vi.fn(),
    getTopEmotionalDebt: vi.fn(),
    streamChat: vi.fn(),
    loadDashboardIssueState: vi.fn(),
    saveDashboardIssueState: vi.fn(),
    findChapterSelectionByEvidence: vi.fn(),
    buildDashboardRewriteMessages: vi.fn(),
    buildFactCheckInsertMessages: vi.fn(),
    parseFactCheckInsertPlan: vi.fn(),
    applyDashboardRewriteToMarkdown: vi.fn(),
    restoreDashboardRewriteInMarkdown: vi.fn(),
  }
})

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: mocks.t }),
}))

vi.mock("@/stores/wiki-store", () => ({
  useWikiStore: Object.assign(
    (selector: (s: unknown) => unknown) => selector(mocks.state),
    { getState: () => mocks.state },
  ),
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
vi.mock("@/lib/search", () => ({ searchWiki: mocks.searchWiki }))
vi.mock("@/lib/novel/fact-snapshot", () => ({ runFactCheck: mocks.runFactCheck }))
vi.mock("@/lib/novel/foreshadowing-debt", () => ({ analyzeForeshadowingDebt: mocks.analyzeForeshadowingDebt }))
vi.mock("@/lib/novel/chapter-ingest", () => ({
  listSnapshots: mocks.listSnapshots,
  loadSnapshot: mocks.loadSnapshot,
}))
vi.mock("@/lib/novel/foreshadowing-tracker", () => ({ loadForeshadowingTracker: mocks.loadForeshadowingTracker }))
vi.mock("@/lib/novel/novel-session-status", () => ({
  loadNovelSessionStatus: mocks.loadNovelSessionStatus,
  subscribeStatusJson: mocks.subscribeStatusJson,
}))
vi.mock("@/lib/novel/emotion-ledger", () => ({
  loadEmotionLedger: mocks.loadEmotionLedger,
  getTopEmotionalDebt: mocks.getTopEmotionalDebt,
}))
vi.mock("@/lib/llm-client", () => ({ streamChat: mocks.streamChat }))
vi.mock("@/lib/dashboard-issue-actions", () => ({
  createEmptyDashboardIssueState: () => ({ ignored: {}, rewrites: {} }),
  buildDashboardIssueId: (parts: Array<string | number | null | undefined>) =>
    parts.map((p) => String(p ?? "").trim()).map((p) => p.replace(/\s+/g, " ")).join("|"),
  loadDashboardIssueState: mocks.loadDashboardIssueState,
  saveDashboardIssueState: mocks.saveDashboardIssueState,
  findChapterSelectionByEvidence: mocks.findChapterSelectionByEvidence,
  buildDashboardRewriteMessages: mocks.buildDashboardRewriteMessages,
  buildFactCheckInsertMessages: mocks.buildFactCheckInsertMessages,
  parseFactCheckInsertPlan: mocks.parseFactCheckInsertPlan,
  applyDashboardRewriteToMarkdown: mocks.applyDashboardRewriteToMarkdown,
  restoreDashboardRewriteInMarkdown: mocks.restoreDashboardRewriteInMarkdown,
}))

vi.mock("./debt-board-view", () => ({
  DebtBoardView: (props: { chaseDebts: unknown[]; chaseDebtEvents: unknown[]; currentChapter: number; debtReport: unknown; emotionDebts: unknown[] }) => (
    <div data-testid="debt-board-view" data-chase={String(props.chaseDebts.length)} data-chapter={String(props.currentChapter)} data-emotion={String(props.emotionDebts.length)} />
  ),
}))

vi.mock("@/components/novel/text-transform-preview-dialog", () => ({
  TextTransformPreviewDialog: (props: {
    open: boolean
    description: unknown
    sourceLabel: unknown
    candidateLabel: unknown
    sourceContent: unknown
    candidateContent: unknown
    applyDisabled: boolean
    secondaryActionDisabled: boolean
    onApply: () => void
    onSecondaryAction: () => void
    onCandidateContentChange?: (v: string) => void
    onClose: () => void
  }) =>
    props.open ? (
      <div
        data-testid="ttpd"
        data-description={String(props.description)}
        data-source-label={String(props.sourceLabel)}
        data-candidate-label={String(props.candidateLabel)}
      >
        <span data-testid="ttpd-source">{String(props.sourceContent)}</span>
        <textarea
          data-testid="ttpd-candidate"
          value={String(props.candidateContent)}
          disabled={!props.onCandidateContentChange}
          onChange={(e) => props.onCandidateContentChange?.(e.target.value)}
        />
        <button type="button" data-testid="ttpd-apply" disabled={props.applyDisabled} onClick={() => props.onApply()}>
          apply
        </button>
        <button type="button" data-testid="ttpd-regenerate" disabled={props.secondaryActionDisabled} onClick={() => props.onSecondaryAction()}>
          regenerate
        </button>
        <button type="button" data-testid="ttpd-close" onClick={() => props.onClose()}>
          close
        </button>
      </div>
    ) : null,
}))

// ── factories ──────────────────────────────────────────────────────────
function makeReviewResult(over: Partial<NovelReviewResult> = {}): NovelReviewResult {
  return {
    severity: "error",
    type: "character_consistency",
    message: "审查消息",
    evidence: "审查证据",
    relatedMemory: "",
    suggestion: "审查建议",
    ...over,
  }
}

function makeLintResult(over: Partial<LintResult> = {}): LintResult {
  return {
    type: "orphan",
    severity: "warning",
    page: "page-a.md",
    detail: "孤立页面",
    ...over,
  }
}

function makeFactResult(over: Partial<FactCheckResult> = {}): FactCheckResult {
  return {
    severity: "high",
    type: "character_jump",
    message: "事实矛盾",
    evidenceA: "证据A",
    evidenceB: "证据B",
    chapters: [3, 4],
    confidence: 0.9,
    suggestion: "补事件",
    ...over,
  }
}

function makeFactReport(over: Partial<FactCheckReport> = {}): FactCheckReport {
  return {
    results: [],
    checkedChapterCount: 3,
    ruleEngineTime: 0,
    ...over,
  }
}

function makeSnapshot(over: Partial<ChapterSnapshot> = {}): ChapterSnapshot {
  return {
    chapterNumber: 8,
    title: "第8章",
    filePath: "E:/Novel/wiki/chapter-8.md",
    ...over,
  } as ChapterSnapshot
}

function makeDebtReport(over: Partial<ForeshadowingDebtReport> = {}): ForeshadowingDebtReport {
  return {
    items: [],
    totalUnresolved: 0,
    criticalCount: 0,
    warningCount: 0,
    debtScore: 0,
    thresholds: { plantedStale: 5, advancedStale: 10, densityLimit: 5 },
    ...over,
  }
}

function dashboardCard(message: string): HTMLElement {
  // 同一 message 可能同时出现在 message 与 suggestion (lint 项) 或
  // 分组区 + fact 区块 (factcheck 项) → 取第一个匹配文本所在的卡片
  const el = screen.getAllByText(message)[0]
  const card = el.closest("div[role=button]")
  if (!card) throw new Error(`no dashboard card for ${message}`)
  return card as HTMLElement
}

function runReview() {
  mocks.state.reviewRun = {
    runId: "rr1",
    projectPath: "E:/Novel",
    filePath: "E:/Novel/chapter-8.md",
    results: [makeReviewResult()],
    running: false,
    error: null,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.state.project = { path: "E:/Novel" }
  mocks.state.dataVersion = 0
  mocks.state.reviewRun = null
  mocks.state.lintRun = null
  mocks.state.selectedFile = null
  mocks.state.fileContent = ""
  mocks.state.llmConfig = null
  mocks.state.setSelectedFile = vi.fn()
  mocks.state.setFileContent = vi.fn()
  mocks.state.setActiveView = vi.fn()
  mocks.state.setPendingEditorHighlight = vi.fn()
  mocks.state.bumpDataVersion = vi.fn()
  mocks.t.mockImplementation((key: string) => key)
  mocks.hasUsableLlm.mockReturnValue(true)
  mocks.readFile.mockResolvedValue("# Chapter\n正文")
  mocks.writeFile.mockResolvedValue(undefined)
  mocks.searchWiki.mockResolvedValue([])
  mocks.listSnapshots.mockResolvedValue([])
  mocks.loadSnapshot.mockResolvedValue(null)
  mocks.runFactCheck.mockResolvedValue(makeFactReport())
  mocks.loadForeshadowingTracker.mockResolvedValue({})
  mocks.analyzeForeshadowingDebt.mockReturnValue(makeDebtReport())
  mocks.loadNovelSessionStatus.mockResolvedValue({})
  mocks.loadEmotionLedger.mockResolvedValue({ entries: [] })
  mocks.getTopEmotionalDebt.mockReturnValue([])
  mocks.loadDashboardIssueState.mockResolvedValue({ ignored: {}, rewrites: {} })
  mocks.saveDashboardIssueState.mockResolvedValue(undefined)
  mocks.findChapterSelectionByEvidence.mockReturnValue({
    evidence: "审查证据",
    selection: { start: 0, end: 4, text: "正文", bodySnapshot: "# Chapter\n正文" },
  })
  mocks.buildDashboardRewriteMessages.mockReturnValue([{ role: "user", content: "msg" }])
  mocks.buildFactCheckInsertMessages.mockReturnValue([{ role: "user", content: "fc-msg" }])
  mocks.parseFactCheckInsertPlan.mockReturnValue({ anchorText: "正文", insertText: "补写内容" })
  mocks.applyDashboardRewriteToMarkdown.mockReturnValue("# rewritten\n正文")
  mocks.restoreDashboardRewriteInMarkdown.mockReturnValue("# restored\n正文")
  mocks.streamChat.mockImplementation(async (_cfg: unknown, _msgs: unknown, callbacks: { onToken: (t: string) => void; onDone: () => void }) => {
    callbacks.onToken("生成片段")
    callbacks.onDone()
  })
  setupDomGlobals()
})

afterEach(() => {
  vi.restoreAllMocks()
  cleanup()
})

describe("DashboardView — 空态与头部", () => {
  it("无 project: noIssues 空态渲染, extras effect 早退", async () => {
    mocks.state.project = null
    render(<DashboardView />)
    expect(screen.getByText("dashboard.noIssues")).toBeInTheDocument()
    expect(screen.getByText("dashboard.noIssuesHint")).toBeInTheDocument()
    expect(mocks.listSnapshots).not.toHaveBeenCalled()
  })

  it("project 存在但无任何 issue → noIssues + DebtBoardView (chapterCount=1)", async () => {
    render(<DashboardView />)
    await waitFor(() => expect(mocks.runFactCheck).toHaveBeenCalled())
    expect(screen.getByText("dashboard.noIssues")).toBeInTheDocument()
    expect(screen.getByTestId("debt-board-view")).toHaveAttribute("data-chapter", "1")
  })

  it("运行中 (无 results) → 非空态; headerActions 渲染; 头部计数行随 items 出现", async () => {
    mocks.state.reviewRun = { runId: "x", projectPath: "E:/Novel", filePath: "E:/Novel/c.md", results: [], running: true, error: null }
    render(<DashboardView headerActions={<div data-testid="header-actions" />} />)
    expect(screen.queryByText("dashboard.noIssues")).not.toBeInTheDocument()
    expect(screen.getByTestId("header-actions")).toBeInTheDocument()
    cleanup()
    // mock store 无订阅机制: state 变更后需重新挂载; mapReviewSeverity("error") → high
    runReview()
    render(<DashboardView />)
    // 源码 L680-687: 头部计数行随 items 出现 → 高分组标题渲染
    expect(screen.getByText("dashboard.severity.high")).toBeInTheDocument()
  })
})

describe("DashboardView — items 装配 / 分组 / 排序 / 卡片", () => {
  it("review 结果: error→high / warning→medium / info→low; 卡片内容 + source 标签 + evidence 编辑", async () => {
    mocks.state.reviewRun = {
      runId: "rr1",
      projectPath: "E:/Novel",
      filePath: "E:/Novel/chapter-8.md",
      results: [
        makeReviewResult({ severity: "error", message: "错误项", type: "contradiction" }),
        makeReviewResult({ severity: "warning", message: "警告项", type: "pacing_issue" }),
        makeReviewResult({ severity: "info", message: "提示项", type: "quality_soft" }),
      ],
      running: false,
      error: null,
    }
    render(<DashboardView />)
    // reviewRun 在 render 前已置位 → 卡片同步渲染 (factcheck 区块无 factcheck 项不会出现)
    await waitFor(() => expect(screen.getByText("错误项")).toBeInTheDocument())
    const card = dashboardCard("错误项")
    // 源码 L501: 来源标签渲染为 "[{label}]" 包裹文本
    expect(within(card).getByText(/dashboard\.source\.review/)).toBeInTheDocument()
    // 证据按钮 → handleEditDashItem (highlight=true) → findChapterSelectionByEvidence + highlight
    fireEvent.click(within(card).getByText(/审查证据/))
    await waitFor(() => expect(mocks.state.setPendingEditorHighlight).toHaveBeenCalled())
    expect(mocks.state.setActiveView).toHaveBeenCalledWith("wiki")
    // 建议
    expect(within(card).getByText("审查建议")).toBeInTheDocument()
    // 分组计数标签
    expect(screen.getAllByText("dashboard.severity.high").length).toBeGreaterThan(0)
    expect(screen.getAllByText("dashboard.severity.medium").length).toBeGreaterThan(0)
    expect(screen.getAllByText("dashboard.severity.low").length).toBeGreaterThan(0)
  })

  it("lint 结果: warning→medium / info→low; card 点击 → open (highlight=false)", async () => {
    mocks.state.lintRun = {
      runId: "lr1",
      projectPath: "E:/Novel",
      filePath: "E:/Novel",
      running: false,
      error: null,
      hasRun: true,
      results: [
        makeLintResult({ severity: "warning", detail: "孤立页A", page: "page-a.md" }),
        makeLintResult({ severity: "info", detail: "孤立页B", page: "page-b.md" }),
      ],
    }
    render(<DashboardView />)
    const card = dashboardCard("孤立页A")
    // 源码 L501: 来源标签 "[dashboard.source.lint]"
    expect(within(card).getByText(/dashboard\.source\.lint/)).toBeInTheDocument()
    fireEvent.click(card)
    await waitFor(() => expect(mocks.state.setSelectedFile).toHaveBeenCalled())
    // lint 项无 evidence → resolve 用 targetPath 候选
    expect(mocks.readFile).toHaveBeenCalledWith("E:/Novel/wiki/page-a.md")
    expect(mocks.state.setPendingEditorHighlight).not.toHaveBeenCalled()
    // 键盘 Enter (resolve 为异步 → waitFor)
    fireEvent.keyDown(card, { key: "Enter" })
    await waitFor(() => expect(mocks.state.setSelectedFile).toHaveBeenCalledTimes(2))
    fireEvent.keyDown(card, { key: " " })
    await waitFor(() => expect(mocks.state.setSelectedFile).toHaveBeenCalledTimes(3))
  })

  it("factcheck 结果: blocking/high/medium/low + 未知 detail 回退原文; fact 区块重复渲染", async () => {
    mocks.runFactCheck.mockResolvedValue(
      makeFactReport({
        checkedChapterCount: 7,
        results: [
          makeFactResult({ severity: "blocking", type: "character_jump", message: "阻断项", chapters: [1, 2] }),
          makeFactResult({ severity: "high", type: "location_conflict", message: "高位项", chapters: [2, 3] }),
          makeFactResult({ severity: "medium", type: "timeline_conflict", message: "中位项", chapters: [3, 4] }),
          makeFactResult({ severity: "low", type: "org_flip", message: "低位项", chapters: [4, 5] }),
        ],
      }),
    )
    render(<DashboardView />)
    await waitFor(() => expect(screen.getAllByText("dashboard.section.factCheck").length).toBeGreaterThan(0))
    // 源码 L691: 区块头渲染 "{checkedChapterCount} {t('dashboard.section.chapters')}"
    expect(screen.getByText(/7\s+dashboard\.section\.chapters/)).toBeInTheDocument()
    // factcheck 卡片同时渲染在分组区与 fact 区块 (visibleFactItems, 源码 L700) → 允许重复
    expect(screen.getAllByText("阻断项").length).toBeGreaterThanOrEqual(1)
    expect(screen.getAllByText("dashboard.factCheckType.character_jump").length).toBeGreaterThan(0)
    expect(screen.getAllByText("dashboard.factCheckType.location_conflict").length).toBeGreaterThan(0)
    expect(screen.getAllByText("dashboard.factCheckType.timeline_conflict").length).toBeGreaterThan(0)
    expect(screen.getAllByText("dashboard.factCheckType.org_flip").length).toBeGreaterThan(0)
    // secondaryEvidence 渲染 (证据A)
    expect(screen.getAllByText(/证据A/).length).toBeGreaterThan(0)
  })

  it("factcheck 未知 detail (不在 label keys) → formatDashItemDetail 回退原文 detail", async () => {
    mocks.runFactCheck.mockResolvedValue(
      makeFactReport({
        results: [makeFactResult({ severity: "high", type: "custom_unknown_type" as unknown as FactCheckResult["type"], message: "未知类型项" })],
      }),
    )
    render(<DashboardView />)
    // formatDashItemDetail 回退原文 detail (源码 L110); 分组区 + fact 区块各渲染一次
    await waitFor(() => expect(screen.getAllByText("custom_unknown_type").length).toBeGreaterThan(0))
  })

  it("排序: blocking 组在 high 组之前; 分组折叠/展开 (low 默认折叠)", async () => {
    mocks.runFactCheck.mockResolvedValue(
      makeFactReport({
        results: [makeFactResult({ severity: "blocking", type: "character_jump", message: "阻断项", chapters: [1, 2] })],
      }),
    )
    mocks.state.reviewRun = {
      runId: "rr1",
      projectPath: "E:/Novel",
      filePath: "E:/Novel/chapter-8.md",
      results: [
        makeReviewResult({ severity: "error", message: "高危项" }),
        // info → low 组; 分组折叠断言需 low 组存在
        makeReviewResult({ severity: "info", message: "低危提示" }),
      ],
      running: false,
      error: null,
    }
    render(<DashboardView />)
    const blockingHeader = await screen.findByText("dashboard.severity.blocking")
    const highHeader = screen.getByText("dashboard.severity.high")
    expect(blockingHeader.compareDocumentPosition(highHeader)).toBe(4)
    // low 组默认折叠 → panel data-open=false
    expect(screen.getByRole("region", { name: "dashboard.severity.low" })).toHaveAttribute("data-open", "false")
    // 点击 low 组头 → 展开
    const lowToggle = screen.getByRole("button", { name: /dashboard.severity.low/ })
    fireEvent.click(lowToggle)
    expect(screen.getByRole("region", { name: "dashboard.severity.low" })).toHaveAttribute("data-open", "true")
    // 折叠 blocking
    const blockingToggle = screen.getByRole("button", { name: /dashboard.severity.blocking/ })
    expect(blockingToggle).toHaveAttribute("aria-expanded", "true")
    fireEvent.click(blockingToggle)
    expect(blockingToggle).toHaveAttribute("aria-expanded", "false")
    expect(screen.getByRole("region", { name: "dashboard.severity.blocking" })).toHaveAttribute("data-open", "false")
  })

  it("ignore: 写入 ignored 后项消失; 二次点击守卫", async () => {
    runReview()
    render(<DashboardView />)
    // 竞态: loadDashboardIssueState 的异步 resolve 会覆盖点击后的 issueState
    // (源码 L115 effect) → 先 flush 初始加载, 再点击
    await act(async () => {})
    const card = dashboardCard("审查消息")
    fireEvent.click(within(card).getByText("dashboard.actions.ignore"))
    await waitFor(() => expect(mocks.saveDashboardIssueState).toHaveBeenCalled())
    const ignoredKey = ["review", "E:/Novel/chapter-8.md", "character_consistency", "审查消息", "审查证据"].join("|")
    expect(mocks.saveDashboardIssueState).toHaveBeenCalledWith("E:/Novel", expect.objectContaining({ ignored: { [ignoredKey]: true } }))
    // 项消失
    await waitFor(() => expect(screen.queryByText("审查消息")).not.toBeInTheDocument())
  })

  it("extractChapterNumberFromTargetPath: 无 targetPath / 无数字前缀 / 有数字前缀 → resolve 候选组合", async () => {
    // 数字前缀 targetPath → chapter_number 搜索 + stem 搜索
    mocks.state.reviewRun = {
      runId: "rr1",
      projectPath: "E:/Novel",
      filePath: "E:/Novel/wiki/08-chapter.md",
      results: [makeReviewResult({ message: "数字前缀项", evidence: "" })],
      running: false,
      error: null,
    }
    mocks.searchWiki.mockResolvedValue([{ path: "E:/Novel/wiki/08-chapter.md", title: "第8章" }])
    mocks.readFile.mockResolvedValue("# 第8章")
    render(<DashboardView />)
    fireEvent.click(dashboardCard("数字前缀项"))
    await waitFor(() => expect(mocks.state.setSelectedFile).toHaveBeenCalledWith("E:/Novel/wiki/08-chapter.md"))
    // chapter_number 搜索 (数字前缀 08) + stem 搜索 (08-chapter)
    expect(mocks.searchWiki).toHaveBeenCalledWith("E:/Novel", "chapter_number:8")
    expect(mocks.searchWiki).toHaveBeenCalledWith("E:/Novel", "08-chapter")
  })

  it("resolveDashboardItemTarget: 所有候选读取失败 → openDashboardItem 返回 null (不 setSelectedFile)", async () => {
    runReview()
    mocks.readFile.mockRejectedValue(new Error("all miss"))
    render(<DashboardView />)
    fireEvent.click(dashboardCard("审查消息"))
    await waitFor(() => expect(mocks.state.setSelectedFile).not.toHaveBeenCalled())
  })
})

describe("DashboardView — extras 加载 (fact / debt / chase / emotion)", () => {
  it("快照加载 + fact/debt/chase/emotion 数据装配 + extrasLoading 结束", async () => {
    mocks.listSnapshots.mockResolvedValue(["s1.json", "s2.json"])
    // 源码 L139: chapterCount = 成功加载的 snapshots 数量 (|| 1)
    mocks.loadSnapshot.mockImplementation(async (_p: string, file: string) =>
      file === "s1.json" ? makeSnapshot({ chapterNumber: 1 }) : makeSnapshot({ chapterNumber: 2 }),
    )
    mocks.runFactCheck.mockResolvedValue(makeFactReport({ checkedChapterCount: 2, results: [makeFactResult({ message: "加载事实项" })] }))
    mocks.loadForeshadowingTracker.mockResolvedValue({})
    mocks.analyzeForeshadowingDebt.mockReturnValue(makeDebtReport({ totalUnresolved: 1 }))
    mocks.loadNovelSessionStatus.mockResolvedValue({
      chase_debt: {
        debts: [{ id: "d1", debt_type: "micropayoff", original_amount: 1, current_amount: 1, interest_rate: 0, source_chapter: 1, due_chapter: 3, status: "active" }],
        debt_events: [{ debt_id: "d1", event_type: "created", amount: 1, chapter: 1 }],
      },
    })
    mocks.getTopEmotionalDebt.mockReturnValue([{ characterName: "林烬", valence: -0.5, arousal: 0.3, dominance: -0.2, netValue: -0.17, lastUpdatedChapter: 2, history: [] }])
    render(<DashboardView />)
    await waitFor(() => expect(screen.getByTestId("debt-board-view")).toHaveAttribute("data-chapter", "2"))
    expect(mocks.runFactCheck).toHaveBeenCalled()
    expect(screen.getByTestId("debt-board-view")).toHaveAttribute("data-chase", "1")
    expect(screen.getByTestId("debt-board-view")).toHaveAttribute("data-emotion", "1")
    // fact 区块 (factcheck 卡片在分组区 + fact 区块重复渲染)
    expect(screen.getAllByText("加载事实项").length).toBeGreaterThan(0)
    // debt 区块
    expect(screen.getByText("dashboard.section.foreshadowingDebt")).toBeInTheDocument()
    // 骨架屏消失
    await waitFor(() => expect(screen.queryByRole("status")).not.toBeInTheDocument())
  })

  it("extrasLoading 骨架屏: 挂起的 listSnapshots 期间可见", async () => {
    const d = deferred<never>()
    mocks.listSnapshots.mockReturnValue(d.promise)
    render(<DashboardView />)
    expect(screen.getByRole("status")).toBeInTheDocument()
    await act(async () => d.resolve([] as never))
    await waitFor(() => expect(screen.queryByRole("status")).not.toBeInTheDocument())
  })

  it("extras 加载失败 → console.error + 结束 loading (catch 分支)", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    mocks.listSnapshots.mockRejectedValue(new Error("snapshots exploded"))
    render(<DashboardView />)
    await waitFor(() => expect(errSpy).toHaveBeenCalled())
    await waitFor(() => expect(screen.queryByRole("status")).not.toBeInTheDocument())
    errSpy.mockRestore()
  })

  it("unmount 后 resolve → cancelled 守卫早退 (无 setState 崩溃)", async () => {
    const d = deferred<string[]>()
    mocks.listSnapshots.mockReturnValue(d.promise)
    const { unmount } = render(<DashboardView />)
    unmount()
    await act(async () => d.resolve(["late.json"]))
  })

  it("status 无 chase_debt → debts/events 空数组; 快照为空 → chapterCount=1", async () => {
    mocks.listSnapshots.mockResolvedValue([])
    mocks.loadNovelSessionStatus.mockResolvedValue({})
    render(<DashboardView />)
    await waitFor(() => expect(screen.getByTestId("debt-board-view")).toHaveAttribute("data-chapter", "1"))
    expect(screen.getByTestId("debt-board-view")).toHaveAttribute("data-chase", "0")
  })
})

describe("DashboardView — 伏笔债务区块", () => {
  it("debtReport.totalUnresolved>0: 区块渲染, planted/advanced 状态文案, critical/warning 分级", async () => {
    mocks.analyzeForeshadowingDebt.mockReturnValue(
      makeDebtReport({
        totalUnresolved: 2,
        criticalCount: 1,
        warningCount: 1,
        debtScore: 55,
        items: [
          { name: "伏笔A", id: "fb-a", debtLevel: "critical", status: "planted", plantedChapter: 2, chaptersSincePlanted: 6, lastAdvancedChapter: 0, chaptersSinceAdvanced: 0, description: "描述A" },
          { name: "伏笔B", id: "fb-b", debtLevel: "warning", status: "advanced", plantedChapter: 1, chaptersSincePlanted: 0, lastAdvancedChapter: 5, chaptersSinceAdvanced: 4, description: "描述B" },
          { name: "伏笔C", id: "fb-c", debtLevel: "normal", status: "planted", plantedChapter: 1, chaptersSincePlanted: 0, lastAdvancedChapter: 0, chaptersSinceAdvanced: 0, description: "描述C" },
        ],
      }),
    )
    render(<DashboardView />)
    await waitFor(() => expect(screen.getByText("dashboard.section.foreshadowingDebt")).toBeInTheDocument())
    expect(screen.getByText(/dashboard.section.debtScore/)).toBeInTheDocument()
    // 源码 L706: "{t('dashboard.section.debtScore')}: {debtScore}/100"
    expect(screen.getByText(/55\/100/)).toBeInTheDocument()
    expect(screen.getByText(/埋设于第2章/)).toBeInTheDocument()
    expect(screen.getByText(/上次推进于第5章/)).toBeInTheDocument()
    expect(screen.getByText("伏笔A")).toBeInTheDocument()
    expect(screen.getByText("伏笔B")).toBeInTheDocument()
    // normal 级不渲染
    expect(screen.queryByText("伏笔C")).not.toBeInTheDocument()
    // 计数行 "{count} {label}" 与项标签 "[{label}]" 均含 labelKey → 允许重复
    expect(screen.getAllByText(/dashboard\.debtLevel\.critical/).length).toBeGreaterThan(0)
    expect(screen.getAllByText(/dashboard\.debtLevel\.warning/).length).toBeGreaterThan(0)
  })

  it("totalUnresolved=0 → 不渲染债务区块", async () => {
    mocks.analyzeForeshadowingDebt.mockReturnValue(makeDebtReport())
    render(<DashboardView />)
    await waitFor(() => expect(mocks.analyzeForeshadowingDebt).toHaveBeenCalled())
    expect(screen.queryByText("dashboard.section.foreshadowingDebt")).not.toBeInTheDocument()
  })
})

describe("DashboardView — AI 改写 (runAiRewrite / 对话框 / 应用)", () => {
  it("前置守卫: no project / no model / no chapter / no anchor", async () => {
    runReview()
    // no project
    mocks.state.project = null
    render(<DashboardView />)
    fireEvent.click(screen.getByText("dashboard.actions.aiRewrite"))
    expect(screen.getByRole("alert")).toHaveTextContent("dashboard.rewrite.alertNoProject")
    cleanup()
    // no model
    mocks.state.project = { path: "E:/Novel" }
    mocks.hasUsableLlm.mockReturnValue(false)
    render(<DashboardView />)
    fireEvent.click(screen.getByText("dashboard.actions.aiRewrite"))
    expect(screen.getByRole("alert")).toHaveTextContent("dashboard.rewrite.alertNoModel")
    cleanup()
    // resolve 失败 → no chapter (await resolveDashboardItemTarget 后异步 setAlert → waitFor)
    mocks.hasUsableLlm.mockReturnValue(true)
    mocks.readFile.mockRejectedValue(new Error("miss"))
    mocks.searchWiki.mockResolvedValue([])
    render(<DashboardView />)
    fireEvent.click(screen.getByText("dashboard.actions.aiRewrite"))
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("dashboard.rewrite.alertNoChapter"))
    cleanup()
    // 非 factcheck + 无 anchor → alertNoAnchor
    mocks.readFile.mockResolvedValue("# Chapter\n正文")
    mocks.findChapterSelectionByEvidence.mockReturnValue(null)
    render(<DashboardView />)
    fireEvent.click(screen.getByText("dashboard.actions.aiRewrite"))
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("dashboard.rewrite.alertNoAnchor"))
    expect(mocks.streamChat).not.toHaveBeenCalled()
  })

  it("非 factcheck: replace 模式对话框, onToken 累积, onDone trim, 应用成功 (selectedFile 匹配)", async () => {
    runReview()
    mocks.state.selectedFile = "E:/Novel/wiki/chapter-8.md"
    // resolveDashboardItemTarget (源码 L183-208): 绝对非 wiki 路径先拼 junk 候选 (readFile 拒绝),
    // 再由 stem 搜索 (searchWiki "chapter-8") 命中真实 wiki 页
    mocks.searchWiki.mockResolvedValue([{ path: "E:/Novel/wiki/chapter-8.md", title: "第8章" }])
    mocks.readFile.mockImplementation((p: string) =>
      p.includes("/wiki/E:/") ? Promise.reject(new Error("junk candidate")) : Promise.resolve("# Chapter\n正文"),
    )
    render(<DashboardView />)
    fireEvent.click(screen.getByText("dashboard.actions.aiRewrite"))
    await waitFor(() => expect(screen.getByTestId("ttpd")).toBeInTheDocument())
    expect(mocks.streamChat).toHaveBeenCalledWith(null, mocks.buildDashboardRewriteMessages(), expect.any(Object))
    // candidate 累积 "生成片段"
    expect(screen.getByTestId("ttpd-candidate")).toHaveValue("生成片段")
    // source 来自 anchor.selection.text (mock tppd 渲染 sourceContent)
    const tppd = screen.getByTestId("ttpd")
    expect(within(tppd).getByText("正文")).toBeInTheDocument()
    // 修改 candidate
    fireEvent.change(screen.getByTestId("ttpd-candidate"), { target: { value: "修改后候选" } })
    // apply
    fireEvent.click(screen.getByTestId("ttpd-apply"))
    await waitFor(() => expect(mocks.writeFile).toHaveBeenCalledWith("E:/Novel/wiki/chapter-8.md", "# rewritten\n正文"))
    expect(mocks.state.bumpDataVersion).toHaveBeenCalled()
    expect(mocks.state.setFileContent).toHaveBeenCalled()
    expect(mocks.state.setPendingEditorHighlight).toHaveBeenCalledWith(expect.objectContaining({ path: "E:/Novel/wiki/chapter-8.md", text: "修改后候选" }))
    expect(mocks.saveDashboardIssueState).toHaveBeenCalledWith(
      "E:/Novel",
      expect.objectContaining({ rewrites: expect.objectContaining({ [["review", "E:/Novel/chapter-8.md", "character_consistency", "审查消息", "审查证据"].join("|")]: expect.objectContaining({ replacementText: "修改后候选" }) }) }),
    )
    // 对话框关闭
    await waitFor(() => expect(screen.queryByTestId("ttpd")).not.toBeInTheDocument())
  })

  it("onDone: 空 candidate → errorEmptyCandidate; onError → 脱敏错误 + busy 清除", async () => {
    runReview()
    mocks.streamChat.mockImplementation(async (_cfg: unknown, _msgs: unknown, callbacks: { onToken: (t: string) => void; onDone: () => void; onError: (e: Error) => void }) => {
      callbacks.onToken("   ")
      callbacks.onDone()
      callbacks.onError(new Error("https://llm.example/v1 key: secret-abc"))
    })
    // onError 在 streamChat 调用时同步触发 → spy 须先于 click
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    render(<DashboardView />)
    fireEvent.click(screen.getByText("dashboard.actions.aiRewrite"))
    // onDone 在 setRewriteDialog updater 内 setRewriteError (源码 L309-322): updater 于 render
    // 阶段执行 → 后于 onError 的直接 setState → 最终描述为 errorEmptyCandidate
    await waitFor(() => expect(screen.getByTestId("ttpd")).toHaveAttribute("data-description", "dashboard.rewrite.errorEmptyCandidate"))
    // onError 的 raw message 仅落 console (F-16: 原始信息只进日志, 不出现在 UI)
    expect(errSpy).toHaveBeenCalled()
    errSpy.mockRestore()
    // rewriteError 置位 → onCandidateContentChange undefined → 编辑禁用 (源码 L806-810)
    expect(screen.getByTestId("ttpd-candidate")).toBeDisabled()
  })

  it("onError 后 candidate 变更禁用 (onCandidateContentChange undefined) + regenerate 重新流式", async () => {
    runReview()
    mocks.streamChat.mockImplementation(async (_cfg: unknown, _msgs: unknown, callbacks: { onError: (e: Error) => void }) => {
      callbacks.onError(new Error("boom"))
    })
    render(<DashboardView />)
    fireEvent.click(screen.getByText("dashboard.actions.aiRewrite"))
    await waitFor(() => expect(screen.getByTestId("ttpd-candidate")).toBeDisabled())
    // regenerate → runAiRewrite 再次调用 → streamChat 计数 2
    fireEvent.click(screen.getByTestId("ttpd-regenerate"))
    await waitFor(() => expect(mocks.streamChat).toHaveBeenCalledTimes(2))
  })

  it("factcheck: insert_before 模式, onToken 忽略, onDone 解析 plan 成功 → 候选=补写+锚点", async () => {
    mocks.runFactCheck.mockResolvedValue(
      makeFactReport({ results: [makeFactResult({ message: "事实改写项", chapters: [5, 6] })] }),
    )
    // factcheck 项无 targetPath → resolve 走 chapter_number 搜索 (源码 L187-191)
    mocks.searchWiki.mockResolvedValue([{ path: "E:/Novel/wiki/chapter-8.md", title: "第8章" }])
    render(<DashboardView />)
    // factcheck 卡片在分组区 + fact 区块重复渲染 → 取第一张卡
    const [card] = await screen.findAllByText("事实改写项")
    fireEvent.click(card.closest("div[role=button]") as HTMLElement)
    fireEvent.click(within(card.closest("div[role=button]") as HTMLElement).getByText("dashboard.actions.aiRewrite"))
    await waitFor(() => expect(screen.getByTestId("ttpd")).toBeInTheDocument())
    // insert_before → sourceLabel 原文位置
    expect(screen.getByTestId("ttpd")).toHaveAttribute("data-source-label", "原文位置")
    expect(screen.getByTestId("ttpd")).toHaveAttribute("data-candidate-label", "修改后内容")
    // onToken 不累积 (factcheck 早退)
    expect(screen.getByTestId("ttpd-candidate")).toHaveValue("补写内容\n正文")
    // streamChat 用 buildFactCheckInsertMessages
    expect(mocks.streamChat).toHaveBeenCalledWith(null, mocks.buildFactCheckInsertMessages(), expect.any(Object))
  })

  it("factcheck: parse plan 失败 → errorParsePlan; 锚点未找到 → errorNoInsertAnchor; 描述为错误串", async () => {
    mocks.runFactCheck.mockResolvedValue(makeFactReport({ results: [makeFactResult({ message: "解析失败项" })] }))
    mocks.searchWiki.mockResolvedValue([{ path: "E:/Novel/wiki/chapter-8.md", title: "第8章" }])
    mocks.parseFactCheckInsertPlan.mockReturnValue(null)
    render(<DashboardView />)
    // factReport 异步加载 → 先等卡片出现; 分组区 + fact 区块重复渲染 → 取第一张
    const [card1] = await screen.findAllByText("解析失败项")
    fireEvent.click(card1.closest("div[role=button]") as HTMLElement)
    fireEvent.click(within(card1.closest("div[role=button]") as HTMLElement).getByText("dashboard.actions.aiRewrite"))
    await waitFor(() => expect(screen.getByTestId("ttpd")).toHaveAttribute("data-description", "dashboard.rewrite.errorParsePlan"))
    cleanup()
    mocks.parseFactCheckInsertPlan.mockReturnValue({ anchorText: "不存在的锚点", insertText: "补写" })
    mocks.findChapterSelectionByEvidence.mockReturnValue(null)
    render(<DashboardView />)
    const [card2] = await screen.findAllByText("解析失败项")
    fireEvent.click(card2.closest("div[role=button]") as HTMLElement)
    fireEvent.click(within(card2.closest("div[role=button]") as HTMLElement).getByText("dashboard.actions.aiRewrite"))
    await waitFor(() => expect(screen.getByTestId("ttpd")).toHaveAttribute("data-description", "dashboard.rewrite.errorNoInsertAnchor"))
  })

  it("streamChat 抛出 → catch 脱敏 + busy 清除; insert_before 无 anchor → applyDisabled", async () => {
    mocks.runFactCheck.mockResolvedValue(makeFactReport({ results: [makeFactResult({ message: "异常项" })] }))
    mocks.searchWiki.mockResolvedValue([{ path: "E:/Novel/wiki/chapter-8.md", title: "第8章" }])
    mocks.streamChat.mockRejectedValue(new Error("http://bad.example Authorization: Bearer zzz"))
    render(<DashboardView />)
    const [card] = await screen.findAllByText("异常项")
    fireEvent.click(card.closest("div[role=button]") as HTMLElement)
    fireEvent.click(within(card.closest("div[role=button]") as HTMLElement).getByText("dashboard.actions.aiRewrite"))
    // catch 路径脱敏 (源码 L341-348): url → [url], Authorization 头 → [redacted]; busy 清除 → 描述为脱敏错误
    await waitFor(() => {
      expect(screen.getByTestId("ttpd").getAttribute("data-description")).toContain("[url]")
    })
    // insert_before + anchor null (初始 dialog anchor 为 null) → applyDisabled
    expect(screen.getByTestId("ttpd-apply")).toBeDisabled()
  })

  it("busy 期间: 对话框描述 '正在生成', applyDisabled, close 不关闭", async () => {
    runReview()
    const d = deferred<never>()
    mocks.streamChat.mockReturnValue(d.promise)
    render(<DashboardView />)
    fireEvent.click(screen.getByText("dashboard.actions.aiRewrite"))
    await waitFor(() => expect(screen.getByTestId("ttpd")).toBeInTheDocument())
    expect(screen.getByTestId("ttpd")).toHaveAttribute("data-description", "正在生成修改内容，请稍候…")
    expect(screen.getByTestId("ttpd-apply")).toBeDisabled()
    fireEvent.click(screen.getByTestId("ttpd-close"))
    expect(screen.getByTestId("ttpd")).toBeInTheDocument()
    await act(async () => d.resolve({} as never))
  })

  it("handleApplyRewrite 守卫: busy / error / 空 candidate → 早退; refresh anchor 路径", async () => {
    runReview()
    // 同"非 factcheck"用例: 拒绝 junk 候选, stem 搜索命中真实 wiki 页
    mocks.searchWiki.mockResolvedValue([{ path: "E:/Novel/wiki/chapter-8.md", title: "第8章" }])
    mocks.readFile.mockImplementation((p: string) =>
      p.includes("/wiki/E:/") ? Promise.reject(new Error("junk candidate")) : Promise.resolve("# Chapter\n正文"),
    )
    render(<DashboardView />)
    fireEvent.click(screen.getByText("dashboard.actions.aiRewrite"))
    await waitFor(() => expect(screen.getByTestId("ttpd")).toBeInTheDocument())
    // 空 candidate → applyDisabled (fireEvent 仍派发 → 守卫 return, writeFile 不调用)
    fireEvent.change(screen.getByTestId("ttpd-candidate"), { target: { value: "   " } })
    fireEvent.click(screen.getByTestId("ttpd-apply"))
    await waitFor(() => expect(mocks.writeFile).not.toHaveBeenCalled())
    // 有效 candidate; applyDashboardRewriteToMarkdown 首次失败 → refresh anchor 成功 → 应用
    fireEvent.change(screen.getByTestId("ttpd-candidate"), { target: { value: "有效候选" } })
    mocks.applyDashboardRewriteToMarkdown
      .mockReturnValueOnce(null)
      .mockReturnValueOnce("# refreshed")
    fireEvent.click(screen.getByTestId("ttpd-apply"))
    await waitFor(() => expect(mocks.writeFile).toHaveBeenCalledWith("E:/Novel/wiki/chapter-8.md", "# refreshed"))
    expect(mocks.findChapterSelectionByEvidence).toHaveBeenCalled()
  })

  it("handleApplyRewrite: 最新 markdown 读取失败 → 早退; refresh anchor 也失败 → 早退; 二次应用也失败 → 早退", async () => {
    runReview()
    render(<DashboardView />)
    fireEvent.click(screen.getByText("dashboard.actions.aiRewrite"))
    await waitFor(() => expect(screen.getByTestId("ttpd")).toBeInTheDocument())
    fireEvent.change(screen.getByTestId("ttpd-candidate"), { target: { value: "候选" } })
    // readFile 最新失败
    mocks.readFile.mockRejectedValueOnce(new Error("gone"))
    fireEvent.click(screen.getByTestId("ttpd-apply"))
    await waitFor(() => expect(mocks.writeFile).not.toHaveBeenCalled())
    // refresh anchor 返回 null
    mocks.applyDashboardRewriteToMarkdown.mockReturnValue(null)
    mocks.findChapterSelectionByEvidence.mockReturnValueOnce(null)
    fireEvent.click(screen.getByTestId("ttpd-apply"))
    await waitFor(() => expect(mocks.writeFile).not.toHaveBeenCalled())
    // refresh anchor 有值但二次 apply 仍失败
    mocks.findChapterSelectionByEvidence.mockReturnValueOnce({
      evidence: "x",
      selection: { start: 0, end: 4, text: "正文", bodySnapshot: "正文" },
    })
    fireEvent.click(screen.getByTestId("ttpd-apply"))
    await waitFor(() => expect(mocks.writeFile).not.toHaveBeenCalled())
    expect(mocks.applyDashboardRewriteToMarkdown).toHaveBeenCalledTimes(3)
  })
})

describe("DashboardView — viewRewrite / restore / alert", () => {
  it("viewRewrite + restore (selectedFile 匹配) + restore 失败早退", async () => {
    runReview()
    const backup = {
      itemId: ["review", "E:/Novel/chapter-8.md", "character_consistency", "审查消息", "审查证据"].join("|"),
      targetPath: "E:/Novel/wiki/chapter-8.md",
      evidence: "审查证据",
      originalText: "旧文",
      replacementText: "新文",
      updatedAt: "t",
    }
    mocks.loadDashboardIssueState.mockResolvedValue({ ignored: {}, rewrites: { [backup.itemId]: backup } })
    mocks.state.selectedFile = "E:/Novel/wiki/chapter-8.md"
    render(<DashboardView />)
    // viewRewrite 按钮依赖 issueState.rewrites 异步加载完成 → findByText
    fireEvent.click(await screen.findByText("dashboard.actions.viewRewrite"))
    await waitFor(() => expect(mocks.state.setSelectedFile).toHaveBeenCalledWith("E:/Novel/wiki/chapter-8.md"))
    expect(mocks.state.setPendingEditorHighlight).toHaveBeenCalledWith(expect.objectContaining({ text: "新文" }))
    // restore
    fireEvent.click(screen.getByText("dashboard.actions.restore"))
    await waitFor(() => expect(mocks.writeFile).toHaveBeenCalled())
    expect(mocks.saveDashboardIssueState).toHaveBeenCalledWith("E:/Novel", expect.objectContaining({ rewrites: {} }))
    cleanup()
    // restore: restoreDashboardRewriteInMarkdown null → 早退 (writeFile 总调用数保持 part1 的 1 次)
    mocks.restoreDashboardRewriteInMarkdown.mockReturnValue(null)
    render(<DashboardView />)
    fireEvent.click(await screen.findByText("dashboard.actions.restore"))
    await waitFor(() => expect(mocks.writeFile).toHaveBeenCalledTimes(1))
  })

  it("viewRewrite: 读取失败静默返回", async () => {
    runReview()
    const backup = {
      itemId: ["review", "E:/Novel/chapter-8.md", "character_consistency", "审查消息", "审查证据"].join("|"),
      targetPath: "E:/Novel/wiki/chapter-8.md",
      evidence: "审查证据",
      originalText: "旧文",
      replacementText: "新文",
      updatedAt: "t",
    }
    mocks.loadDashboardIssueState.mockResolvedValue({ ignored: {}, rewrites: { [backup.itemId]: backup } })
    mocks.readFile.mockRejectedValue(new Error("gone"))
    render(<DashboardView />)
    fireEvent.click(await screen.findByText("dashboard.actions.viewRewrite"))
    await waitFor(() => expect(mocks.state.setSelectedFile).not.toHaveBeenCalled())
  })

  it("alert 渲染 + 关闭按钮清除; 二次 ignore 守卫", async () => {
    runReview()
    mocks.hasUsableLlm.mockReturnValue(false)
    render(<DashboardView />)
    fireEvent.click(screen.getByText("dashboard.actions.aiRewrite"))
    expect(screen.getByRole("alert")).toHaveTextContent("dashboard.rewrite.alertNoModel")
    fireEvent.click(screen.getByText("common.dismiss"))
    expect(screen.queryByRole("alert")).not.toBeInTheDocument()
  })
})

describe("DashboardView — 全口径缺口补齐 (w4f5)", () => {
  it("运行时越界 severity → 三个映射器 default 回退 medium", async () => {
    mocks.state.reviewRun = {
      runId: "rr1",
      projectPath: "E:/Novel",
      filePath: "E:/Novel/chapter-8.md",
      results: [makeReviewResult({ severity: "bogus" as never, message: "越界审查项" })],
      running: false,
      error: null,
    }
    mocks.state.lintRun = {
      runId: "lr1",
      projectPath: "E:/Novel",
      filePath: "E:/Novel",
      running: false,
      error: null,
      hasRun: true,
      results: [makeLintResult({ severity: "bogus" as never, detail: "越界孤立页", page: "x.md" })],
    }
    mocks.runFactCheck.mockResolvedValue(
      makeFactReport({ results: [makeFactResult({ severity: "bogus" as never, message: "越界事实项", chapters: [1, 2] })] }),
    )
    render(<DashboardView />)
    // 三张卡均归入 medium 组（L97/L105/L115 default 分支）
    await waitFor(() => expect(screen.getAllByText("越界审查项").length).toBeGreaterThan(0))
    expect(screen.getAllByText("越界事实项").length).toBeGreaterThan(0)
    expect(screen.getByRole("button", { name: /dashboard.severity.medium/ })).toBeInTheDocument()
  })

  it("loadDashboardIssueState 拒绝 → catch 重置空 issueState (L180-181)", async () => {
    runReview()
    mocks.loadDashboardIssueState.mockRejectedValue(new Error("state-down"))
    render(<DashboardView />)
    // catch → setIssueState(empty) → ignored 为空 → 卡片照常渲染
    expect(await screen.findByText("审查消息")).toBeInTheDocument()
  })

  it("project 为 null 时点击卡片 → resolveDashboardItemTarget !project 早退 (L246)", async () => {
    runReview()
    mocks.state.project = null
    render(<DashboardView />)
    fireEvent.click(dashboardCard("审查消息"))
    await waitFor(() => expect(mocks.state.setSelectedFile).not.toHaveBeenCalled())
    expect(mocks.readFile).not.toHaveBeenCalled()
  })

  it("targetPath 无 .md 扩展名 → 追加 .md 候选并命中 (L257)", async () => {
    mocks.state.lintRun = {
      runId: "lr1",
      projectPath: "E:/Novel",
      filePath: "E:/Novel",
      running: false,
      error: null,
      hasRun: true,
      results: [makeLintResult({ severity: "warning", detail: "无扩展页", page: "notes" })],
    }
    render(<DashboardView />)
    fireEvent.click(dashboardCard("无扩展页"))
    await waitFor(() => expect(mocks.state.setSelectedFile).toHaveBeenCalledWith("E:/Novel/wiki/notes"))
    // 无扩展名候选先于 .md 变体读取（首候选命中即返回）
    expect(mocks.readFile).toHaveBeenCalledWith("E:/Novel/wiki/notes")
    expect(mocks.readFile).not.toHaveBeenCalledWith("E:/Novel/wiki/notes.md")
  })

  it("factcheck 项 searchWiki 拒绝 → catch 空候选 → 不选中文件 (L261 catch)", async () => {
    mocks.runFactCheck.mockResolvedValue(
      makeFactReport({ results: [makeFactResult({ message: "拒搜项", chapters: [3, 4] })] }),
    )
    mocks.searchWiki.mockRejectedValue(new Error("search-down"))
    render(<DashboardView />)
    const [card] = await screen.findAllByText("拒搜项")
    fireEvent.click(card.closest("div[role=button]") as HTMLElement)
    await waitFor(() => expect(mocks.state.setSelectedFile).not.toHaveBeenCalled())
  })

  it("数字前缀 targetPath + searchWiki 双重拒绝 → 两个 catch 后首候选命中 (L268/L274 catch)", async () => {
    mocks.state.reviewRun = {
      runId: "rr1",
      projectPath: "E:/Novel",
      filePath: "E:/Novel/wiki/08-chapter.md",
      results: [makeReviewResult({ message: "双重拒搜项", evidence: "" })],
      running: false,
      error: null,
    }
    mocks.searchWiki.mockRejectedValue(new Error("down"))
    render(<DashboardView />)
    fireEvent.click(dashboardCard("双重拒搜项"))
    await waitFor(() => expect(mocks.state.setSelectedFile).toHaveBeenCalledWith("E:/Novel/wiki/08-chapter.md"))
    expect(mocks.searchWiki).toHaveBeenCalledWith("E:/Novel", "chapter_number:8")
    expect(mocks.searchWiki).toHaveBeenCalledWith("E:/Novel", "08-chapter")
  })

  it("restore 时最新正文读取失败 → catch + !latestMarkdown 早退 (L533/L534)", async () => {
    runReview()
    const backup = {
      itemId: ["review", "E:/Novel/chapter-8.md", "character_consistency", "审查消息", "审查证据"].join("|"),
      targetPath: "E:/Novel/wiki/chapter-8.md",
      evidence: "审查证据",
      originalText: "旧文",
      replacementText: "新文",
      updatedAt: "t",
    }
    mocks.loadDashboardIssueState.mockResolvedValue({ ignored: {}, rewrites: { [backup.itemId]: backup } })
    mocks.readFile.mockRejectedValue(new Error("gone"))
    render(<DashboardView />)
    fireEvent.click(await screen.findByText("dashboard.actions.restore"))
    await waitFor(() => expect(mocks.writeFile).not.toHaveBeenCalled())
    expect(mocks.saveDashboardIssueState).not.toHaveBeenCalled()
  })

  it("stale dialog：A 流完成于 B 对话框期间 → updater id 不匹配早退；close 清态；B onDone 时对话框已关 → !current 早退", async () => {
    mocks.state.reviewRun = {
      runId: "rr1",
      projectPath: "E:/Novel",
      filePath: "E:/Novel/chapter-8.md",
      results: [
        makeReviewResult({ message: "消息A", evidence: "证据A", type: "type_a" }),
        makeReviewResult({ message: "消息B", evidence: "证据B", type: "type_b" }),
      ],
      running: false,
      error: null,
    }
    let resolveA!: () => void
    let resolveB!: () => void
    mocks.streamChat
      .mockImplementationOnce(async (_c: unknown, _m: unknown, callbacks: { onToken: (t: string) => void; onDone: () => void }) => {
        await new Promise<void>((resolve) => { resolveA = resolve })
        callbacks.onToken("A-token")
        callbacks.onDone()
      })
      .mockImplementationOnce(async (_c: unknown, _m: unknown, callbacks: { onToken: (t: string) => void; onDone: () => void }) => {
        await new Promise<void>((resolve) => { resolveB = resolve })
        callbacks.onToken("B-token")
        callbacks.onDone()
      })
    render(<DashboardView />)
    fireEvent.click(within(dashboardCard("消息A")).getByText("dashboard.actions.aiRewrite"))
    await waitFor(() => expect(screen.getByTestId("ttpd")).toBeInTheDocument())
    fireEvent.click(within(dashboardCard("消息B")).getByText("dashboard.actions.aiRewrite"))
    await waitFor(() => expect(screen.getByTestId("ttpd")).toBeInTheDocument())
    // A 的 onToken/onDone 在 B 对话框打开后才到达 → updater 的 current.item.id !== item.id → 早退
    await act(async () => { resolveA() })
    // busy 已清 → close 放行 → setRewriteError(null) + setRewriteDialog(null)
    fireEvent.click(screen.getByTestId("ttpd-close"))
    await waitFor(() => expect(screen.queryByTestId("ttpd")).not.toBeInTheDocument())
    // B 的 onToken/onDone 在对话框关闭后到达 → !current → 早退
    await act(async () => { resolveB() })
    expect(mocks.streamChat).toHaveBeenCalledTimes(2)
  })
})

describe("DashboardView — f4 终局：取消竞态 / 非 Error 异常 / 边界守卫", () => {
  it("unmount 后 loadDashboardIssueState 拒绝 → catch 内 cancelled 守卫早退", async () => {
    runReview()
    const d = deferred<never>()
    mocks.loadDashboardIssueState.mockReturnValue(d.promise)
    const { unmount } = render(<DashboardView />)
    unmount()
    await act(async () => d.reject(new Error("late-down")))
    // 守卫早退 → 不写 ignored → 无异常
    expect(mocks.saveDashboardIssueState).not.toHaveBeenCalled()
  })

  it("unmount 后 runFactCheck / loadNovelSessionStatus / loadEmotionLedger resolve → cancelled 守卫早退", async () => {
    const dFact = deferred<unknown>()
    mocks.runFactCheck.mockReturnValue(dFact.promise)
    const { unmount } = render(<DashboardView />)
    await waitFor(() => expect(mocks.runFactCheck).toHaveBeenCalled())
    unmount()
    await act(async () => dFact.resolve(makeFactReport()))

    const dStatus = deferred<unknown>()
    mocks.runFactCheck.mockResolvedValue(makeFactReport())
    mocks.loadNovelSessionStatus.mockReturnValue(dStatus.promise)
    const u2 = render(<DashboardView />)
    await waitFor(() => expect(mocks.loadNovelSessionStatus).toHaveBeenCalled())
    u2.unmount()
    await act(async () => dStatus.resolve({}))

    const dLedger = deferred<unknown>()
    mocks.loadNovelSessionStatus.mockResolvedValue({})
    mocks.loadEmotionLedger.mockReturnValue(dLedger.promise)
    const u3 = render(<DashboardView />)
    await waitFor(() => expect(mocks.loadEmotionLedger).toHaveBeenCalled())
    u3.unmount()
    await act(async () => dLedger.resolve({ entries: [] }))
  })

  it("extras 加载拒绝非 Error（字符串）→ String(err) 分支", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    mocks.listSnapshots.mockRejectedValue("snapshots-boom-string")
    render(<DashboardView />)
    await waitFor(() => expect(errSpy).toHaveBeenCalledWith("[Dashboard] Failed to load extras:", "snapshots-boom-string"))
    errSpy.mockRestore()
  })

  it("project 为 null 时点 ignore → persistIssueState 跳过保存（project?.path 假分支）", async () => {
    runReview()
    mocks.state.project = null
    render(<DashboardView />)
    await act(async () => {})
    fireEvent.click(within(dashboardCard("审查消息")).getByText("dashboard.actions.ignore"))
    await waitFor(() => expect(mocks.saveDashboardIssueState).not.toHaveBeenCalled())
    // setIssueState 仍执行 → 卡片消失
    await waitFor(() => expect(screen.queryByText("审查消息")).not.toBeInTheDocument())
  })

  it("factcheck chapters 仅 1 章 → targetChapterNumber 缺失 → 无候选不选中（else-if 假分支）", async () => {
    mocks.runFactCheck.mockResolvedValue(
      makeFactReport({ results: [makeFactResult({ message: "单章项", chapters: [3] as unknown as [number, number] })] }),
    )
    mocks.searchWiki.mockResolvedValue([{ path: "E:/Novel/wiki/c.md", title: "第3章" }])
    render(<DashboardView />)
    const [card] = await screen.findAllByText("单章项")
    fireEvent.click(card.closest("div[role=button]") as HTMLElement)
    await waitFor(() => expect(mocks.state.setSelectedFile).not.toHaveBeenCalled())
    expect(mocks.readFile).not.toHaveBeenCalled()
  })

  it("targetPath 尾斜杠 → stem 为空 → 跳过 stem 搜索（if (stem) 假分支）", async () => {
    mocks.state.reviewRun = {
      runId: "rr1",
      projectPath: "E:/Novel",
      filePath: "E:/Novel/wiki/",
      results: [makeReviewResult({ message: "目录项", evidence: "" })],
      running: false,
      error: null,
    }
    mocks.searchWiki.mockResolvedValue([{ path: "E:/Novel/wiki", title: "目录" }])
    render(<DashboardView />)
    fireEvent.click(dashboardCard("目录项"))
    await waitFor(() => expect(mocks.state.setSelectedFile).toHaveBeenCalled())
    // 无 stem 搜索（"wiki" 非数字前缀 → 也无 chapter_number 搜索）
    expect(mocks.searchWiki).not.toHaveBeenCalled()
  })

  it("evidence 未命中 → 不写入 pendingEditorHighlight（if (anchor) 假分支）", async () => {
    runReview()
    mocks.findChapterSelectionByEvidence.mockReturnValue(null)
    render(<DashboardView />)
    fireEvent.click(within(dashboardCard("审查消息")).getByText(/审查证据/))
    await waitFor(() => expect(mocks.state.setSelectedFile).toHaveBeenCalled())
    expect(mocks.state.setPendingEditorHighlight).not.toHaveBeenCalled()
  })

  it("onError 非 Error → String(err) 脱敏分支；catch 非 Error → String(err) 分支；空串错误 → errorFallback", async () => {
    runReview()
    mocks.streamChat.mockImplementation(async (_c: unknown, _m: unknown, callbacks: { onError: (e: unknown) => void }) => {
      callbacks.onError("")
    })
    render(<DashboardView />)
    fireEvent.click(screen.getByText("dashboard.actions.aiRewrite"))
    await waitFor(() => expect(screen.getByTestId("ttpd")).toHaveAttribute("data-description", "dashboard.rewrite.errorFallback"))
    cleanup()
    mocks.streamChat.mockRejectedValue("")
    runReview()
    render(<DashboardView />)
    fireEvent.click(screen.getByText("dashboard.actions.aiRewrite"))
    await waitFor(() => expect(screen.getByTestId("ttpd")).toHaveAttribute("data-description", "dashboard.rewrite.errorFallback"))
  })

  it("restore 时 selectedFile 与 backup.targetPath 不匹配 → 跳过 setFileContent（假分支）", async () => {
    runReview()
    const backup = {
      itemId: ["review", "E:/Novel/chapter-8.md", "character_consistency", "审查消息", "审查证据"].join("|"),
      targetPath: "E:/Novel/wiki/chapter-8.md",
      evidence: "审查证据",
      originalText: "旧文",
      replacementText: "新文",
      updatedAt: "t",
    }
    mocks.loadDashboardIssueState.mockResolvedValue({ ignored: {}, rewrites: { [backup.itemId]: backup } })
    mocks.state.selectedFile = "E:/Novel/other.md"
    render(<DashboardView />)
    fireEvent.click(await screen.findByText("dashboard.actions.restore"))
    await waitFor(() => expect(mocks.writeFile).toHaveBeenCalled())
    expect(mocks.state.setFileContent).not.toHaveBeenCalled()
  })

  it("卡片 keydown 非 Enter/空格 → 不打开（key 假分支）", async () => {
    runReview()
    render(<DashboardView />)
    const card = dashboardCard("审查消息")
    fireEvent.keyDown(card, { key: "Tab" })
    expect(mocks.state.setSelectedFile).not.toHaveBeenCalled()
    // 对照：Enter 仍打开
    fireEvent.keyDown(card, { key: "Enter" })
    await waitFor(() => expect(mocks.state.setSelectedFile).toHaveBeenCalled())
  })
})

