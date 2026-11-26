// @vitest-environment jsdom
/**
 * sidebar-panel-import — 批量提取纯函数真测试（G3 两段式：extract→草稿→accept）。
 * 覆盖 loadBatchExtractDefaults / previewBatchExtraction / getBatchExtractQueue /
 * cancelBatchMemoryExtraction / runBatchMemoryExtraction / acceptBatchExtractionDrafts。
 * Hook（useSidebarImport）的导入/菜单/记忆确认路径由 sidebar-panel.spec 间接覆盖，此处只补纯函数缺口。
 */
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { IngestResult } from "@/lib/novel"
import type { SnapshotScanResult } from "./sidebar-panel-import"
import {
  acceptBatchExtractionDrafts,
  getBatchExtractQueue,
  discardBatchExtractionDrafts,
  restoreBatchExtractQueue,
  resetCorruptBatchExtractionDrafts,
  loadBatchExtractDefaults,
  previewBatchExtraction,
  runBatchMemoryExtraction,
} from "./sidebar-panel-import"

const draftFiles = vi.hoisted(() => new Map<string, string>())

const { fixtureReceipt } = vi.hoisted(() => ({
  fixtureReceipt: ({ path, chapterNumber }: { path: string; chapterNumber: number }) => ({
    receipt: {
      readPath: path,
      chapterNumber,
      bodySha256: "a".repeat(64),
      contentSha256: "b".repeat(64),
      snapshotJsonSha256AtExtractionCommit: "c".repeat(64),
      snapshotIdAtExtractionCommit: `chapter-${chapterNumber}-r1`,
      snapshotRevisionAtExtractionCommit: 1,
      canonOutcome: { status: "skipped", reason: "no_facts" },
    },
    projectionReceipt: {
      extractionHistoryPath: `${path}.stored-history.snapshot.json`,
      snapshotId: `chapter-${chapterNumber}-r2`,
      revision: 2,
      snapshotJsonSha256: "d".repeat(64),
    },
  }),
}))

const mocks = vi.hoisted(() => ({
  writeDraftArtifact: vi.fn<(files: Array<[string, string]>, expected?: readonly (string | null)[]) => Promise<void>>(),
  startTask: vi.fn((_input: unknown) => "task-1"),
  updateTask: vi.fn(),
  finishTask: vi.fn(),
  findChapterFile: vi.fn(async (_proj: string, _ch: number): Promise<string | null> => null),
  extractSnapshot: vi.fn(async (_ch: number): Promise<{ chapter: number } | null> => null),
  prepareChapter: vi.fn(async (_proj: string, path: string, chapter: number, _signal?: AbortSignal) => {
    const snapshot = await mocks.extractSnapshot(chapter)
    if (!snapshot) throw new Error("extract_failed")
    return {
      snapshot: { ...snapshot, chapterNumber: chapter },
      source: { readPath: path, chapterNumber: chapter, bodySha256: "a".repeat(64), contentSha256: "b".repeat(64) },
    }
  }),
  commitPreparedChapterIngest: vi.fn(async (_proj: string, prepared: { snapshot: { chapterNumber: number } }, beforeFormalEffects?: () => Promise<void>): Promise<{ snapshot: { chapterNumber: number } | null; failReason?: IngestResult["failReason"] }> => {
    await beforeFormalEffects?.()
    return { snapshot: { chapterNumber: prepared.snapshot.chapterNumber } }
  }),
  verify: vi.fn(async (_proj: string, target: { path: string; chapterNumber: number }, _ingest: unknown) => fixtureReceipt(target)),
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

vi.mock("@/commands/fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/commands/fs")>()
  return {
    ...actual,
    readFile: async (path: string) => {
      const raw = draftFiles.get(path)
      if (raw === undefined) throw new Error("ENOENT: no such file")
      return raw
    },
    writeFilesAtomic: mocks.writeDraftArtifact,
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

vi.mock("@/lib/novel", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/novel")>()
  return {
    ...actual,
    findChapterFileByNumber: mocks.findChapterFile,
    verifyRebuildOutcome: mocks.verify,
  }
})

vi.mock("@/lib/novel/snapshot-scanner", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/novel/snapshot-scanner")>()
  return { ...actual, scanSnapshotBackfill: mocks.scanBackfill, scanFinalChapterBackfill: mocks.scanBackfill }
})

vi.mock("@/lib/novel/chapter-ingest", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/novel/chapter-ingest")>()
  return {
    ...actual,
    extractSnapshotWithLLM: mocks.extractSnapshot,
    prepareChapterIngest: mocks.prepareChapter,
    commitPreparedChapterIngest: mocks.commitPreparedChapterIngest,
    syncSnapshotToMemory: mocks.syncSnapshot,
  }
})

beforeEach(() => {
  vi.clearAllMocks()
  draftFiles.clear()
  mocks.writeDraftArtifact.mockImplementation(async (files: Array<[string, string]>, expected?: readonly (string | null)[]) => {
    files.forEach(([path, raw], i) => {
      if ((draftFiles.get(path) ?? null) !== (expected?.[i] ?? null)) throw new Error("CAS mismatch")
      draftFiles.set(path, raw)
    })
  })
  mocks.startTask.mockReturnValue("task-1")
  mocks.findChapterFile.mockResolvedValue(null)
  mocks.extractSnapshot.mockResolvedValue(null)
  mocks.prepareChapter.mockImplementation(async (_proj: string, path: string, chapter: number, _signal?: AbortSignal) => {
    const snapshot = await mocks.extractSnapshot(chapter)
    if (!snapshot) throw new Error("extract_failed")
    return {
      snapshot: { ...snapshot, chapterNumber: chapter },
      source: { readPath: path, chapterNumber: chapter, bodySha256: "a".repeat(64), contentSha256: "b".repeat(64) },
    }
  })
  mocks.commitPreparedChapterIngest.mockImplementation(async (_proj: string, prepared: { snapshot: { chapterNumber: number } }, beforeFormalEffects?: () => Promise<void>) => {
    await beforeFormalEffects?.()
    return { snapshot: { chapterNumber: prepared.snapshot.chapterNumber } }
  })
  mocks.verify.mockImplementation(async (_proj: string, target: { path: string; chapterNumber: number }, _ingest: unknown) => fixtureReceipt(target))
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
    // 语义变异锚点：预算默认 20、上限 60
    expect(defaults.budget).toBe(20)
    expect(defaults.budgetMax).toBe(60)
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

  it("透传 budget、scope 与起止章号区间选项", async () => {
    mocks.scanBackfill.mockResolvedValue({
      total: 4,
      chapters: [1, 2, 3, 4],
      pending: [
        { chapter: 1, reason: "missing_optional_field", missingFields: [], revision: null },
        { chapter: 2, reason: "missing_optional_field", missingFields: [], revision: null },
        { chapter: 3, reason: "missing_optional_field", missingFields: [], revision: null },
        { chapter: 4, reason: "missing_optional_field", missingFields: [], revision: null },
      ],
      errors: [],
    })
    const preview = await previewBatchExtraction("/proj-preview-2", { budget: 1 })
    expect(preview.plan.admitted.length).toBe(1)
    expect(preview.plan.skippedByBudget.length).toBe(3)
    expect(preview.ledger.exhausted).toBe(true)

    const ranged = await previewBatchExtraction("/proj-preview-2", { startChapter: 2, endChapter: 3 })
    expect(ranged.selection.chapters).toEqual([2, 3])
    expect(ranged.plan.admitted).toEqual([2, 3])
  })
})

describe("getBatchExtractQueue / discardBatchExtractionDrafts", () => {
  it("无账本返回 null，无 ready 草稿时 discard 返回 false", async () => {
    expect(getBatchExtractQueue("/proj-no-queue-xyz")).toBeNull()
    const emptyQueue = { projectPath: "/proj-no-queue-xyz", status: "done" as const, budget: 20, admitted: [], skippedByBudget: [], drafts: [], completed: 0, failed: 0, errors: [] }
    await expect(discardBatchExtractionDrafts("/proj-no-queue-xyz", emptyQueue as never)).resolves.toBe(false)
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
  it("成功：两章提取为 ready 草稿并 done 收尾（confirm 前不调 commit/verify）", async () => {
    mocks.findChapterFile.mockImplementation(async (_p: string, ch: number) => `/p/ch${ch}.md`)
    mocks.extractSnapshot.mockImplementation(async (ch: number) => ({ chapter: ch }))
    const onProgress = vi.fn()
    const result = await runBatchMemoryExtraction({ projectPath: "/proj-run-ok", chapters: [1, 2], onProgress })
    expect(result.completed).toBe(2)
    expect(result.failed).toBe(0)
    expect(result.cancelled).toBe(false)
    expect(result.errors).toEqual([])
    expect(result.drafts.filter((d) => d.status === "ready").length).toBe(2)
    expect(result.drafts.every((d) => d.source?.bodySha256 === "a".repeat(64))).toBe(true)
    expect(mocks.prepareChapter).toHaveBeenCalledTimes(2)
    expect(mocks.commitPreparedChapterIngest).not.toHaveBeenCalled()
    expect(mocks.verify).not.toHaveBeenCalled()
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
    expect(result.errors[0]).toContain("chapter_file_missing")
    expect(mocks.finishTask).toHaveBeenCalledWith("task-1", "error", expect.anything())
  })

  it("正文为空 → failed 记账 empty_chapter_body", async () => {
    mocks.findChapterFile.mockResolvedValue("/p/ch1.md")
    mocks.prepareChapter.mockRejectedValueOnce(new Error("empty_chapter_body"))
    const result = await runBatchMemoryExtraction({ projectPath: "/proj-run-empty", chapters: [1] })
    expect(result.failed).toBe(1)
    expect(result.errors[0]).toContain("empty_chapter_body")
  })

  it("extract 返回 null → failed 记账 extract_failed", async () => {
    mocks.findChapterFile.mockResolvedValue("/p/ch1.md")
    mocks.extractSnapshot.mockResolvedValue(null)
    const result = await runBatchMemoryExtraction({ projectPath: "/proj-run-null", chapters: [1] })
    expect(result.failed).toBe(1)
    expect(result.errors[0]).toContain("extract_failed")
  })

  it("extract 抛错 → failed 并记录消息", async () => {
    mocks.findChapterFile.mockResolvedValue("/p/ch1.md")
    mocks.extractSnapshot.mockRejectedValue(new Error("llm-boom"))
    const result = await runBatchMemoryExtraction({ projectPath: "/proj-run-throw", chapters: [1] })
    expect(result.failed).toBe(1)
    expect(result.errors[0]).toContain("llm-boom")
  })

  it("prepare 抛错（如读源失败）→ failed 并记录消息", async () => {
    mocks.findChapterFile.mockResolvedValue("/p/ch1.md")
    mocks.prepareChapter.mockRejectedValueOnce(new Error("read-boom"))
    const result = await runBatchMemoryExtraction({ projectPath: "/proj-run-readfail", chapters: [1] })
    expect(result.failed).toBe(1)
    expect(result.errors[0]).toContain("read-boom")
  })

  it("扫描 paths 优先于 findChapterFileByNumber（免标题二查）", async () => {
    mocks.findChapterFile.mockResolvedValue("/p/legacy.md")
    mocks.extractSnapshot.mockResolvedValue({ chapter: 1 })
    const result = await runBatchMemoryExtraction({
      projectPath: "/proj-run-paths",
      chapters: [1],
      paths: { 1: "/p/scan-ch1.md" },
    })
    expect(result.completed).toBe(1)
    expect(mocks.prepareChapter).toHaveBeenCalledWith("/proj-run-paths", "/p/scan-ch1.md", 1, expect.anything())
    expect(mocks.findChapterFile).not.toHaveBeenCalled()
  })

  it("输入 signal 未中止 → 注册转发监听；运行中 abort 即取消", async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    mocks.findChapterFile.mockResolvedValue("/p/ch1.md")
    const controller = new AbortController()
    mocks.extractSnapshot.mockImplementation(async () => {
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
    const result = await runBatchMemoryExtraction({ projectPath: "/proj-run-budget", chapters: [1, 2, 3], budget: 1 })
    expect(result.admitted).toEqual([1])
    expect(result.skippedByBudget).toEqual([2, 3])
    expect(result.ledger.exhausted).toBe(true)
    expect(mocks.prepareChapter).toHaveBeenCalledTimes(1)
    expect(result.completed).toBe(1)
  })

  it("外层异常（观察者 onProgress 抛错）→ errors 记录且 pending 记 failed", async () => {
    mocks.findChapterFile.mockImplementation(async (_p: string, ch: number) => `/p/ch${ch}.md`)
    mocks.extractSnapshot.mockImplementation(async (ch: number) => ({ chapter: ch }))
    const onProgress = vi.fn().mockImplementationOnce(() => { throw new Error("observer-boom") })
    const result = await runBatchMemoryExtraction({ projectPath: "/proj-run-outer", chapters: [1, 2], onProgress })
    expect(result.errors.some((e) => e.includes("observer-boom"))).toBe(true)
    expect(result.failed).toBe(2)
  })

  it("在途提取期间拒绝第二个并发启动，不覆盖旧队列", async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    mocks.findChapterFile.mockResolvedValue("/p/ch1.md")
    mocks.extractSnapshot.mockImplementation(async () => { await gate; return { chapter: 1 } })
    const first = runBatchMemoryExtraction({ projectPath: "/proj-run-inflight", chapters: [1] })
    await Promise.resolve()
    await expect(runBatchMemoryExtraction({ projectPath: "/proj-run-inflight", chapters: [2] }))
      .rejects.toThrow("already in progress")
    release()
    await first
    expect(getBatchExtractQueue("/proj-run-inflight")?.drafts.map((d) => d.chapter)).toEqual([1])
  })
})

describe("acceptBatchExtractionDrafts", () => {
  it("无账本返回空", async () => {
    const result = await acceptBatchExtractionDrafts({ projectPath: "/proj-accept-none" })
    expect(result).toEqual({ accepted: [], failed: [], outcomes: [] })
  })

  it("有账本但无 ready → 空（失败账本不可 accept）", async () => {
    mocks.findChapterFile.mockResolvedValue(null)
    await runBatchMemoryExtraction({ projectPath: "/proj-accept-noready", chapters: [1] })
    const result = await acceptBatchExtractionDrafts({ projectPath: "/proj-accept-noready" })
    expect(result).toEqual({ accepted: [], failed: [], outcomes: [] })
  })

  it("成功回填：ready→accepted（verify 出证后记账）", async () => {
    mocks.findChapterFile.mockImplementation(async (_p: string, ch: number) => `/p/ch${ch}.md`)
    mocks.extractSnapshot.mockImplementation(async (ch: number) => ({ chapter: ch }))
    await runBatchMemoryExtraction({ projectPath: "/proj-accept-ok", chapters: [1, 2] })
    const result = await acceptBatchExtractionDrafts({ projectPath: "/proj-accept-ok" })
    expect(result.accepted.sort()).toEqual([1, 2])
    expect(result.failed).toEqual([])
    expect(result.outcomes.every((o) => o.status === "verified" && o.receipt)).toBe(true)
    const queue = getBatchExtractQueue("/proj-accept-ok")
    expect(queue?.drafts.every((d) => d.status === "accepted")).toBe(true)
    expect(mocks.commitPreparedChapterIngest).toHaveBeenCalledTimes(2)
    expect(mocks.verify).toHaveBeenCalledTimes(2)
  })

  it("verify 失败 → 保留 receipt 的失败 outcome + failed 记账，重试不再调 commit", async () => {
    mocks.findChapterFile.mockImplementation(async (_p: string, ch: number) => `/p/ch${ch}.md`)
    mocks.extractSnapshot.mockImplementation(async (ch: number) => ({ chapter: ch }))
    await runBatchMemoryExtraction({ projectPath: "/proj-accept-partial", chapters: [1, 2] })
    mocks.verify.mockRejectedValueOnce(new Error("verify-boom"))
    const result = await acceptBatchExtractionDrafts({ projectPath: "/proj-accept-partial" })
    expect(result.accepted).toEqual([2])
    expect(result.failed.length).toBe(1)
    expect(result.failed[0].chapter).toBe(1)
    expect(result.failed[0].error).toContain("verify-boom")
    const failedOutcome = result.outcomes.find((o) => o.chapterNumber === 1)
    expect(failedOutcome?.status).toBe("failed")
    expect(failedOutcome?.status === "failed" ? failedOutcome.reason : undefined).toContain("verify-boom")
    const queue = getBatchExtractQueue("/proj-accept-partial")
    expect(queue?.drafts.find((d) => d.chapter === 1)?.status).toBe("failed")
    const second = await acceptBatchExtractionDrafts({ projectPath: "/proj-accept-partial" })
    expect(second).toEqual({ accepted: [], failed: [], outcomes: [] })
    expect(mocks.commitPreparedChapterIngest).toHaveBeenCalledTimes(2)
  })

  it.each([["source_changed", "failed"], ["source_unavailable", "ready"]] as const)("source 不可用（%s）→ %s，不假报重试", async (reason, status) => {
    const pp = `/proj-accept-stale-${reason}`
    mocks.findChapterFile.mockImplementation(async (_p: string, ch: number) => `/p/ch${ch}.md`)
    mocks.extractSnapshot.mockImplementation(async (ch: number) => ({ chapter: ch }))
    await runBatchMemoryExtraction({ projectPath: pp, chapters: [1] })
    mocks.commitPreparedChapterIngest.mockResolvedValueOnce({ snapshot: null, failReason: reason })
    const result = await acceptBatchExtractionDrafts({ projectPath: pp })
    expect(result.accepted).toEqual([])
    expect(result.failed.length).toBe(1)
    expect(result.failed[0].error).toContain(reason)
    expect(getBatchExtractQueue(pp)?.drafts.find((d) => d.chapter === 1)?.status).toBe(status)
  })

  it("按 chapters 过滤只回填指定章", async () => {
    mocks.findChapterFile.mockImplementation(async (_p: string, ch: number) => `/p/ch${ch}.md`)
    mocks.extractSnapshot.mockImplementation(async (ch: number) => ({ chapter: ch }))
    await runBatchMemoryExtraction({ projectPath: "/proj-accept-filter", chapters: [1, 2] })
    const result = await acceptBatchExtractionDrafts({ projectPath: "/proj-accept-filter", chapters: [2] })
    expect(result.accepted).toEqual([2])
    expect(result.outcomes.length).toBe(1)
  })

  it("提取在途时拒绝 accept（不覆盖在途队列）", async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    mocks.findChapterFile.mockResolvedValue("/p/ch1.md")
    mocks.extractSnapshot.mockImplementation(async () => { await gate; return { chapter: 1 } })
    const first = runBatchMemoryExtraction({ projectPath: "/proj-accept-inflight", chapters: [1] })
    await Promise.resolve()
    await expect(acceptBatchExtractionDrafts({ projectPath: "/proj-accept-inflight" }))
      .rejects.toThrow("already in progress")
    release()
    await first
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

  it("extract 抛错时若已取消则走 cancelled 分支", async () => {
    const controller = new AbortController()
    mocks.findChapterFile.mockResolvedValue("/p/ch1.md")
    mocks.extractSnapshot.mockImplementation(async () => {
      controller.abort()
      throw new Error("abort-race")
    })
    const result = await runBatchMemoryExtraction({ projectPath: "/proj-branch-abortrace", chapters: [1, 2], signal: controller.signal })
    expect(result.cancelled).toBe(true)
  })
})

describe("batch retention / discard / cross-project", () => {
  it("ready 草稿阻塞新批；discard 后才可再批；accepted 回执保留在 previousOutcomes", async () => {
    const pp = "/proj-batch-retain"
    mocks.findChapterFile.mockImplementation(async (_p: string, ch: number) => `/p/ch${ch}.md`)
    mocks.extractSnapshot.mockImplementation(async (ch: number) => ({ chapter: ch }))
    // 提取两章（chapters [1,2] → 两个 ready 草稿）
    await runBatchMemoryExtraction({ projectPath: pp, chapters: [1, 2] })
    const readyQueue = getBatchExtractQueue(pp)
    if (!readyQueue) throw new Error("Missing batch fixture")
    expect(readyQueue.drafts.filter(d => d.status === "ready")).toHaveLength(2)
    // 只 accept 第 1 章
    const acceptedResult = await acceptBatchExtractionDrafts({ projectPath: pp, chapters: [1] })
    const activeQueue = getBatchExtractQueue(pp)
    if (!activeQueue) throw new Error("Missing batch fixture")
    // 新批被 ready 草稿阻塞
    await expect(runBatchMemoryExtraction({ projectPath: pp, chapters: [3] })).rejects.toThrow(/pending drafts/)
    expect(getBatchExtractQueue(pp)).toBe(activeQueue)
    expect(mocks.prepareChapter).toHaveBeenCalledTimes(2)
    expect(mocks.startTask).toHaveBeenCalledTimes(1)
    expect(mocks.commitPreparedChapterIngest).toHaveBeenCalledTimes(1)
    // 陈旧 expectedQueue → batch changed
    await expect(acceptBatchExtractionDrafts({ projectPath: pp, expectedQueue: readyQueue })).rejects.toThrow(/batch changed/)
    expect(mocks.commitPreparedChapterIngest).toHaveBeenCalledTimes(1)
    // stale discard → false；current discard → true
    await expect(discardBatchExtractionDrafts(pp, readyQueue)).resolves.toBe(false)
    await expect(discardBatchExtractionDrafts(pp, activeQueue)).resolves.toBe(true)
    const afterDiscard = getBatchExtractQueue(pp)
    expect(afterDiscard?.drafts.find(d => d.chapter === 2)?.status).toBe("cancelled")
    expect(afterDiscard?.drafts.find(d => d.chapter === 2)?.snapshot).toBeUndefined()
    // 新批允许；accepted 回执进 previousOutcomes
    await runBatchMemoryExtraction({ projectPath: pp, chapters: [3] })
    const nextQueue = getBatchExtractQueue(pp)
    expect(nextQueue?.previousOutcomes).toEqual(acceptedResult.outcomes)
    expect(nextQueue?.drafts.find(d => d.chapter === 3)?.status).toBe("ready")
  })

  it("应用级互斥：一批在途时其它项目的提取/接受都被拒", async () => {
    const pp = "/proj-lock-a"
    mocks.findChapterFile.mockImplementation(async (_p: string, ch: number) => `/p/ch${ch}.md`)
    mocks.extractSnapshot.mockImplementation(async (ch: number) => ({ chapter: ch }))
    let release!: () => void
    mocks.prepareChapter.mockImplementationOnce(async (_proj: string, path: string, ch: number) => {
      await new Promise<void>((resolve) => { release = resolve })
      return { snapshot: { chapterNumber: ch, chapter: ch }, source: { readPath: path, chapterNumber: ch, bodySha256: "a".repeat(64), contentSha256: "b".repeat(64) } }
    })
    const first = runBatchMemoryExtraction({ projectPath: pp, chapters: [1] })
    await vi.waitFor(() => expect(mocks.prepareChapter).toHaveBeenCalled())
    await expect(runBatchMemoryExtraction({ projectPath: "/another-batch-project", chapters: [3] })).rejects.toThrow(/only one project/)
    await expect(acceptBatchExtractionDrafts({ projectPath: "/another-batch-project" })).rejects.toThrow(/only one project/)
    release()
    await first
  })

  it("桌面预算默认 20 章，硬顶放开至 60 章：64 章 + budget 999 → 60 章准入，61–64 记账跳过", async () => {
    const ppDefault = "/proj-budget-default-24"
    const chapters24 = Array.from({ length: 24 }, (_, i) => i + 1)
    mocks.findChapterFile.mockImplementation(async (_p: string, ch: number) => `/p/ch${ch}.md`)
    mocks.extractSnapshot.mockImplementation(async (ch: number) => ({ chapter: ch }))
    const defaultResult = await runBatchMemoryExtraction({ projectPath: ppDefault, chapters: chapters24 })
    expect(defaultResult.ledger.budget).toBe(20)
    expect(defaultResult.skippedByBudget).toEqual([21, 22, 23, 24])

    mocks.prepareChapter.mockClear()
    const ppCap = "/proj-budget-cap-64"
    const chapters64 = Array.from({ length: 64 }, (_, i) => i + 1)
    const capResult = await runBatchMemoryExtraction({ projectPath: ppCap, chapters: chapters64, budget: 999 })
    expect(capResult.ledger.budget).toBe(60)
    expect(mocks.prepareChapter).toHaveBeenCalledTimes(60)
    expect(capResult.skippedByBudget).toEqual([61, 62, 63, 64])
  })
})
describe("batch draft restart recovery", () => {
  beforeEach(() => {
    mocks.findChapterFile.mockImplementation(async (project: string, chapter: number) => `${project}/wiki/chapters/${chapter}.md`)
    mocks.extractSnapshot.mockImplementation(async (chapter: number) => ({ chapter }))
  })

  it("recovers an accepted receipt and a second ready draft without committing again", async () => {
    const projectPath = "/proj-batch-reopen"
    await runBatchMemoryExtraction({ projectPath: `${projectPath}/`, chapters: [1, 2] })
    expect(mocks.commitPreparedChapterIngest).not.toHaveBeenCalled()
    const first = await acceptBatchExtractionDrafts({ projectPath, chapters: [1] })
    expect(first.accepted).toEqual([1])
    vi.resetModules()
    const reopened = await import("./sidebar-panel-import")
    const restored = await reopened.restoreBatchExtractQueue(projectPath)
    expect(restored?.drafts).toMatchObject([
      { chapter: 1, status: "accepted", outcome: first.outcomes[0] },
      { chapter: 2, status: "ready", source: { readPath: `${projectPath}/wiki/chapters/2.md`, chapterNumber: 2 } },
    ])
    expect(mocks.commitPreparedChapterIngest).toHaveBeenCalledTimes(1)
    expect(mocks.prepareChapter).toHaveBeenCalledTimes(2)
    if (!restored) throw new Error("Missing restored batch")
    await expect(reopened.acceptBatchExtractionDrafts({ projectPath, chapters: [2], expectedQueue: restored })).resolves.toMatchObject({ accepted: [2] })
    expect(mocks.commitPreparedChapterIngest).toHaveBeenCalledTimes(2)
  })

  it("does not expose a terminal interruption while an acceptance is still running", async () => {
    const projectPath = "/proj-batch-accept-inflight"
    await runBatchMemoryExtraction({ projectPath, chapters: [1] })
    let release!: () => void
    const waitForCommit = new Promise<void>((resolve) => { release = resolve })
    mocks.commitPreparedChapterIngest.mockImplementationOnce(async (_project, prepared, beforeFormalEffects?: () => Promise<void>) => {
      await beforeFormalEffects?.()
      await waitForCommit
      return { snapshot: { chapterNumber: prepared.snapshot.chapterNumber } }
    })
    const acceptance = acceptBatchExtractionDrafts({ projectPath })
    try {
      await vi.waitFor(() => expect(mocks.commitPreparedChapterIngest).toHaveBeenCalledTimes(1))
      expect(getBatchExtractQueue(projectPath)?.drafts[0]).toMatchObject({ chapter: 1, status: "ready" })
      expect(getBatchExtractQueue(projectPath)?.drafts[0]?.outcome).toBeUndefined()
    } finally {
      release()
      await acceptance
    }
    expect(getBatchExtractQueue(projectPath)?.drafts[0]?.status).toBe("accepted")
  })


  it("keeps an unstarted draft ready when acceptance throws before the reservation", async () => {
    const projectPath = "/proj-batch-pre-reservation"
    await runBatchMemoryExtraction({ projectPath, chapters: [1] })
    mocks.commitPreparedChapterIngest.mockRejectedValueOnce(new Error("transient preflight failure"))
    const result = await acceptBatchExtractionDrafts({ projectPath })
    expect(result.failed.length).toBe(1)
    vi.resetModules()
    const reopened = await import("./sidebar-panel-import")
    const restored = await reopened.restoreBatchExtractQueue(projectPath)
    expect(restored?.drafts[0]?.status).toBe("ready")
    if (!restored) throw new Error("Missing restored batch")
    await expect(reopened.acceptBatchExtractionDrafts({ projectPath, expectedQueue: restored })).resolves.toMatchObject({ accepted: [1] })
    expect(mocks.commitPreparedChapterIngest).toHaveBeenCalledTimes(2)
    expect(mocks.prepareChapter).toHaveBeenCalledTimes(1)
  })

  it("does not replay a thrown acceptance after a durable reservation", async () => {
    const projectPath = "/proj-batch-thrown-accept"
    await runBatchMemoryExtraction({ projectPath, chapters: [1] })
    mocks.commitPreparedChapterIngest.mockImplementationOnce(async (_project, _prepared, beforeFormalEffects?: () => Promise<void>) => {
      await beforeFormalEffects?.()
      throw new Error("synthetic post-reservation throw")
    })
    const result = await acceptBatchExtractionDrafts({ projectPath })
    expect(result.failed.length).toBe(1)
    vi.resetModules()
    const reopened = await import("./sidebar-panel-import")
    const restored = await reopened.restoreBatchExtractQueue(projectPath)
    if (!restored) throw new Error("Missing restored batch")
    expect(restored?.drafts[0]?.status).toBe("uncertain")
    await expect(reopened.setAsideUncertainBatchDrafts(projectPath, restored)).resolves.toBe(true)
    expect(mocks.commitPreparedChapterIngest).toHaveBeenCalledTimes(1)
  })

  it("does not replay a commit after its receipt could not be saved", async () => {
    const projectPath = "/proj-batch-interrupted-accept"
    await runBatchMemoryExtraction({ projectPath, chapters: [1] })
    mocks.commitPreparedChapterIngest.mockImplementationOnce(async (_project, prepared, beforeFormalEffects?: () => Promise<void>) => {
      await beforeFormalEffects?.()
      mocks.writeDraftArtifact.mockRejectedValueOnce(new Error("synthetic receipt write failure"))
      return { snapshot: { chapterNumber: prepared.snapshot.chapterNumber } }
    })
    await expect(acceptBatchExtractionDrafts({ projectPath })).rejects.toThrow("Acceptance outcome could not be saved")
    expect(getBatchExtractQueue(projectPath)?.drafts[0]?.status).toBe("uncertain")
    vi.resetModules()
    const reopened = await import("./sidebar-panel-import")
    const restored = await reopened.restoreBatchExtractQueue(projectPath)
    expect(restored?.drafts[0]).toMatchObject({ chapter: 1, status: "uncertain", reason: expect.stringContaining("Acceptance interrupted") })
    await expect(reopened.runBatchMemoryExtraction({ projectPath, chapters: [1] })).rejects.toThrow("Review the interrupted acceptance")
    if (!restored) throw new Error("Missing restored batch")
    await expect(reopened.setAsideUncertainBatchDrafts(projectPath, restored)).resolves.toBe(true)
    expect(reopened.getBatchExtractQueue(projectPath)?.drafts[0]).toMatchObject({ status: "cancelled", outcome: { status: "uncertain" } })
    expect(mocks.commitPreparedChapterIngest).toHaveBeenCalledTimes(1)
  })

  it("refuses to overwrite an unreadable artifact or call a model", async () => {
    const projectPath = "/proj-batch-corrupt"
    const path = `${projectPath}/.qm-drafts/batch-extraction.json`
    const raw = "{bad json"
    draftFiles.set(path, raw)
    await expect(runBatchMemoryExtraction({ projectPath, chapters: [1] })).rejects.toThrow()
    expect(draftFiles.get(path)).toBe(raw)
    expect(mocks.writeDraftArtifact).not.toHaveBeenCalled()
    expect(mocks.prepareChapter).not.toHaveBeenCalled()
    expect(mocks.commitPreparedChapterIngest).not.toHaveBeenCalled()
  })

  it("backs up corrupt bytes before resetting the queue without touching chapters", async () => {
    const projectPath = "/proj-batch-reset"
    const path = `${projectPath}/.qm-drafts/batch-extraction.json`
    const raw = "\uFEFF{bad\r\njson"
    draftFiles.set(path, raw)
    const { computeCheckpointDigest } = await import("@/lib/novel")
    const fingerprint = await computeCheckpointDigest(raw)
    mocks.writeDraftArtifact.mockImplementationOnce(async (files) => {
      draftFiles.set(files[0][0], files[0][1])
    }).mockRejectedValueOnce(new Error("synthetic reset failure"))
    await expect(resetCorruptBatchExtractionDrafts(projectPath, fingerprint)).rejects.toThrow("synthetic reset failure")
    expect(draftFiles.get(path)).toBe(raw)
    const backedUp = `${projectPath}/.qm-drafts/batch-extraction.corrupt-${fingerprint}.json`
    expect(draftFiles.get(backedUp)).toBe(raw)
    await expect(resetCorruptBatchExtractionDrafts(projectPath, fingerprint)).resolves.toBe(backedUp)
    await expect(restoreBatchExtractQueue(projectPath)).resolves.toMatchObject({ drafts: [] })
    expect(draftFiles.get(backedUp)).toBe(raw)
    expect(mocks.prepareChapter).not.toHaveBeenCalled()
    expect(mocks.commitPreparedChapterIngest).not.toHaveBeenCalled()
  })

  it.each([null, "truncated backup"])("preserves the corrupt batch when the backup does not read back: %s", async (backupBytes) => {
    const projectPath = "/proj-batch-reset-readback"
    const path = `${projectPath}/.qm-drafts/batch-extraction.json`
    const raw = "\uFEFF{bad\r\njson"
    draftFiles.set(path, raw)
    const { computeCheckpointDigest } = await import("@/lib/novel")
    const fingerprint = await computeCheckpointDigest(raw)
    const backup = `${projectPath}/.qm-drafts/batch-extraction.corrupt-${fingerprint}.json`
    mocks.writeDraftArtifact.mockImplementationOnce(async () => {
      if (backupBytes !== null) draftFiles.set(backup, backupBytes)
    })
    await expect(resetCorruptBatchExtractionDrafts(projectPath, fingerprint)).rejects.toThrow(
      backupBytes === null ? "ENOENT" : "Corruption backup differs",
    )
    expect(draftFiles.get(path)).toBe(raw)
    expect(mocks.writeDraftArtifact).toHaveBeenCalledTimes(1)
    expect(mocks.writeDraftArtifact).toHaveBeenCalledWith([[backup, raw]], [null])
  })

  it("refuses to quarantine an unsupported schema or different corruption", async () => {
    const projectPath = "/proj-batch-reset-fence"
    const path = `${projectPath}/.qm-drafts/batch-extraction.json`
    const { computeCheckpointDigest } = await import("@/lib/novel")
    const unknown = '{"schemaVersion":9000}'
    draftFiles.set(path, unknown)
    await expect(resetCorruptBatchExtractionDrafts(projectPath, await computeCheckpointDigest(unknown))).rejects.toThrow("Unsupported")
    draftFiles.set(path, "{different")
    await expect(resetCorruptBatchExtractionDrafts(projectPath, await computeCheckpointDigest("{"))).rejects.toThrow("Invalid")
    expect(draftFiles.get(path)).toBe("{different")
    expect(mocks.writeDraftArtifact).not.toHaveBeenCalled()
  })


  it.each(["invalid source digest", "accepted without receipt", "invalid prior outcome", "verified without complete projection receipt"])("refuses a checksum-valid but malformed batch: %s", async (defect) => {
    const projectPath = '/proj-batch-schema-' + defect.replace(/ /g, '-')
    await runBatchMemoryExtraction({ projectPath, chapters: [1] })
    if (defect === "verified without complete projection receipt") await acceptBatchExtractionDrafts({ projectPath })
    const path = `${projectPath}/.qm-drafts/batch-extraction.json`
    const artifact = JSON.parse(draftFiles.get(path) ?? "null")
    if (defect === "verified without complete projection receipt") artifact.batch.drafts[0].outcome.projectionReceipt = {}
    if (defect === "invalid source digest") artifact.batch.drafts[0].source.bodySha256 = "invalid"
    if (defect === "accepted without receipt") artifact.batch.drafts[0].status = "accepted"
    if (defect === "invalid prior outcome") artifact.batch.previousOutcomes = [null]
    const { computeCheckpointDigest } = await import("@/lib/novel")
    artifact.sha256 = await computeCheckpointDigest(JSON.stringify(artifact.batch))
    const damaged = JSON.stringify(artifact)
    draftFiles.set(path, damaged)
    mocks.prepareChapter.mockClear()
    mocks.commitPreparedChapterIngest.mockClear()
    mocks.writeDraftArtifact.mockClear()
    await expect(runBatchMemoryExtraction({ projectPath, chapters: [2] })).rejects.toThrow("Invalid batch extraction draft artifact")
    expect(mocks.prepareChapter).not.toHaveBeenCalled()
    expect(mocks.commitPreparedChapterIngest).not.toHaveBeenCalled()
    expect(mocks.writeDraftArtifact).not.toHaveBeenCalled()
    expect(draftFiles.get(path)).toBe(damaged)
  })

})
