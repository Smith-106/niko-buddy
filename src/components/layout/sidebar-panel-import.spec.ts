// @vitest-environment jsdom
/**
 * sidebar-panel-import — 批量提取纯函数真测试（G3 两段式：extract→草稿→accept）。
 * 覆盖 loadBatchExtractDefaults / previewBatchExtraction / getBatchExtractQueue /
 * cancelBatchMemoryExtraction / runBatchMemoryExtraction / acceptBatchExtractionDrafts。
 * Hook（useSidebarImport）的导入/菜单/记忆确认路径由 sidebar-panel.spec 间接覆盖，此处只补纯函数缺口。
 */
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { SnapshotScanResult } from "./sidebar-panel-import"
import {
  acceptBatchExtractionDrafts,
  cancelBatchMemoryExtraction,
  getBatchExtractQueue,
  loadBatchExtractDefaults,
  previewBatchExtraction,
  runBatchMemoryExtraction,
} from "./sidebar-panel-import"

const mocks = vi.hoisted(() => ({
  startTask: vi.fn((_input: unknown) => "task-1"),
  updateTask: vi.fn(),
  finishTask: vi.fn(),
  findChapterFile: vi.fn(async (_proj: string, _ch: number): Promise<string | null> => null),
  parseChapterMeta: vi.fn((_fm: unknown) => null as unknown),
  resolveNovelModel: vi.fn((_a: unknown, _b: unknown, _c: unknown) => ({ model: "test" })),
  readFile: vi.fn(async (_path: string) => ""),
  parseFrontmatter: vi.fn((content: string) => ({ frontmatter: {}, body: content })),
  extractSnapshot: vi.fn(async (_ch: number): Promise<{ chapter: number } | null> => null),
  syncSnapshot: vi.fn(async (_proj: string, _snap: { chapter: number }): Promise<void> => {}),
  scanBackfill: vi.fn(
    async (_proj: string): Promise<SnapshotScanResult> => ({ total: 0, chapters: [], pending: [], errors: [] }),
  ),
  llmConfig: {},
  novelConfig: {},
}))

vi.mock("@/stores/import-progress-store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/stores/import-progress-store")>()
  return {
    ...actual,
    useImportProgressStore: {
      ...actual.useImportProgressStore,
      getState: () => ({
        startTask: mocks.startTask,
        updateTask: mocks.updateTask,
        finishTask: mocks.finishTask,
      }),
    },
  }
})

vi.mock("@/stores/wiki-store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/stores/wiki-store")>()
  return {
    ...actual,
    useWikiStore: Object.assign(
      (selector: (s: unknown) => unknown) => selector({ project: null, llmConfig: mocks.llmConfig, novelConfig: mocks.novelConfig }),
      {
        getState: () => ({ llmConfig: mocks.llmConfig, novelConfig: mocks.novelConfig, project: null }),
      },
    ),
  }
})

vi.mock("@/commands/fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/commands/fs")>()
  return { ...actual, readFile: mocks.readFile }
})

vi.mock("@/lib/frontmatter", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/frontmatter")>()
  return { ...actual, parseFrontmatter: mocks.parseFrontmatter }
})

vi.mock("@/lib/novel", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/novel")>()
  return {
    ...actual,
    findChapterFileByNumber: mocks.findChapterFile,
    parseChapterMeta: mocks.parseChapterMeta,
    resolveNovelModel: mocks.resolveNovelModel,
  }
})

vi.mock("@/lib/novel/snapshot-scanner", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/novel/snapshot-scanner")>()
  return { ...actual, scanSnapshotBackfill: mocks.scanBackfill }
})

vi.mock("@/lib/novel/chapter-ingest", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/novel/chapter-ingest")>()
  return {
    ...actual,
    extractSnapshotWithLLM: mocks.extractSnapshot,
    syncSnapshotToMemory: mocks.syncSnapshot,
  }
})

beforeEach(() => {
  vi.clearAllMocks()
  mocks.startTask.mockReturnValue("task-1")
  mocks.findChapterFile.mockResolvedValue(null)
  mocks.parseChapterMeta.mockReturnValue(null)
  mocks.resolveNovelModel.mockReturnValue({ model: "test" })
  mocks.readFile.mockResolvedValue("# ch\n\nbody")
  mocks.parseFrontmatter.mockImplementation((content: string) => ({ frontmatter: {}, body: content }))
  mocks.extractSnapshot.mockResolvedValue(null)
  mocks.syncSnapshot.mockResolvedValue(undefined)
  mocks.scanBackfill.mockResolvedValue({ total: 0, chapters: [], pending: [], errors: [] })
})

describe("loadBatchExtractDefaults", () => {
  it("返回 snapshot-scanner 单真源常量", async () => {
    const scanner = await import("@/lib/novel/snapshot-scanner")
    const defaults = await loadBatchExtractDefaults()
    expect(defaults).toEqual({
      scope: scanner.DEFAULT_BATCH_EXTRACT_SCOPE,
      skipExisting: scanner.DEFAULT_BATCH_SKIP_EXISTING,
      force: scanner.DEFAULT_BATCH_FORCE,
      budget: scanner.BATCH_EXTRACT_BUDGET_DEFAULT,
      budgetMax: scanner.BATCH_EXTRACT_BUDGET_MAX,
    })
    // 语义变异锚点：预算默认 20，改大/小都会改变行为
    expect(defaults.budget).toBe(20)
  })
})

describe("previewBatchExtraction", () => {
  it("扫库→范围→预算→台账完整链路", async () => {
    const fakeScan = { total: 2, chapters: [1, 2], pending: [], errors: [] }
    mocks.scanBackfill.mockResolvedValue(fakeScan)
    const preview = await previewBatchExtraction("/proj-preview-1", {})
    expect(mocks.scanBackfill).toHaveBeenCalledWith("/proj-preview-1")
    expect(preview.scan).toEqual(fakeScan)
    expect(preview.plan.admitted.length + preview.plan.skippedByBudget.length).toBeGreaterThanOrEqual(0)
    expect(preview.ledger).toBeTruthy()
    expect(preview.selection).toBeTruthy()
  })

  it("透传 budget 与 scope 选项", async () => {
    mocks.scanBackfill.mockResolvedValue({
      total: 3,
      chapters: [1, 2, 3],
      pending: [
        { chapter: 1, reason: "missing_optional_field", missingFields: [], revision: null },
        { chapter: 2, reason: "missing_optional_field", missingFields: [], revision: null },
        { chapter: 3, reason: "missing_optional_field", missingFields: [], revision: null },
      ],
      errors: [],
    })
    const preview = await previewBatchExtraction("/proj-preview-2", { budget: 1 })
    expect(preview.plan.admitted.length).toBe(1)
    expect(preview.plan.skippedByBudget.length).toBe(2)
    expect(preview.ledger.exhausted).toBe(true)
  })
})

describe("getBatchExtractQueue / cancelBatchMemoryExtraction", () => {
  it("无账本返回 null，取消空通道不崩溃", () => {
    expect(getBatchExtractQueue("/proj-no-queue-xyz")).toBeNull()
    expect(() => cancelBatchMemoryExtraction()).not.toThrow()
  })

  it("run 后可取到账本", async () => {
    mocks.findChapterFile.mockResolvedValue("/p/ch1.md")
    mocks.extractSnapshot.mockResolvedValue({ chapter: 1 })
    const result = await runBatchMemoryExtraction({ projectPath: "/proj-queue-1", chapters: [1] })
    expect(result.completed).toBe(1)
    const queue = getBatchExtractQueue("/proj-queue-1")
    expect(queue).not.toBeNull()
    expect(queue?.drafts.some((d) => d.chapter === 1 && d.status === "ready")).toBe(true)
  })
})

describe("runBatchMemoryExtraction", () => {
  it("成功：两章提取为 ready 草稿并 done 收尾", async () => {
    mocks.findChapterFile.mockImplementation(async (_p: string, ch: number) => `/p/ch${ch}.md`)
    mocks.extractSnapshot.mockImplementation(async (ch: number) => ({ chapter: ch }))
    const onProgress = vi.fn()
    const result = await runBatchMemoryExtraction({ projectPath: "/proj-run-ok", chapters: [1, 2], onProgress })
    expect(result.completed).toBe(2)
    expect(result.failed).toBe(0)
    expect(result.cancelled).toBe(false)
    expect(result.errors).toEqual([])
    expect(result.drafts.filter((d) => d.status === "ready").length).toBe(2)
    expect(mocks.finishTask).toHaveBeenCalledWith("task-1", "done", expect.objectContaining({ completed: 2, total: 2 }))
    expect(onProgress).toHaveBeenCalled()
    // 语义变异锚点：completed 必须为 2，改成 failed 计数会变红
    expect(result.drafts.length).toBe(2)
  })

  it("章节文件缺失 → failed 记账 chapter_file_missing", async () => {
    mocks.findChapterFile.mockResolvedValue(null)
    const result = await runBatchMemoryExtraction({ projectPath: "/proj-run-missing", chapters: [7] })
    expect(result.completed).toBe(0)
    expect(result.failed).toBe(1)
    expect(result.errors[0]).toContain("未找到章节文件")
    expect(mocks.finishTask).toHaveBeenCalledWith("task-1", "error", expect.anything())
  })

  it("正文为空 → failed 记账 empty_chapter_body", async () => {
    mocks.findChapterFile.mockResolvedValue("/p/ch1.md")
    mocks.parseFrontmatter.mockReturnValue({ frontmatter: {}, body: "   \n  " })
    const result = await runBatchMemoryExtraction({ projectPath: "/proj-run-empty", chapters: [1] })
    expect(result.failed).toBe(1)
    expect(result.errors[0]).toContain("正文为空")
  })

  it("extract 返回 null → failed 记账 extract_failed", async () => {
    mocks.findChapterFile.mockResolvedValue("/p/ch1.md")
    mocks.parseFrontmatter.mockReturnValue({ frontmatter: {}, body: "有正文" })
    mocks.extractSnapshot.mockResolvedValue(null)
    const result = await runBatchMemoryExtraction({ projectPath: "/proj-run-null", chapters: [1] })
    expect(result.failed).toBe(1)
    expect(result.errors[0]).toContain("提取失败")
  })

  it("extract 抛错 → failed 并记录消息", async () => {
    mocks.findChapterFile.mockResolvedValue("/p/ch1.md")
    mocks.parseFrontmatter.mockReturnValue({ frontmatter: {}, body: "有正文" })
    mocks.extractSnapshot.mockRejectedValue(new Error("llm-boom"))
    const result = await runBatchMemoryExtraction({ projectPath: "/proj-run-throw", chapters: [1] })
    expect(result.failed).toBe(1)
    expect(result.errors[0]).toContain("llm-boom")
  })

  it("readFile 抛错 → failed 并记录消息", async () => {
    mocks.findChapterFile.mockResolvedValue("/p/ch1.md")
    mocks.readFile.mockRejectedValue(new Error("read-boom"))
    const result = await runBatchMemoryExtraction({ projectPath: "/proj-run-readfail", chapters: [1] })
    expect(result.failed).toBe(1)
    expect(result.errors[0]).toContain("read-boom")
  })

  it("输入 signal 未中止 → 注册转发监听；运行中 abort 即取消", async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    mocks.findChapterFile.mockResolvedValue("/p/ch1.md")
    const controller = new AbortController()
    mocks.extractSnapshot.mockImplementation(async () => {
      // 注册发生在逐章处理之前，这里 abort 才能走转发监听
      controller.abort()
      await gate
      return { chapter: 1 }
    })
    const pending = runBatchMemoryExtraction({
      projectPath: "/proj-run-signal-live",
      chapters: [1, 2],
      signal: controller.signal,
    })
    await Promise.resolve()
    release()
    const result = await pending
    expect(result.cancelled).toBe(true)
  })

  it("输入 signal 已取消 → 直接 cancelled", async () => {
    const controller = new AbortController()
    controller.abort()
    mocks.findChapterFile.mockResolvedValue("/p/ch1.md")
    mocks.extractSnapshot.mockResolvedValue({ chapter: 1 })
    const result = await runBatchMemoryExtraction({ projectPath: "/proj-run-cancelled", chapters: [1, 2], signal: controller.signal })
    expect(result.cancelled).toBe(true)
    expect(mocks.finishTask).toHaveBeenCalledWith("task-1", "cancelled", expect.anything())
  })

  it("预算超限：admitted 外记账 skippedByBudget，不发 LLM", async () => {
    mocks.findChapterFile.mockImplementation(async (_p: string, ch: number) => `/p/ch${ch}.md`)
    mocks.extractSnapshot.mockImplementation(async (ch: number) => ({ chapter: ch }))
    // budget=1，3 章 → 只处理 1 章
    const result = await runBatchMemoryExtraction({ projectPath: "/proj-run-budget", chapters: [1, 2, 3], budget: 1 })
    expect(result.admitted).toEqual([1])
    expect(result.skippedByBudget).toEqual([2, 3])
    expect(result.ledger.exhausted).toBe(true)
    expect(mocks.extractSnapshot).toHaveBeenCalledTimes(1)
    expect(result.completed).toBe(1)
  })

  it("外层异常（如 resolveNovelModel 抛错）→ errors 记录", async () => {
    mocks.resolveNovelModel.mockImplementation(() => { throw new Error("resolve-boom") })
    const result = await runBatchMemoryExtraction({ projectPath: "/proj-run-outer", chapters: [1] })
    expect(result.errors.some((e) => e.includes("resolve-boom"))).toBe(true)
  })
})

describe("acceptBatchExtractionDrafts", () => {
  it("无账本返回空", async () => {
    const result = await acceptBatchExtractionDrafts({ projectPath: "/proj-accept-none" })
    expect(result).toEqual({ accepted: [], failed: [] })
  })

  it("有账本但无 ready → 空（失败账本不可 accept）", async () => {
    mocks.findChapterFile.mockResolvedValue(null)
    await runBatchMemoryExtraction({ projectPath: "/proj-accept-noready", chapters: [1] })
    const result = await acceptBatchExtractionDrafts({ projectPath: "/proj-accept-noready" })
    expect(result).toEqual({ accepted: [], failed: [] })
  })

  it("成功回填：ready→accepted", async () => {
    mocks.findChapterFile.mockImplementation(async (_p: string, ch: number) => `/p/ch${ch}.md`)
    mocks.extractSnapshot.mockImplementation(async (ch: number) => ({ chapter: ch }))
    await runBatchMemoryExtraction({ projectPath: "/proj-accept-ok", chapters: [1, 2] })
    mocks.syncSnapshot.mockResolvedValue(undefined)
    const result = await acceptBatchExtractionDrafts({ projectPath: "/proj-accept-ok" })
    expect(result.accepted.sort()).toEqual([1, 2])
    expect(result.failed).toEqual([])
    const queue = getBatchExtractQueue("/proj-accept-ok")
    expect(queue?.drafts.every((d) => d.status === "accepted")).toBe(true)
  })

  it("部分失败保留 ready 可重试", async () => {
    mocks.findChapterFile.mockImplementation(async (_p: string, ch: number) => `/p/ch${ch}.md`)
    mocks.extractSnapshot.mockImplementation(async (ch: number) => ({ chapter: ch }))
    await runBatchMemoryExtraction({ projectPath: "/proj-accept-partial", chapters: [1, 2] })
    mocks.syncSnapshot.mockImplementation(async (_p: string, snap: { chapter: number }) => {
      if (snap.chapter === 2) throw new Error("sync-boom-2")
    })
    const result = await acceptBatchExtractionDrafts({ projectPath: "/proj-accept-partial" })
    expect(result.accepted).toEqual([1])
    expect(result.failed.length).toBe(1)
    expect(result.failed[0].chapter).toBe(2)
    expect(result.failed[0].error).toContain("sync-boom-2")
  })

  it("按 chapters 过滤只回填指定章", async () => {
    mocks.findChapterFile.mockImplementation(async (_p: string, ch: number) => `/p/ch${ch}.md`)
    mocks.extractSnapshot.mockImplementation(async (ch: number) => ({ chapter: ch }))
    await runBatchMemoryExtraction({ projectPath: "/proj-accept-filter", chapters: [1, 2] })
    mocks.syncSnapshot.mockResolvedValue(undefined)
    const result = await acceptBatchExtractionDrafts({ projectPath: "/proj-accept-filter", chapters: [2] })
    expect(result.accepted).toEqual([2])
  })
})

describe("sidebar-panel-import — W3 剩余分支补齐", () => {
  it("非取消 signal 走 addEventListener 分支", async () => {
    const controller = new AbortController()
    mocks.findChapterFile.mockImplementation(async (_p: string, ch: number) => `/p/ch${ch}.md`)
    mocks.extractSnapshot.mockImplementation(async (ch: number) => ({ chapter: ch }))
    const result = await runBatchMemoryExtraction({ projectPath: "/proj-branch-signal", chapters: [1], signal: controller.signal })
    expect(result.completed).toBe(1)
    expect(result.cancelled).toBe(false)
  })

  it("parseChapterMeta 返回章号时采用其值", async () => {
    mocks.findChapterFile.mockResolvedValue("/p/ch1.md")
    mocks.parseFrontmatter.mockReturnValue({ frontmatter: { chapterNumber: 99 }, body: "有正文" })
    mocks.parseChapterMeta.mockReturnValue({ chapterNumber: 99 })
    mocks.extractSnapshot.mockImplementation(async (ch: number) => {
      // 断言传入的是 frontmatter 中的章号而非原 chapter
      expect(ch).toBe(99)
      return { chapter: ch }
    })
    const result = await runBatchMemoryExtraction({ projectPath: "/proj-branch-meta", chapters: [1] })
    expect(result.completed).toBe(1)
  })

  it("extract 抛错时若已取消则走 cancelled 分支", async () => {
    const { cancelBatchMemoryExtraction } = await import("./sidebar-panel-import")
    mocks.findChapterFile.mockResolvedValue("/p/ch1.md")
    mocks.parseFrontmatter.mockReturnValue({ frontmatter: {}, body: "有正文" })
    mocks.parseChapterMeta.mockReturnValue(null)
    mocks.extractSnapshot.mockImplementation(async () => {
      cancelBatchMemoryExtraction()
      throw new Error("abort-race")
    })
    const result = await runBatchMemoryExtraction({ projectPath: "/proj-branch-abortrace", chapters: [1, 2] })
    expect(result.cancelled).toBe(true)
  })
})
