// @vitest-environment jsdom
/**
 * W4B2 coverage campaign — ReviewCenterSidebarPanel 全口径 100%。
 * 所有 store / 外部依赖均 vi.mock，参考 src/App.spec.tsx 的 vi.hoisted 可写 state 模式。
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest"
import { cleanup as rtlCleanup } from "@testing-library/react"
import { render, screen, fireEvent, waitFor, within, act, setupDomGlobals } from "@/test-helpers/component-test-utils"

const mocks = vi.hoisted(() => {
  const t = vi.fn((key: string, opts?: Record<string, unknown>) =>
    opts ? `${key}::${JSON.stringify(opts)}` : key,
  )
  return {
    t,
    // ---- wiki store state ----
    state: {
      project: null as { id: string; name: string; path: string } | null,
      selectedFile: null as string | null,
      selectedReviewDimension: null as string | null,
      selectedReviewFilePath: "",
      reviewRun: null as unknown,
      thrilSoftGateAcknowledgedByChapter: {} as Record<string, boolean>,
      novelConfig: { outlineThrillSoftGateEnabled: true },
      setSelectedReviewDimension: vi.fn(),
      setSelectedReviewFilePath: vi.fn(),
      setThrillSoftGateAcknowledged: vi.fn(),
    },
    // ---- fs ----
    listDirectory: vi.fn(),
    readFile: vi.fn(),
    // ---- chapter-utils / frontmatter ----
    flattenMdFiles: vi.fn(),
    parseFrontmatter: vi.fn(),
    // ---- measurement fingerprint ----
    formatMeasurementFingerprintSummary: vi.fn(() => `fingerprint-summary`),
    // ---- outline-thrill-checkpoints ----
    getOutlineThrillSoftGateRuntimeStatus: vi.fn(),
    isThrillSoftGateAcknowledged: vi.fn(),
    thrilAckChapterKey: vi.fn((chapter?: number | null) =>
      chapter == null || !Number.isFinite(chapter) ? "0" : String(Math.trunc(chapter)),
    ),
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
  listDirectory: mocks.listDirectory,
  readFile: mocks.readFile,
}))

vi.mock("@/lib/novel/chapter-utils", () => ({
  flattenMdFiles: mocks.flattenMdFiles,
}))

vi.mock("@/lib/frontmatter", () => ({
  parseFrontmatter: mocks.parseFrontmatter,
}))

vi.mock("@/components/layout/panel-header-with-help", () => ({
  PanelHeaderWithHelp: ({ title }: { title: string }) => <span>{title}</span>,
}))

vi.mock("@/lib/novel/dimension-review-adapter", () => ({
  SIX_REVIEW_DIMENSION_ORDER: ["consistency", "character", "continuity", "thrill", "pacing", "pull"],
  SIX_REVIEW_DIMENSIONS: {
    consistency: { key: "consistency", label: "一致性" },
    character: { key: "character", label: "人物" },
    continuity: { key: "continuity", label: "连续性" },
    thrill: { key: "thrill", label: "张力" },
    pacing: { key: "pacing", label: "节奏" },
    pull: { key: "pull", label: "吸引力" },
  },
}))

vi.mock("@/lib/novel/measurement-fingerprint", () => ({
  formatMeasurementFingerprintSummary: mocks.formatMeasurementFingerprintSummary,
}))

vi.mock("@/lib/novel/outline-thrill-checkpoints", () => ({
  THRILL_CHECKPOINT_ORDER: ["crisis_info_early", "pressure_release", "protagonist_agency", "chapter_end_hook", "fix1_no_conflict"],
  THRILL_CHECKPOINT_LABELS: {
    crisis_info_early: "危机信息",
    pressure_release: "压抑释放",
    protagonist_agency: "主角能动",
    chapter_end_hook: "章末钩",
    fix1_no_conflict: "FIX-1 无冲突",
  },
  getOutlineThrillSoftGateRuntimeStatus: mocks.getOutlineThrillSoftGateRuntimeStatus,
  isThrillSoftGateAcknowledged: mocks.isThrillSoftGateAcknowledged,
  thrilAckChapterKey: mocks.thrilAckChapterKey,
}))

import { ReviewCenterSidebarPanel } from "./review-center-sidebar-panel"

const PROJECT = { id: "p1", name: "Novel", path: "/proj" }
const CHAPTERS_TREE = [{ name: "chapters", path: "/proj/wiki/chapters", is_dir: true, children: [] }]

function defaultThrilStatus(overrides: Record<string, unknown> = {}) {
  return {
    enabled: true,
    chapterKey: "3",
    acknowledged: false,
    fix1Blocked: false,
    allStructuralOk: false,
    passCount: 0,
    failCount: 0,
    unknownCount: 5,
    mayContinueGeneration: true,
    productHardGate: false,
    results: [
      { id: "crisis_info_early", status: "unknown", label: "危机信息" },
      { id: "pressure_release", status: "unknown", label: "压抑释放" },
      { id: "protagonist_agency", status: "unknown", label: "主角能动" },
      { id: "chapter_end_hook", status: "unknown", label: "章末钩" },
      { id: "fix1_no_conflict", status: "unknown", label: "FIX-1 无冲突" },
    ],
    thinking: "",
    ...overrides,
  }
}

function mockChapterOptions(files: Array<{ name: string; path: string }>) {
  mocks.listDirectory.mockResolvedValue(CHAPTERS_TREE)
  mocks.flattenMdFiles.mockReturnValue(files)
  mocks.readFile.mockResolvedValue("content")
  mocks.parseFrontmatter.mockReturnValue({ frontmatter: {}, body: "" })
}

/** 渲染并冲刷异步 effect（章节选项 / outline 预览），避免 act 警告。 */
async function renderPanel() {
  const view = render(<ReviewCenterSidebarPanel />)
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0))
  })
  return view
}

beforeEach(() => {
  vi.clearAllMocks()
  setupDomGlobals()
  mocks.state.project = PROJECT
  mocks.state.selectedFile = null
  mocks.state.selectedReviewDimension = null
  mocks.state.selectedReviewFilePath = "/proj/wiki/chapters/3.md"
  mocks.state.reviewRun = null
  mocks.state.thrilSoftGateAcknowledgedByChapter = {}
  mocks.state.novelConfig = { outlineThrillSoftGateEnabled: true }
  mocks.getOutlineThrillSoftGateRuntimeStatus.mockReturnValue(defaultThrilStatus())
  mocks.isThrillSoftGateAcknowledged.mockImplementation(
    (ackMap: Record<string, boolean> | null | undefined, chapter?: number | null) =>
      Boolean(ackMap?.[mocks.thrilAckChapterKey(chapter)]),
  )
})

afterEach(() => {
  rtlCleanup()
  vi.restoreAllMocks()
})

describe("ReviewCenterSidebarPanel", () => {
  it("无项目时渲染标题与空章节选项，thril 门关闭时显示 off", () => {
    mocks.state.project = null
    mocks.state.novelConfig = { outlineThrillSoftGateEnabled: false }
    render(<ReviewCenterSidebarPanel />)

    expect(screen.getByText("reviewCenter.title")).toBeInTheDocument()
    expect(screen.getByText("reviewCenter.noChapterAvailable")).toBeInTheDocument()
    expect(screen.getByText(/outlineThrillSoftGateEnabled/)).toBeInTheDocument()
    expect(mocks.state.setSelectedReviewFilePath).toHaveBeenCalledWith("")
  })

  it("章节选项加载：listDirectory 拒绝时清空选项并重置选中路径", async () => {
    mocks.listDirectory.mockRejectedValue(new Error("boom"))
    render(<ReviewCenterSidebarPanel />)
    await waitFor(() => expect(mocks.state.setSelectedReviewFilePath).toHaveBeenCalledWith(""))
  })

  it("章节选项加载：选中文件匹配优先，frontmatter 标题/heading 标题回退", async () => {
    mocks.listDirectory.mockResolvedValue(CHAPTERS_TREE)
    mocks.flattenMdFiles.mockReturnValue([
      { name: "1.md", path: "/proj/wiki/chapters/1.md" },
      { name: "2.md", path: "/proj/wiki/chapters/2.md" },
    ])
    mocks.parseFrontmatter
      .mockReturnValueOnce({ frontmatter: { title: "第一章标题" }, body: "# H" })
      .mockReturnValueOnce({ frontmatter: {}, body: "# 第二章标题\n正文" })
    mocks.readFile.mockResolvedValue("content")
    mocks.state.selectedFile = "/proj/wiki/chapters/2.md"

    render(<ReviewCenterSidebarPanel />)
    await waitFor(() =>
      expect(mocks.state.setSelectedReviewFilePath).toHaveBeenCalledWith("/proj/wiki/chapters/2.md"),
    )
    expect(screen.getByText("第一章标题")).toBeInTheDocument()
    expect(screen.getByText("第二章标题")).toBeInTheDocument()
  })

  it("章节选项加载：readFile 失败回退文件名；store 内已有选中路径优先", async () => {
    mocks.listDirectory.mockResolvedValue(CHAPTERS_TREE)
    mocks.flattenMdFiles.mockReturnValue([
      { name: "5.md", path: "/proj/wiki/chapters/5.md" },
      { name: "6.md", path: "/proj/wiki/chapters/6.md" },
    ])
    mocks.readFile.mockRejectedValue(new Error("missing"))
    mocks.state.selectedFile = null
    mocks.state.selectedReviewFilePath = "/proj/wiki/chapters/6.md"

    render(<ReviewCenterSidebarPanel />)
    await waitFor(() =>
      expect(mocks.state.setSelectedReviewFilePath).toHaveBeenCalledWith("/proj/wiki/chapters/6.md"),
    )
    expect(screen.getByText("5")).toBeInTheDocument()
    expect(screen.getByText("6")).toBeInTheDocument()
  })

  it("章节选项加载：都无匹配时回退第一个选项", async () => {
    mockChapterOptions([{ name: "9.md", path: "/proj/wiki/chapters/9.md" }])
    mocks.state.selectedFile = "/proj/wiki/chapters/other.md"
    mocks.state.selectedReviewFilePath = ""
    render(<ReviewCenterSidebarPanel />)
    await waitFor(() =>
      expect(mocks.state.setSelectedReviewFilePath).toHaveBeenCalledWith("/proj/wiki/chapters/9.md"),
    )
  })

  it("章节下拉：reviewRun 运行中禁用，变更触发 setSelectedReviewFilePath", async () => {
    mockChapterOptions([{ name: "1.md", path: "/proj/wiki/chapters/1.md" }])
    mocks.state.reviewRun = { running: true }
    mocks.state.selectedFile = null
    mocks.state.selectedReviewFilePath = ""
    const view = render(<ReviewCenterSidebarPanel />)
    await waitFor(() => expect(screen.getByRole("combobox")).toBeDisabled())
    view.unmount()

    mocks.state.reviewRun = null
    render(<ReviewCenterSidebarPanel />)
    await waitFor(() => {
      fireEvent.change(screen.getByRole("combobox"), { target: { value: "/proj/wiki/chapters/1.md" } })
    })
    expect(mocks.state.setSelectedReviewFilePath).toHaveBeenCalledWith("/proj/wiki/chapters/1.md")
  })

  it("AI 审稿与角色命中报告按钮切换维度", async () => {
    await renderPanel()
    fireEvent.click(screen.getByRole("button", { name: /reviewCenter\.aiReview/ }))
    expect(mocks.state.setSelectedReviewDimension).toHaveBeenCalledWith("ai-review")
    fireEvent.click(screen.getByRole("button", { name: /角色命中报告/ }))
    expect(mocks.state.setSelectedReviewDimension).toHaveBeenCalledWith("character-report")
  })

  it("AI 审稿 / 角色命中报告 / 维度选中态高亮分支", async () => {
    mocks.state.selectedReviewDimension = "ai-review"
    const v1 = await renderPanel()
    expect(v1.container.querySelector(".qm-selected")).not.toBeNull()
    v1.unmount()
    mocks.state.selectedReviewDimension = "character-report"
    const v2 = await renderPanel()
    expect(v2.container.querySelector(".qm-selected")).not.toBeNull()
    v2.unmount()
  })

  it("六维 Track A/B 按钮切换维度，计数徽章与运行中维度标签", async () => {
    mocks.state.selectedReviewDimension = "continuity"
    mocks.state.reviewRun = {
      running: true,
      activeDimension: "consistency",
      dimensionResults: {
        consistency: { issues: [{ severity: "error", message: "x" }] },
        character: { issues: [{ severity: "warning", message: "y" }] },
        continuity: { issues: [{ severity: "info", message: "z" }] },
        thrill: { issues: [{ severity: "error", message: "t" }] },
      },
    }
    await renderPanel()

    fireEvent.click(screen.getByRole("button", { name: /reviewCenter\.dimension\.consistency/ }))
    expect(mocks.state.setSelectedReviewDimension).toHaveBeenCalledWith("consistency")
    fireEvent.click(screen.getByRole("button", { name: /reviewCenter\.dimension\.thrill/ }))
    expect(mocks.state.setSelectedReviewDimension).toHaveBeenCalledWith("thrill")
    // Track A 选中高亮（selectedReviewDimension=continuity）
    expect(
      screen.getByRole("button", { name: /reviewCenter\.dimension\.continuity/ }).className,
    ).toContain("qm-selected")
    // 计数徽章：consistency/character/continuity/thrill 各 1 条 issue（章节下拉的 option 也可能含 "1"，须限定在维度按钮内）
    const dimButtons = screen.getAllByRole("button", { name: /reviewCenter\.dimension\./ })
    const badgeCount = dimButtons.filter((b) => within(b).queryByText("1")).length
    expect(badgeCount).toBe(4)
    // 运行中维度标签
    expect(screen.getByText("一致性")).toBeInTheDocument()
    expect(mocks.t).toHaveBeenCalledWith("reviewCenter.stats", {
      blocking: 0,
      high: 2,
      medium: 1,
      low: 1,
    })
  })

  it("Track B 维度选中高亮 + 运行中标签（activeDimension=thrill）", async () => {
    mocks.state.selectedReviewDimension = "thrill"
    mocks.state.reviewRun = { running: true, activeDimension: "thrill" }
    const view = await renderPanel()
    const thrillBtn = screen.getByRole("button", { name: /reviewCenter\.dimension\.thrill/ })
    expect(thrillBtn.className).toContain("qm-selected")
    expect(screen.getByText("张力")).toBeInTheDocument()
    view.unmount()
  })

  it("章节号解析 branch-1：path 中 /数字/ 形式；超长数字 Number 溢出返回 null", async () => {
    mocks.state.selectedReviewFilePath = "/proj/wiki/chapters/7/outline.md"
    await renderPanel()
    expect(mocks.getOutlineThrillSoftGateRuntimeStatus).toHaveBeenCalledWith(
      expect.objectContaining({ chapter: 7 }),
    )
    mocks.state.selectedReviewFilePath = "/proj/Chapter" + "9".repeat(400)
    const v2 = await renderPanel()
    expect(mocks.getOutlineThrillSoftGateRuntimeStatus).toHaveBeenCalledWith(
      expect.objectContaining({ chapter: null }),
    )
    v2.unmount()
  })

  it("章节选项为空时回退 options[0]?.path ?? '' 的兜底", async () => {
    mocks.listDirectory.mockResolvedValue(CHAPTERS_TREE)
    mocks.flattenMdFiles.mockReturnValue([])
    mocks.state.selectedFile = null
    mocks.state.selectedReviewFilePath = ""
    await renderPanel()
    expect(mocks.state.setSelectedReviewFilePath).toHaveBeenCalledWith("")
  })

  it("listDirectory 挂起期间卸载：then/catch 的 cancelled 分支", async () => {
    // then 分支：卸载后 resolve
    let resolveThen!: (v: unknown) => void
    mocks.listDirectory.mockReturnValue(new Promise((res) => { resolveThen = res }))
    const v1 = render(<ReviewCenterSidebarPanel />)
    v1.unmount()
    await act(async () => { resolveThen(CHAPTERS_TREE) })
    expect(mocks.flattenMdFiles).not.toHaveBeenCalled()
    // catch 分支：卸载后 reject
    let rejectCatch!: (e: Error) => void
    mocks.listDirectory.mockReturnValue(new Promise((_res, rej) => { rejectCatch = rej }))
    const v2 = render(<ReviewCenterSidebarPanel />)
    v2.unmount()
    await act(async () => { rejectCatch(new Error("late")) })
    expect(mocks.state.setSelectedReviewFilePath).not.toHaveBeenCalled()
  })

  it("outline 预览挂起期间卸载：cancelled 分支覆盖", async () => {
    mocks.state.selectedReviewFilePath = "/proj/wiki/chapters/3.md"
    let resolveRead!: (v: string) => void
    mocks.readFile.mockReturnValue(new Promise((res) => { resolveRead = res }))
    const view = render(<ReviewCenterSidebarPanel />)
    view.unmount()
    // 卸载后 readFile 才 resolve → cancelled=true，跳过 setOutlinePreviewText
    await act(async () => { resolveRead("正文") })
    expect(mocks.getOutlineThrillSoftGateRuntimeStatus).toHaveBeenCalledWith(
      expect.objectContaining({ outlineText: "" }),
    )
  })

  it("thril 门：results 为空时回退 THRILL_CHECKPOINT_ORDER 默认列表", async () => {
    mocks.getOutlineThrillSoftGateRuntimeStatus.mockReturnValue(defaultThrilStatus({ results: [] }))
    await renderPanel()
    expect(screen.getAllByText("?")).toHaveLength(5)
    expect(screen.getByText("危机信息")).toBeInTheDocument()
    expect(screen.getByText("FIX-1 无冲突")).toBeInTheDocument()
  })

  it("thril 门：fix1Blocked 徽章 + pass/fail/unknown 字形 + 证据 + ack 切换", async () => {
    mocks.getOutlineThrillSoftGateRuntimeStatus.mockReturnValue(
      defaultThrilStatus({
        fix1Blocked: true,
        results: [
          { id: "crisis_info_early", status: "pass", label: "危机信息", evidence: "有危机" },
          { id: "pressure_release", status: "fail", label: "压抑释放" },
          { id: "protagonist_agency", status: "unknown", label: "主角能动" },
          { id: "chapter_end_hook", status: "pass", label: "章末钩" },
          { id: "fix1_no_conflict", status: "fail", label: "FIX-1 无冲突" },
        ],
      }),
    )
    mocks.state.selectedReviewFilePath = "/proj/wiki/chapters/3/outline.md"
    await renderPanel()

    expect(screen.getByText("novel.settings.outlineThrillFix1Blocked")).toBeInTheDocument()
    expect(screen.queryByText("novel.settings.outlineThrillAllOk")).not.toBeInTheDocument()
    expect(screen.getAllByText("✓")).toHaveLength(2)
    expect(screen.getAllByText("!")).toHaveLength(2)
    expect(screen.getAllByText("?")).toHaveLength(1)
    expect(screen.getByText("有危机")).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: /outlineThrillAckButton/ }))
    expect(mocks.state.setThrillSoftGateAcknowledged).toHaveBeenCalledWith(3, true)
  })

  it("thril 门：allStructuralOk 徽章（fix1Blocked=false）+ 已确认 ack 按钮文案", async () => {
    mocks.getOutlineThrillSoftGateRuntimeStatus.mockReturnValue(
      defaultThrilStatus({ fix1Blocked: false, allStructuralOk: true }),
    )
    mocks.state.thrilSoftGateAcknowledgedByChapter = { "3": true }
    await renderPanel()
    expect(screen.getByText("novel.settings.outlineThrillAllOk")).toBeInTheDocument()
    expect(screen.queryByText("novel.settings.outlineThrillFix1Blocked")).not.toBeInTheDocument()
    expect(screen.getByRole("button", { name: /outlineThrillAckDone/ })).toBeInTheDocument()
  })

  it("thril 门：章节号解析 branch-2（Chapter-3）与 outline 预览候选文件读取", async () => {
    mocks.state.selectedReviewFilePath = "/proj/Chapter-3-Outline.md"
    mocks.readFile.mockImplementation((path: string) =>
      path.includes("Chapter-3-Outline.md") ? Promise.resolve("大纲正文") : Promise.reject(new Error("no")),
    )
    await renderPanel()
    await waitFor(() => {
      expect(mocks.getOutlineThrillSoftGateRuntimeStatus).toHaveBeenCalledWith(
        expect.objectContaining({ outlineText: "大纲正文", chapter: 3 }),
      )
    })
  })

  it("thril 门：outline 预览空内容继续下一候选，全部失败清空；无章节号直接清空", async () => {
    mocks.state.selectedReviewFilePath = "/proj/foo.md"
    mocks.readFile.mockResolvedValue("")
    await renderPanel()
    await waitFor(() => {
      expect(mocks.getOutlineThrillSoftGateRuntimeStatus).toHaveBeenCalledWith(
        expect.objectContaining({ outlineText: "" }),
      )
    })
  })

  it("measurement fingerprint：存在时渲染摘要与徽章，缺失时显示空态", async () => {
    mocks.state.reviewRun = {
      measurementFingerprint: {
        shape: { outlineChars: 120, styleExemplarCount: 3, recentChapterCount: 5 },
        packKind: "context-pack-v1",
      },
    }
    const view = await renderPanel()
    expect(screen.getByText("fingerprint-summary")).toBeInTheDocument()
    expect(screen.getByText(/outline 120/)).toBeInTheDocument()
    expect(screen.getByText(/ex 3/)).toBeInTheDocument()
    expect(screen.getByText(/recent 5/)).toBeInTheDocument()
    expect(screen.getByText("context-pack-v1")).toBeInTheDocument()
    view.unmount()

    // shape 缺失字段 / packKind 为空 → ?? 0 回退 + packKind 徽章不渲染
    mocks.state.reviewRun = { measurementFingerprint: { shape: {} } }
    const v2 = render(<ReviewCenterSidebarPanel />)
    expect(screen.getByText(/outline 0/)).toBeInTheDocument()
    expect(screen.getByText(/ex 0/)).toBeInTheDocument()
    expect(screen.getByText(/recent 0/)).toBeInTheDocument()
    expect(screen.queryByText("context-pack-v1")).not.toBeInTheDocument()
    v2.unmount()

    mocks.state.reviewRun = null
    render(<ReviewCenterSidebarPanel />)
    expect(screen.getByText("reviewCenter.measurementFingerprintEmpty")).toBeInTheDocument()
  })
})
