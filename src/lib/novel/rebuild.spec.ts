import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  readFile: vi.fn(),
  listDirectory: vi.fn(),
  parseFrontmatter: vi.fn(),
  isChapterPage: vi.fn(),
  isFinalChapter: vi.fn(),
  ingestChapter: vi.fn(),
  flattenMdFilesBase: vi.fn(),
  embedPage: vi.fn(),
  useWikiStore: {
    getState: vi.fn(() => ({
      novelMode: true,
      embeddingConfig: { enabled: true, model: "m" },
    })),
  },
}))

vi.mock("@/commands/fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/commands/fs")>()
  return {
    ...actual,
      readFile: mocks.readFile,
      listDirectory: mocks.listDirectory,
    
  }
})
vi.mock("@/lib/frontmatter", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/frontmatter")>()
  return {
    ...actual,
      parseFrontmatter: mocks.parseFrontmatter,
    
  }
})
vi.mock("./chapter-meta", async (importOriginal) => ({
  ...await importOriginal<typeof import("./chapter-meta")>(),
  isChapterPage: mocks.isChapterPage,
  isFinalChapter: mocks.isFinalChapter,
}))
vi.mock("./chapter-ingest", () => ({
  ingestChapter: mocks.ingestChapter,
}))
vi.mock("./chapter-utils", () => ({
  flattenMdFilesBase: mocks.flattenMdFilesBase,
}))
vi.mock("@/stores/wiki-store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/stores/wiki-store")>()
  return {
    ...actual,
      useWikiStore: mocks.useWikiStore,
    
  }
})
vi.mock("@/lib/embedding", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/embedding")>()
  return {
    ...actual,
      embedPage: mocks.embedPage,
    
  }
})

import { PROJECTION_CATEGORIES } from "./projection-status-ledger"
import { normalizeChapterSnapshot } from "./chapter-snapshot-normalize"
import type { IngestResult } from "./chapter-ingest"
import { rebuildAllSnapshots, rebuildVectorIndex, verifyRebuildOutcome } from "./rebuild"
import { computeCheckpointDigest } from "./checkpoint-digest"
import { snapshotHistoryDir, snapshotJsonPath } from "./snapshot-paths"

const cell = (id: string) => ({ projection: id, category: PROJECTION_CATEGORIES[id], status: "committed" as const, updated_at: "2026-01-02T03:04:05.006Z", last_error: "" })

function mdNode(name: string, path: string) {
  return { name, path }
}

/** 构造可通过回读验证链的完整证据集：源/extraction 归档 r3 / current 物化 r4 皆真实 SHA。 */
async function mkVerifiedFixture(chapterPath: string, chapterNumber: number, source: string) {
const pp = "C:/novel"
  const r3 = { chapterId: `chapter-${chapterNumber}`, chapterNumber, summary: "s", revision: 3, snapshotId: `chapter-${chapterNumber}-r3`, isHistorical: false }
  const historyPath = `${snapshotHistoryDir(pp, chapterNumber)}/2026-01-02T03-04-05.006Z.snapshot.json`
  const reads = new Map<string, string>([
    [chapterPath, source],
    [historyPath, JSON.stringify({ ...r3, isHistorical: true }, null, 2)],
    [snapshotJsonPath(pp, chapterNumber), JSON.stringify({ ...r3, revision: 4, snapshotId: `chapter-${chapterNumber}-r4`, supersedes: `chapter-${chapterNumber}-r3` }, null, 2)],
  ])
  const receipt = {
    readPath: chapterPath,
    chapterNumber,
    contentSha256: await computeCheckpointDigest(source),
    bodySha256: await computeCheckpointDigest(""),
    snapshotIdAtExtractionCommit: `chapter-${chapterNumber}-r3`,
    snapshotRevisionAtExtractionCommit: 3,
    snapshotJsonSha256AtExtractionCommit: await computeCheckpointDigest(JSON.stringify(r3, null, 2)),
    canonOutcome: { status: "skipped" as const, reason: "no_facts" as const },
  }
  const projectionReceipt = {
    extractionHistoryPath: historyPath,
    snapshotId: `chapter-${chapterNumber}-r4`,
    revision: 4,
    snapshotJsonSha256: await computeCheckpointDigest(reads.get(snapshotJsonPath(pp, chapterNumber))!),
  }
  // 实际投影账本（按真实 schema 序列化）：fixture 声明 committed 的两个投影在盘上均记 committed。
  const ledgerPath = `${pp}/.novel/projection-status.json`
  const ledger = {
    schemaVersion: "2",
    chapters: {
      [String(chapterNumber)]: {
        graph_entity_pages: cell("graph_entity_pages"),
        sync_snapshot_to_memory: cell("sync_snapshot_to_memory"),
        community_summary: cell("community_summary"),
      },
    },
  }
  reads.set(ledgerPath, JSON.stringify(ledger, null, 2))
  const result: IngestResult = {
    snapshot: normalizeChapterSnapshot(r3),
    receipt,
    projectionReceipt,
    ledgerSaveFailed: false,
    factsStoreFailed: false,
    failedProjections: [],
    pendingProjections: [],
    committedProjections: ["graph_entity_pages", "sync_snapshot_to_memory", "community_summary"],
  }
  return { result, reads, receipt, projectionReceipt, ledgerPath }
}

const fm = (overrides: Record<string, unknown> = {}) => ({
  frontmatter: { type: "chapter", chapter_status: "final", chapter_number: 1, ...overrides },
  body: "",
})

describe("rebuild rebuildAllSnapshots", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.useWikiStore.getState.mockReturnValue({
      novelMode: true,
      embeddingConfig: { enabled: true, model: "m" },
    })
    mocks.flattenMdFilesBase.mockImplementation((tree: { name: string; path: string }[]) => tree)
    mocks.parseFrontmatter.mockImplementation((content: string) => fm(JSON.parse(content)))
  })

  it("returns early when novel mode disabled", async () => {
    mocks.useWikiStore.getState.mockReturnValue({ novelMode: false, embeddingConfig: { enabled: true, model: "m" } })
    const result = await rebuildAllSnapshots("C:/novel")
    expect(result).toEqual({ success: 0, failed: 0, errors: ["小说模式未开启"], outcomes: [] })
  })

  it("returns error when chapters and wiki dirs unreadable", async () => {
    mocks.listDirectory.mockRejectedValue(new Error("ENOENT"))
    const result = await rebuildAllSnapshots("C:/novel")
    expect(result.errors).toEqual(["无法读取章节目录"])
  })

  it("does not fall back to scanning wiki root when chapters dir is unreadable", async () => {
    mocks.listDirectory.mockImplementation(async (p: string) => {
      if (p.endsWith("/wiki/chapters")) throw new Error("no chapters dir")
      if (p.endsWith("/wiki")) return [mdNode("ch1.md", "C:/novel/wiki/ch1.md")]
      return []
    })
    const result = await rebuildAllSnapshots("C:/novel", undefined, { novelMode: true })
    expect(result).toEqual({ success: 0, failed: 0, errors: ["无法读取章节目录"], outcomes: [] })
    expect(mocks.listDirectory).toHaveBeenCalledTimes(1)
    expect(mocks.listDirectory).toHaveBeenCalledWith("C:/novel/wiki/chapters")
    expect(mocks.ingestChapter).not.toHaveBeenCalled()
  })

  it("reads chapter sources with exactUtf8 + BOM stripping and passes requireUniqueFinalChapter: true", async () => {
    mocks.listDirectory.mockResolvedValue([mdNode("ch1.md", "C:/novel/wiki/chapters/ch1.md")])
    mocks.readFile.mockResolvedValue('\uFEFF{"type":"chapter","chapter_status":"final","chapter_number":1}')
    mocks.isChapterPage.mockReturnValue(true)
    mocks.isFinalChapter.mockReturnValue(true)
    mocks.ingestChapter.mockResolvedValue({ snapshot: null, failReason: "duplicate_chapter_number" })

    const result = await rebuildAllSnapshots("C:/novel", undefined, { novelMode: true })
    expect(mocks.readFile).toHaveBeenCalledWith("C:/novel/wiki/chapters/ch1.md", { exactUtf8: true })
    expect(mocks.parseFrontmatter).toHaveBeenCalledWith('{"type":"chapter","chapter_status":"final","chapter_number":1}')
    expect(mocks.ingestChapter).toHaveBeenCalledWith(
      "C:/novel",
      "C:/novel/wiki/chapters/ch1.md",
      undefined,
      undefined,
      expect.objectContaining({
        awaitCommunitySummary: true,
        requireUniqueFinalChapter: true,
      }),
    )
    expect(result.failed).toBe(1)
    expect(result.outcomes).toEqual([
      { path: "C:/novel/wiki/chapters/ch1.md", chapterNumber: 1, status: "failed", reason: "duplicate_chapter_number" },
    ])
  })

  it("ingests chapters in order, skipping non-chapter files and unreadable ones", async () => {
    mocks.listDirectory.mockResolvedValue([
      mdNode("ch2.md", "C:/novel/wiki/chapters/ch2.md"),
      mdNode("ch1.md", "C:/novel/wiki/chapters/ch1.md"),
      mdNode("outline.md", "C:/novel/wiki/chapters/outline.md"),
      mdNode("draft.md", "C:/novel/wiki/chapters/draft.md"),
      mdNode("strnum.md", "C:/novel/wiki/chapters/strnum.md"),
    ])
    mocks.readFile.mockImplementation(async (p: string) => {
      if (p.endsWith("ch1.md")) return '{"type":"chapter","chapter_status":"final","chapter_number":1}'
      if (p.endsWith("ch2.md")) return '{"type":"chapter","chapter_status":"final","chapter_number":2}'
      if (p.endsWith("outline.md")) return '{"type":"outline"}'
      if (p.endsWith("draft.md")) return '{"type":"chapter","chapter_status":"draft","chapter_number":9}'
      if (p.endsWith("strnum.md")) return '{"type":"chapter","chapter_status":"final","chapter_number":"3"}'
      throw new Error("unreadable")
    })
    mocks.isChapterPage.mockImplementation((f: Record<string, unknown>) => f.type === "chapter")
    mocks.isFinalChapter.mockImplementation((f: Record<string, unknown>) => f.chapter_status === "final")
    mocks.ingestChapter.mockResolvedValue({ snapshot: {}, failReason: undefined })
    const progress: string[] = []
    const result = await rebuildAllSnapshots("C:/novel", (p) => {
      progress.push(`${p.completed}/${p.total}:${p.current}`)
    })
    expect(result.success).toBe(0)
    expect(result.failed).toBe(3)
    expect(progress[0]).toBe("0/3:第1章")
    expect(progress).toContain("1/3:第2章")
    expect(progress[3]).toContain("完成")
    // chapters sorted by chapterNumber（数字字符串经 parseChapterNumber 解析为 3）
    expect(mocks.ingestChapter.mock.calls[0][1]).toContain("ch1.md")
    expect(mocks.ingestChapter.mock.calls[1][1]).toContain("ch2.md")
    expect(mocks.ingestChapter.mock.calls[2][1]).toContain("strnum.md")
    // outcomes：枚举期 skip 先行（文件序），per-chapter failed 随后（章号序）。
    expect(result.outcomes.map(o => o.status)).toEqual(["skipped", "skipped", "failed", "failed", "failed"])
    expect(result.outcomes[0]).toMatchObject({ path: "C:/novel/wiki/chapters/outline.md", chapterNumber: null, reason: "not_chapter" })
    expect(result.outcomes[1]).toMatchObject({ path: "C:/novel/wiki/chapters/draft.md", chapterNumber: 9, reason: "not_final" })
    expect(result.outcomes.map(o => o.status !== "verified" ? o.reason : undefined)).toEqual([
      "not_chapter",
      "not_final",
      "Missing or mismatched ingest receipt.",
      "Missing or mismatched ingest receipt.",
      "Missing or mismatched ingest receipt.",
    ])
  })

  it("maps fail reasons to Chinese messages", async () => {
    mocks.listDirectory.mockResolvedValue([mdNode("ch1.md", "C:/novel/wiki/chapters/ch1.md")])
    mocks.readFile.mockResolvedValue('{"type":"chapter","chapter_status":"final","chapter_number":1}')
    mocks.isChapterPage.mockReturnValue(true)
    mocks.isFinalChapter.mockReturnValue(true)
    mocks.ingestChapter.mockResolvedValue({ snapshot: null, failReason: "invalid_chapter_number" })
    const r1 = await rebuildAllSnapshots("C:/novel")
    expect(r1.errors[0]).toContain("章节编号无效")

    mocks.ingestChapter.mockResolvedValue({ snapshot: null, failReason: "no_llm" })
    const r2 = await rebuildAllSnapshots("C:/novel")
    expect(r2.errors[0]).toContain("LLM 未配置")

    mocks.ingestChapter.mockResolvedValue({ snapshot: null, failReason: "other" })
    const r3 = await rebuildAllSnapshots("C:/novel")
    expect(r3.errors[0]).toContain("摄取返回空结果")
    expect(r3.failed).toBe(1)
  })

  it("records ingest exceptions as failures (Error and non-Error)", async () => {
    mocks.listDirectory.mockResolvedValue([
      mdNode("ch1.md", "C:/novel/wiki/chapters/ch1.md"),
      mdNode("ch2.md", "C:/novel/wiki/chapters/ch2.md"),
    ])
    mocks.readFile.mockImplementation(async (p: string) => {
      if (String(p).endsWith("ch1.md")) return '{"type":"chapter","chapter_status":"final","chapter_number":1}'
      if (String(p).endsWith("ch2.md")) return '{"type":"chapter","chapter_status":"final","chapter_number":2}'
      throw new Error("unreadable")
    })
    mocks.isChapterPage.mockReturnValue(true)
    mocks.isFinalChapter.mockReturnValue(true)
    mocks.ingestChapter
      .mockRejectedValueOnce(new Error("crash"))
      .mockRejectedValueOnce("plain boom")
    const result = await rebuildAllSnapshots("C:/novel")
    expect(result.failed).toBe(2)
    expect(result.errors[0]).toContain("crash")
    expect(result.errors[1]).toContain("plain boom")
    expect(result.outcomes.map(o => [o.status, o.status !== "verified" ? o.reason : undefined])).toEqual([["failed", "crash"], ["failed", "plain boom"]])
  })

  it("skips chapter files without parseable frontmatter", async () => {
    mocks.listDirectory.mockResolvedValue([mdNode("ch1.md", "C:/novel/wiki/chapters/ch1.md")])
    mocks.readFile.mockResolvedValue("no frontmatter here")
    mocks.parseFrontmatter.mockReturnValue({ frontmatter: null, body: "" })
    const result = await rebuildAllSnapshots("C:/novel")
    expect(result.success).toBe(0)
    expect(result.failed).toBe(0)
  })

  it("单个章节读不出来时只跳过该章，其余章节照常摄取", async () => {
    mocks.listDirectory.mockResolvedValue([
      mdNode("broken.md", "C:/novel/wiki/chapters/broken.md"),
      mdNode("ch2.md", "C:/novel/wiki/chapters/ch2.md"),
    ])
    // 并发读取阶段：broken.md 的 readFile 拒绝 → 映射为 {ok:false}，不得中断整批
    mocks.readFile.mockImplementation(async (p: string) => {
      if (p.endsWith("broken.md")) throw new Error("EACCES")
      return '{"type":"chapter","chapter_status":"final","chapter_number":2}'
    })
    mocks.isChapterPage.mockReturnValue(true)
    mocks.isFinalChapter.mockReturnValue(true)
    mocks.ingestChapter.mockResolvedValue({ snapshot: {}, failReason: undefined })

    const result = await rebuildAllSnapshots("C:/novel")

    // 失败读取记 skipped(source_unavailable)，绝不交给 ingestChapter；可读章按验证链计 failed。
    expect(result).toEqual({
      success: 0,
      failed: 1,
      errors: ["第2章：Missing or mismatched ingest receipt."],
      outcomes: [
        { path: "C:/novel/wiki/chapters/broken.md", chapterNumber: null, status: "skipped", reason: "source_unavailable" },
        { path: "C:/novel/wiki/chapters/ch2.md", chapterNumber: 2, status: "failed", reason: "Missing or mismatched ingest receipt." },
      ],
    })
    expect(mocks.ingestChapter).toHaveBeenCalledTimes(1)
    expect(mocks.ingestChapter.mock.calls[0][1]).toContain("ch2.md")
    expect(mocks.ingestChapter.mock.calls[0][1]).not.toContain("broken.md")
  })

  it("verified：两章全链回读通过 → verified 且保留精确对象引用；unreadable/non-final 记 skipped", async () => {
    const f1 = await mkVerifiedFixture("C:/novel/wiki/chapters/ch1.md", 1, '{"type":"chapter","chapter_status":"final","chapter_number":1}')
    const f2 = await mkVerifiedFixture("C:/novel/wiki/chapters/ch2.md", 2, '{"type":"chapter","chapter_status":"final","chapter_number":2}')
    // 两章共用同一账本文件：合并 chapters 覆盖两章（f1.reads 先于 f2 命中）。
    f1.reads.set(f1.ledgerPath, JSON.stringify({
      schemaVersion: "2",
      chapters: {
        "1": { graph_entity_pages: cell("graph_entity_pages"), sync_snapshot_to_memory: cell("sync_snapshot_to_memory"), community_summary: cell("community_summary") },
        "2": { graph_entity_pages: cell("graph_entity_pages"), sync_snapshot_to_memory: cell("sync_snapshot_to_memory"), community_summary: cell("community_summary") },
      },
    }, null, 2))
    mocks.listDirectory.mockResolvedValue([
      mdNode("broken.md", "C:/novel/wiki/chapters/broken.md"),
      mdNode("draft.md", "C:/novel/wiki/chapters/draft.md"),
      mdNode("ch1.md", "C:/novel/wiki/chapters/ch1.md"),
      mdNode("ch2.md", "C:/novel/wiki/chapters/ch2.md"),
    ])
    mocks.readFile.mockImplementation(async (p: string) => {
      const s = String(p)
      if (s.endsWith("broken.md")) throw new Error("EACCES")
      if (s.endsWith("draft.md")) return '{"type":"chapter","chapter_status":"draft","chapter_number":9}'
      for (const fx of [f1, f2]) {
        const hit = fx.reads.get(s)
        if (hit !== undefined) return hit
      }
      throw new Error(`unexpected read: ${s}`)
    })
    mocks.isChapterPage.mockReturnValue(true)
    mocks.isFinalChapter.mockImplementation((f: Record<string, unknown>) => f.chapter_status === "final")
    mocks.ingestChapter
      .mockResolvedValueOnce(f1.result)
      .mockResolvedValueOnce(f2.result)

    const result = await rebuildAllSnapshots("C:/novel")

    expect(result.success).toBe(2)
    expect(result.failed).toBe(0)
    expect(result.errors).toEqual([])
    const verified = result.outcomes.filter(o => o.status === "verified")
    expect(verified).toHaveLength(2)
    // verified 保留摄取端原对象引用（不重建/不克隆）。
    expect((verified[0] as { receipt: unknown }).receipt).toBe(f1.receipt)
    expect((verified[0] as { projectionReceipt: unknown }).projectionReceipt).toBe(f1.projectionReceipt)
    expect((verified[1] as { receipt: unknown }).receipt).toBe(f2.receipt)
    expect(result.outcomes[0]).toMatchObject({ path: "C:/novel/wiki/chapters/broken.md", status: "skipped", reason: "source_unavailable" })
    expect(result.outcomes[1]).toMatchObject({ path: "C:/novel/wiki/chapters/draft.md", status: "skipped", reason: "not_final" })
    // 无任何预期外路径读取（不误读其它目录）。
    for (const call of mocks.readFile.mock.calls) {
      const s = String(call[0])
      expect(s.endsWith("broken.md") || s.endsWith("draft.md") || f1.reads.has(s) || f2.reads.has(s)).toBe(true)
    }
  })

  it("验证链各闸口：投影账本/facts/投影失败、queued Canon、源篡改、归档篡改、current 篡改均计 failed 且保留证据引用", async () => {
    mocks.listDirectory.mockResolvedValue([mdNode("ch1.md", "C:/novel/wiki/chapters/ch1.md")])
    mocks.isChapterPage.mockReturnValue(true)
    mocks.isFinalChapter.mockReturnValue(true)

    const cases: Array<{
      name: string
      mutateResult?: (r: Record<string, unknown>) => void
      mutateReads?: (reads: Map<string, string>) => void
      reason: string
    }> = [
      { name: "ledger", mutateResult: (r) => { r.ledgerSaveFailed = true }, reason: "Snapshot projections are not verified." },
      { name: "facts", mutateResult: (r) => { r.factsStoreFailed = true }, reason: "Snapshot projections are not verified." },
      { name: "projection", mutateResult: (r) => { r.failedProjections = ["graph_entity_pages"] }, reason: "Snapshot projections are not verified." },
      ...["source_fence", "projection_runner"].map(stage => ({
        name: stage,
        mutateResult: (r: Record<string, unknown>) => {
          r.projectionError = { stage, message: "raw diagnostic that must not be reported" }
        },
        reason: `Snapshot projections are not verified (${stage}).`,
      })),
      {
        name: "canon",
        mutateResult: (r) => {
          (r.receipt as { canonOutcome: unknown }).canonOutcome = {
            status: "completed",
            report: { written: 1, queued: 1, results: [], reconcile: { consistent: true, divergences: [] } },
          }
        },
        reason: "Canon write did not reconcile.",
      },
      ...["no_deps", "not_eligible"].map(reason => ({
        name: `canon ${reason}`,
        mutateResult: (r: Record<string, unknown>) => {
          (r.receipt as { canonOutcome: unknown }).canonOutcome = { status: "skipped", reason }
        },
        reason: "Canon write did not reconcile.",
      })),
      { name: "source", mutateReads: (reads) => { reads.set("C:/novel/wiki/chapters/ch1.md", '{"tampered":true}') }, reason: "Chapter source changed after ingest." },
      {
        name: "archive",
        mutateReads: (reads) => {
          const historyPath = [...reads.keys()].find(k => k.includes("/history/"))!
          reads.set(historyPath, JSON.stringify({ tampered: true, isHistorical: true }))
        },
        reason: "Extraction archive does not match the ingest receipt.",
      },
      {
        name: "current",
        mutateReads: (reads) => {
          reads.set(snapshotJsonPath("C:/novel", 1), JSON.stringify({ tampered: true, isHistorical: false }))
        },
        reason: "Projected snapshot does not match the ingest receipt chain.",
      },
      { name: "receipt", mutateResult: (r) => { delete r.receipt }, reason: "Missing or mismatched ingest receipt." },
      { name: "pending", mutateResult: (r) => { r.pendingProjections = ["community_summary"] }, reason: "Snapshot projections are not verified." },
      {
        name: "ledger 缺 community_summary committed cell",
        mutateReads: (reads) => {
          reads.set("C:/novel/.novel/projection-status.json", JSON.stringify({
            schemaVersion: "2",
            chapters: { "1": {
              graph_entity_pages: cell("graph_entity_pages"),
              sync_snapshot_to_memory: cell("sync_snapshot_to_memory"),
            } },
          }, null, 2))
        },
        reason: "Projection ledger does not record committed projections.",
      },
    ]

    for (const c of cases) {
      const fx = await mkVerifiedFixture("C:/novel/wiki/chapters/ch1.md", 1, '{"type":"chapter","chapter_status":"final","chapter_number":1}')
      const result = { ...fx.result }
      c.mutateResult?.(result)
      if (c.mutateReads) c.mutateReads(fx.reads)
      mocks.readFile.mockImplementation(async (p: string) => {
        const hit = fx.reads.get(String(p))
        if (hit !== undefined) return hit
        throw new Error(`unexpected read: ${String(p)}`)
      })
      mocks.ingestChapter.mockResolvedValue(result)
      const run = await rebuildAllSnapshots("C:/novel")
      expect(run.success, `case ${c.name}`).toBe(0)
      expect(run.failed, `case ${c.name}`).toBe(1)
      expect(run.outcomes, `case ${c.name}`).toEqual([
        { path: "C:/novel/wiki/chapters/ch1.md", chapterNumber: 1, status: "failed", reason: c.reason,
          ...(result.receipt ? { receipt: fx.receipt } : {}),
          projectionReceipt: fx.projectionReceipt },
      ])
    }
  })

  it("投影账本缺失/损坏 → failed 且保留 receipt 证据", async () => {
    mocks.listDirectory.mockResolvedValue([mdNode("ch1.md", "C:/novel/wiki/chapters/ch1.md")])
    mocks.isChapterPage.mockReturnValue(true)
    mocks.isFinalChapter.mockReturnValue(true)

    // 缺失：ledger 路径无读内容 → 读失败计 failed。
    const missing = await mkVerifiedFixture("C:/novel/wiki/chapters/ch1.md", 1, '{"type":"chapter","chapter_status":"final","chapter_number":1}')
    missing.reads.delete(missing.ledgerPath)
    mocks.readFile.mockImplementation(async (p: string) => {
      const hit = missing.reads.get(String(p))
      if (hit !== undefined) return hit
      throw new Error(`ENOENT: ${String(p)}`)
    })
    mocks.ingestChapter.mockResolvedValue(missing.result)
    const runMissing = await rebuildAllSnapshots("C:/novel")
    expect(runMissing.failed).toBe(1)
    expect(runMissing.outcomes[0]).toMatchObject({ status: "failed", receipt: missing.receipt })
    const missingOutcome = runMissing.outcomes[0]!
    if (missingOutcome.status === "verified") throw new Error("expected failed outcome")
    expect(missingOutcome.reason).toContain("committed projections")

    // 损坏：ledger JSON 不可解析 → failed（receipt 证据保留）。
    const corrupt = await mkVerifiedFixture("C:/novel/wiki/chapters/ch1.md", 1, '{"type":"chapter","chapter_status":"final","chapter_number":1}')
    corrupt.reads.set(corrupt.ledgerPath, "{not json")
    mocks.readFile.mockImplementation(async (p: string) => {
      const hit = corrupt.reads.get(String(p))
      if (hit !== undefined) return hit
      throw new Error(`ENOENT: ${String(p)}`)
    })
    mocks.ingestChapter.mockResolvedValue(corrupt.result)
    const runCorrupt = await rebuildAllSnapshots("C:/novel")
    expect(runCorrupt.failed).toBe(1)
    expect(runCorrupt.outcomes[0]).toMatchObject({ status: "failed", receipt: corrupt.receipt })
    const corruptOutcome = runCorrupt.outcomes[0]!
    if (corruptOutcome.status === "verified") throw new Error("expected failed outcome")
    expect(corruptOutcome.reason.length).toBeGreaterThan(0)
  })

  it("重号章号 → 两章均不交给 ingest，outcomes 双 failed duplicate_chapter_number", async () => {
    mocks.listDirectory.mockResolvedValue([
      mdNode("a.md", "C:/novel/wiki/chapters/a.md"),
      mdNode("b.md", "C:/novel/wiki/chapters/b.md"),
    ])
    mocks.readFile.mockResolvedValue('{"type":"chapter","chapter_status":"final","chapter_number":3}')
    mocks.isChapterPage.mockReturnValue(true)
    mocks.isFinalChapter.mockReturnValue(true)

    const result = await rebuildAllSnapshots("C:/novel")

    expect(mocks.ingestChapter).not.toHaveBeenCalled()
    expect(result.failed).toBe(2)
    expect(result.errors).toEqual(["第3章：duplicate chapter number", "第3章：duplicate chapter number"])
    expect(result.outcomes).toEqual([
      { path: "C:/novel/wiki/chapters/a.md", chapterNumber: 3, status: "failed", reason: "duplicate_chapter_number" },
      { path: "C:/novel/wiki/chapters/b.md", chapterNumber: 3, status: "failed", reason: "duplicate_chapter_number" },
    ])
  })
})



it("BOM 章源 → 回读核验成功（exactUtf8 原文哈希 + BOM-stripped body 解析）", async () => {
    const bomSource = "﻿" + '{"type":"chapter","chapter_status":"final","chapter_number":1}'
    const fixture = await mkVerifiedFixture("C:/novel/wiki/chapters/ch1.md", 1, bomSource)
    // contentSha256 基于含 BOM 的原始字节；parseFrontmatter 收到 BOM-stripped 内容
    fixture.receipt.contentSha256 = await computeCheckpointDigest(bomSource)
    mocks.parseFrontmatter.mockImplementation((content: string) => fm(JSON.parse(content)))
    mocks.readFile.mockImplementation(async (p: string) => {
      const hit = fixture.reads.get(String(p))
      if (hit !== undefined) return hit
      throw new Error(`ENOENT: ${String(p)}`)
    })
    await expect(verifyRebuildOutcome("C:/novel", { path: "C:/novel/wiki/chapters/ch1.md", chapterNumber: 1 }, fixture.result))
      .resolves.toMatchObject({ receipt: expect.any(Object) })
    expect(mocks.parseFrontmatter).toHaveBeenCalledWith('{"type":"chapter","chapter_status":"final","chapter_number":1}')
  })

it("malformed ledger auditTrail → invalid ledger document（语义损坏亦 rejected）", async () => {
    const fixture = await mkVerifiedFixture("C:/novel/wiki/chapters/ch1.md", 1, '{"type":"chapter","chapter_status":"final","chapter_number":1}')
    fixture.reads.set(fixture.ledgerPath, JSON.stringify({
      schemaVersion: "2",
      chapters: { "1": { graph_entity_pages: cell("graph_entity_pages"), sync_snapshot_to_memory: cell("sync_snapshot_to_memory"), community_summary: cell("community_summary") } },
      auditTrail: [{ status: "committed" }],
    }))
    mocks.readFile.mockImplementation(async (p: string) => {
      const hit = fixture.reads.get(String(p))
      if (hit !== undefined) return hit
      throw new Error(`ENOENT: ${String(p)}`)
    })
    await expect(verifyRebuildOutcome("C:/novel", { path: "C:/novel/wiki/chapters/ch1.md", chapterNumber: 1 }, fixture.result))
      .rejects.toThrow("invalid ledger document")
  })

describe("rebuild rebuildVectorIndex", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.useWikiStore.getState.mockReturnValue({
      novelMode: true,
      embeddingConfig: { enabled: true, model: "m" },
    })
    mocks.flattenMdFilesBase.mockImplementation((tree: { name: string; path: string }[]) => tree)
    mocks.embedPage.mockResolvedValue(undefined)
  })

  it("returns early when embedding disabled or no model", async () => {
    mocks.useWikiStore.getState.mockReturnValue({
      novelMode: true,
      embeddingConfig: { enabled: false, model: "m" },
    })
    expect(await rebuildVectorIndex("C:/novel")).toEqual({
      indexed: 0,
      errors: ["向量嵌入未启用或未配置模型"],
    })
    mocks.useWikiStore.getState.mockReturnValue({
      novelMode: true,
      embeddingConfig: { enabled: true, model: "" },
    })
    expect(await rebuildVectorIndex("C:/novel")).toEqual({
      indexed: 0,
      errors: ["向量嵌入未启用或未配置模型"],
    })
  })

  it("returns error when wiki dir unreadable", async () => {
    mocks.listDirectory.mockRejectedValue(new Error("ENOENT"))
    expect(await rebuildVectorIndex("C:/novel")).toEqual({
      indexed: 0,
      errors: ["无法读取 wiki 目录"],
    })
  })

  it("embeds pages with title from heading or file name", async () => {
    mocks.listDirectory.mockResolvedValue([
      mdNode("page.md", "C:/novel/wiki/page.md"),
      mdNode("no-title.md", "C:/novel/wiki/no-title.md"),
    ])
    mocks.readFile.mockImplementation(async (p: string) =>
      p.endsWith("page.md") ? "# 标题页\n正文" : "无标题正文",
    )
    const progress: string[] = []
    const result = await rebuildVectorIndex("C:/novel", (p) => progress.push(p.current))
    expect(result.indexed).toBe(2)
    expect(result.errors).toEqual([])
    expect(mocks.embedPage).toHaveBeenCalledWith(
      "C:/novel",
      "page",
      "标题页",
      "# 标题页\n正文",
      { enabled: true, model: "m" },
    )
    expect(mocks.embedPage).toHaveBeenCalledWith(
      "C:/novel",
      "no-title",
      "no-title",
      "无标题正文",
      { enabled: true, model: "m" },
    )
    expect(progress).toContain("page.md")
    expect(progress).toContain("完成")
  })

  it("collects embed errors per page (Error and non-Error)", async () => {
    mocks.listDirectory.mockResolvedValue([
      mdNode("bad.md", "C:/novel/wiki/bad.md"),
      mdNode("worse.md", "C:/novel/wiki/worse.md"),
      mdNode("good.md", "C:/novel/wiki/good.md"),
    ])
    mocks.readFile.mockResolvedValue("正文")
    mocks.embedPage.mockImplementation(async (_pp: string, pageId: string) => {
      if (pageId === "bad") throw new Error("embed failed")
      if (pageId === "worse") throw "plain fail"
    })
    const result = await rebuildVectorIndex("C:/novel")
    expect(result.indexed).toBe(1)
    expect(result.errors).toEqual(["bad.md：embed failed", "worse.md：plain fail"])
  })

  it("accepts explicit embedding config override", async () => {
    mocks.listDirectory.mockResolvedValue([mdNode("a.md", "C:/novel/wiki/a.md")])
    mocks.readFile.mockResolvedValue("正文")
    await rebuildVectorIndex("C:/novel", undefined, { enabled: true, model: "override" } as never)
    expect(mocks.embedPage).toHaveBeenCalledWith(
      expect.any(String),
      "a",
      "a",
      "正文",
      { enabled: true, model: "override" },
    )
  })
})
