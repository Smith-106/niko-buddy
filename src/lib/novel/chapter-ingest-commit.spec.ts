// @vitest-environment node
/**
 * chapter-ingest-commit.spec.ts — 提交点（commit-then-project 的 commit 段）单元契约。
 *
 * 母模块 chapter-ingest.ts 的测试都从 `ingestChapter` 顶端正向驱动，facts-store
 * 段落里「既有 facts.json 可读」与「facts 段任一步骤抛错 → 外层 non-fatal 降级」
 * 两个面从未被单独钉住。本文件直接调用 `commitIngestSnapshot`，在模块边界 mock
 * IO 与各校验器，专测这两条降级/续读路径：
 *   - 111：facts.json 存在且合法 → 复用既有表（不重建空表）
 *   - 143-147：facts 段落内 throw → warn 降级，但后续 canon 双写钩子照常执行
 */
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { ChapterSnapshot } from "./chapter-ingest"
import { ensureSnapshotIdentity, normalizeChapterSnapshot } from "./chapter-snapshot-normalize"
import { computeCheckpointDigest } from "./checkpoint-digest"
import type { ShadowWriteReport } from "./canon-dual-write"
import type {
  CommitIngestSnapshotParams,
  IngestSourceRead,
} from "./chapter-ingest-commit"

const fsMocks = vi.hoisted(() => ({
  readFile: vi.fn(),
  writeFileAtomic: vi.fn(),
}))

const ioMocks = vi.hoisted(() => ({
  saveSnapshot: vi.fn(),
  saveChapterIngestOutput: vi.fn(),
}))

const validationMocks = vi.hoisted(() => ({
  linkSnapshotEntities: vi.fn(),
  validateEntityReferences: vi.fn(),
  validateCanonConflicts: vi.fn(),
  clearTemporalFactsCache: vi.fn(),
}))

const loggerMocks = vi.hoisted(() => ({
  warn: vi.fn(),
  info: vi.fn(),
}))

vi.mock("@/commands/fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/commands/fs")>()
  return { ...actual, readFile: fsMocks.readFile, writeFileAtomic: fsMocks.writeFileAtomic }
})

vi.mock("@/lib/utils", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/utils")>()
  return {
    ...actual,
    logger: { ...actual.logger, warn: loggerMocks.warn, info: loggerMocks.info },
  }
})

vi.mock("./chapter-ingest-snapshot-io", () => ({
  saveSnapshot: ioMocks.saveSnapshot,
  saveChapterIngestOutput: ioMocks.saveChapterIngestOutput,
}))

vi.mock("./chapter-ingest-entity-validation", () => ({
  linkSnapshotEntities: validationMocks.linkSnapshotEntities,
  validateEntityReferences: validationMocks.validateEntityReferences,
  validateCanonConflicts: validationMocks.validateCanonConflicts,
}))

vi.mock("./truth-authority-adapter", () => ({
  runTruthAuthorityCheck: () => [],
}))

vi.mock("./context-engine", () => ({
  clearTemporalFactsCache: validationMocks.clearTemporalFactsCache,
}))

import { commitIngestSnapshot } from "./chapter-ingest-commit"

function mkSnapshot(overrides: Partial<ChapterSnapshot> = {}): ChapterSnapshot {
  return {
    chapterId: "ch-0012",
    chapterNumber: 12,
    summary: "第十二章摘要",
    characters: ["林烬"],
    locations: ["旧城"],
    organizations: [],
    items: [],
    events: [],
    characterStateChanges: [],
    relationshipChanges: [],
    knowledgeChanges: [],
    foreshadowingChanges: [],
    newCanonFacts: [],
    timelineEvents: [],
    conflicts: [],
    endingHook: "钩子",
    graphNodes: [],
    graphEdges: [],
    ...overrides,
  } as ChapterSnapshot
}

function mkParams(snapshot: ChapterSnapshot, overrides: Partial<CommitIngestSnapshotParams> = {}) {
  const runCanonDualWriteHook = vi.fn(async () => ({ status: "skipped" as const, reason: "no_deps" as const }))
  return {
    params: {
      pp: "E:/Novel",
      snapshot,
      fm: { title: "第十二章 雪夜" },
      canonDualWriteDeps: undefined,
      runCanonDualWriteHook,
      ...overrides,
    } as CommitIngestSnapshotParams,
    runCanonDualWriteHook,
  }
}

/** 真实 saver 的 normalized 产出（canonicalize 在无别名的 mkSnapshot 上为恒等）。 */
function normalizeAsSaver(snapshot: ChapterSnapshot): ChapterSnapshot {
  const normalized = normalizeChapterSnapshot(ensureSnapshotIdentity(snapshot), {
    chapterId: snapshot.chapterId,
    chapterNumber: snapshot.chapterNumber,
  })
  if (!normalized) throw new Error("Invalid snapshot data.")
  return normalized
}

const CHAPTER_SOURCE = "---\ntype: chapter\nchapter_number: 12\nchapter_status: final\n---\n\n# 第十二章\n\n正文内容……"

function mkSourceRead(overrides: Partial<IngestSourceRead> = {}): IngestSourceRead {
  return {
    readPath: "E:/Novel/wiki/chapters/chapter-012.md",
    chapterNumber: 12,
    originalContent: CHAPTER_SOURCE,
    bodySha256: "body-sha-012",
    contentSha256: "content-sha-012",
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  fsMocks.readFile.mockReset()
  fsMocks.readFile.mockRejectedValue(new Error("ENOENT: no facts.json"))
  fsMocks.writeFileAtomic.mockReset()
  fsMocks.writeFileAtomic.mockResolvedValue(undefined)
  ioMocks.saveSnapshot.mockReset()
  ioMocks.saveSnapshot.mockImplementation(async (_pp: string, snapshot: ChapterSnapshot) => normalizeAsSaver(snapshot))
  ioMocks.saveChapterIngestOutput.mockReset()
  ioMocks.saveChapterIngestOutput.mockResolvedValue(undefined)
  validationMocks.linkSnapshotEntities.mockReset()
  validationMocks.linkSnapshotEntities.mockResolvedValue([])
  validationMocks.validateEntityReferences.mockReset()
  validationMocks.validateEntityReferences.mockResolvedValue([])
  validationMocks.validateCanonConflicts.mockReset()
  validationMocks.validateCanonConflicts.mockResolvedValue([])
  validationMocks.clearTemporalFactsCache.mockReset()
  loggerMocks.warn.mockReset()
  loggerMocks.info.mockReset()
})

describe("commitIngestSnapshot — facts-store 段", () => {
  it("既有 facts.json 可读 → 在既有表上追加，不重建空表（原 fact id 保留）", async () => {
    fsMocks.readFile.mockResolvedValue(
      JSON.stringify({
        schema_version: "facts/1.0",
        facts: [
          { id: "f1", subject: "林烬", predicate: "状态", object: "仍在旧城", valid_at: 3, source: "chapter-ingest newCanonFacts" },
        ],
        episodes: [{ id: "e1", chapter: 3, factIds: ["f1"] }],
        next_id: 2,
      }),
    )

    const snapshot = mkSnapshot({ newCanonFacts: ["林烬左手受伤"] })
    const { params, runCanonDualWriteHook } = mkParams(snapshot)
    await commitIngestSnapshot(params)

    // 写入真源是 .novel/facts.json，一次写、内容为「旧 fact + 新 fact」
    expect(fsMocks.writeFileAtomic).toHaveBeenCalledTimes(1)
    const [factsPath, raw] = fsMocks.writeFileAtomic.mock.calls[0] as [string, string]
    expect(factsPath).toBe("E:/Novel/.novel/facts.json")
    const written = JSON.parse(raw) as { facts: Array<{ id: string; object: string }>; next_id: number }
    expect(written.facts.map((f) => f.id)).toEqual(["f1", "fact-2"])
    expect(written.facts[1]!.object).toBe("林烬左手受伤")
    // 读侧接线：facts 表变更后失效 temporal cache
    expect(validationMocks.clearTemporalFactsCache).toHaveBeenCalledWith("E:/Novel")
    // 未走「文件缺失 → 空表重建」的 warn 分支
    expect(loggerMocks.warn).not.toHaveBeenCalledWith(
      "Chapter Ingest",
      "facts file missing or corrupt, rebuild empty (non-fatal)",
      expect.anything(),
    )
    expect(runCanonDualWriteHook).toHaveBeenCalledTimes(1)
  })

  it("facts.json 缺失 → 空表重建后写入（零迁移成本路径）", async () => {
    const snapshot = mkSnapshot({ newCanonFacts: ["旧城被洪水淹没"] })
    const { params } = mkParams(snapshot)
    await commitIngestSnapshot(params)

    expect(loggerMocks.warn).toHaveBeenCalledWith(
      "Chapter Ingest",
      "facts file missing or corrupt, rebuild empty (non-fatal)",
      expect.objectContaining({ error: expect.stringContaining("ENOENT") }),
    )
    const raw = fsMocks.writeFileAtomic.mock.calls[0]![1] as string
    const written = JSON.parse(raw) as { facts: Array<{ id: string }> }
    expect(written.facts.map((f) => f.id)).toEqual(["fact-1"])
  })

  it("facts 段写入失败 → 仅 warn，提交点不抛错且 canon 钩子照常执行", async () => {
    fsMocks.readFile.mockRejectedValue(new Error("ENOENT: no facts.json"))
    fsMocks.writeFileAtomic.mockRejectedValue(new Error("EROFS: read-only fs"))

    const snapshot = mkSnapshot({ newCanonFacts: ["旧城被洪水淹没"] })
    const { params, runCanonDualWriteHook } = mkParams(snapshot)

    const result = await commitIngestSnapshot(params)

    expect(loggerMocks.warn).toHaveBeenCalledWith(
      "Chapter Ingest",
      "facts-store write skipped",
      expect.objectContaining({ error: expect.stringContaining("EROFS") }),
    )
    // 吞错边界不得中断提交后链路：facts 写入失败后 Canon 钩子仍按原语义执行。
    expect(result.status).toBe("committed")
    if (result.status !== "committed") throw new Error("expected committed result")
    expect(result.snapshot.revision).toBe(1)
    expect(result.snapshot.snapshotId).toBe("ch-0012-r1")
    expect(result.sourceBinding).toBeNull()
    expect(result.receipt).toBeNull()
    expect(result.canonOutcome).toEqual({ status: "skipped", reason: "no_deps" })
    expect(runCanonDualWriteHook).toHaveBeenCalledTimes(1)
    expect(validationMocks.clearTemporalFactsCache).not.toHaveBeenCalled()
  })

  it("legacy 无 sourceRead：不额外读章节源，sourceBinding/receipt 为 null（不得读作 bound）", async () => {
    const snapshot = mkSnapshot({ newCanonFacts: [] })
    const { params } = mkParams(snapshot)

    const result = await commitIngestSnapshot(params)

    expect(result.status).toBe("committed")
    if (result.status !== "committed") throw new Error("expected committed result")
    expect(result.sourceBinding).toBeNull()
    expect(result.receipt).toBeNull()
    // 唯一一次 readFile 是 facts.json（无 facts 段会跳过写入）；从未读章节源。
    expect(fsMocks.readFile).toHaveBeenCalledTimes(1)
    expect((fsMocks.readFile.mock.calls[0] as unknown[])[0]).toBe("E:/Novel/.novel/facts.json")
    expect(ioMocks.saveSnapshot).toHaveBeenCalledTimes(1)
    expect(ioMocks.saveChapterIngestOutput).toHaveBeenCalledWith(
      "E:/Novel",
      result.snapshot,
      { title: "第十二章 雪夜" },
    )
  })

  it("sourceRead：校验后同路径严格相等才提交；output/Canon/receipt 共用 saver 返回的 normalized snapshot", async () => {
    const snapshot = mkSnapshot({ newCanonFacts: [] })
    const sourceRead = mkSourceRead()
    fsMocks.readFile.mockImplementation(async (path: string) => {
      if (String(path) === sourceRead.readPath) return CHAPTER_SOURCE
      throw new Error("ENOENT: no facts.json")
    })
    const canonReport: ShadowWriteReport = {
      written: 1,
      queued: 0,
      results: [{ digest: "op-digest", legacy: { ok: true }, canon: { ok: true, revision: 23 }, consistent: true }],
      reconcile: { consistent: true, divergences: [] },
    }
    const canonOutcome = { status: "completed" as const, report: canonReport }
    const runCanonDualWriteHook = vi.fn(
      async (
        _deps: unknown,
        _projectPath: string,
        _fm: Record<string, unknown>,
        _snapshot: ChapterSnapshot,
        _now: number,
      ) => canonOutcome,
    )
    const { params } = mkParams(snapshot, { sourceRead, runCanonDualWriteHook })

    const result = await commitIngestSnapshot(params)

    expect(result.status).toBe("committed")
    if (result.status !== "committed") throw new Error("expected committed result")
    // saver 收到的仍是 pre-commit snapshot；output/Canon/receipt 用 saver 返回值。
    expect(ioMocks.saveSnapshot.mock.calls[0]![1]).toBe(snapshot)
    expect(result.snapshot).not.toBe(snapshot)
    expect(result.snapshot.snapshotId).toBe("ch-0012-r1")
    expect(ioMocks.saveChapterIngestOutput).toHaveBeenCalledTimes(1)
    expect(ioMocks.saveChapterIngestOutput.mock.calls[0]![1]).toBe(result.snapshot)
    expect(runCanonDualWriteHook).toHaveBeenCalledTimes(1)
    expect(runCanonDualWriteHook.mock.calls[0]![3]).toBe(result.snapshot)
    expect(result.canonOutcome).toBe(canonOutcome)

    expect(result.sourceBinding).toEqual({
      readPath: sourceRead.readPath,
      chapterNumber: 12,
      bodySha256: sourceRead.bodySha256,
      contentSha256: sourceRead.contentSha256,
    })
    expect(result.receipt).toEqual({
      readPath: sourceRead.readPath,
      chapterNumber: 12,
      bodySha256: sourceRead.bodySha256,
      contentSha256: sourceRead.contentSha256,
      snapshotIdAtExtractionCommit: "ch-0012-r1",
      snapshotRevisionAtExtractionCommit: 1,
      snapshotJsonSha256AtExtractionCommit: await computeCheckpointDigest(
        JSON.stringify(result.snapshot, null, 2),
      ),
      canonOutcome,
    })
    // 无正文/无 originalContent 进入可发布结果。
    expect(Object.keys(result.sourceBinding!)).not.toContain("originalContent")
    expect(JSON.stringify(result.receipt)).not.toContain("正文内容")
  })

  it("提交顺序：同路径源复查 → 严格相等 → saveSnapshot → output/Canon（同一 signal 在 save 前检查）", async () => {
    const snapshot = mkSnapshot({ newCanonFacts: [] })
    const sourceRead = mkSourceRead()
    fsMocks.readFile.mockImplementation(async (path: string) => {
      if (String(path) === sourceRead.readPath) return CHAPTER_SOURCE
      throw new Error("ENOENT: no facts.json")
    })
    const { params, runCanonDualWriteHook } = mkParams(snapshot, { sourceRead })

    const result = await commitIngestSnapshot(params)
    expect(result.status).toBe("committed")

    const sourceReadOrder = fsMocks.readFile.mock.invocationCallOrder[0]!
    const saveOrder = ioMocks.saveSnapshot.mock.invocationCallOrder[0]!
    const outputOrder = ioMocks.saveChapterIngestOutput.mock.invocationCallOrder[0]!
    const canonOrder = runCanonDualWriteHook.mock.invocationCallOrder[0]!
    expect(sourceReadOrder).toBeLessThan(saveOrder)
    expect(saveOrder).toBeLessThan(outputOrder)
    expect(outputOrder).toBeLessThan(canonOrder)
  })

  it("同路径内容变化 → source_changed；本次 saveSnapshot/output/facts/Canon 全部未开始", async () => {
    const snapshot = mkSnapshot({ newCanonFacts: [] })
    const sourceRead = mkSourceRead()
    fsMocks.readFile.mockImplementation(async (path: string) => {
      if (String(path) === sourceRead.readPath) return `${CHAPTER_SOURCE}外部改写`
      throw new Error("ENOENT: no facts.json")
    })
    const { params, runCanonDualWriteHook } = mkParams(snapshot, { sourceRead })

    const result = await commitIngestSnapshot(params)

    expect(result).toEqual({
      status: "source_changed",
      sourceReadRef: {
        readPath: sourceRead.readPath,
        chapterNumber: 12,
        bodySha256: sourceRead.bodySha256,
        contentSha256: sourceRead.contentSha256,
      },
    })
    expect(ioMocks.saveSnapshot).not.toHaveBeenCalled()
    expect(ioMocks.saveChapterIngestOutput).not.toHaveBeenCalled()
    expect(fsMocks.writeFileAtomic).not.toHaveBeenCalled()
    expect(runCanonDualWriteHook).not.toHaveBeenCalled()
    // 只做了源复查一次读；未进入 facts 段。
    expect(fsMocks.readFile).toHaveBeenCalledTimes(1)
  })

  it("同路径不可读 → source_unavailable（不当成匹配），零 save/output/facts/Canon", async () => {
    const snapshot = mkSnapshot({ newCanonFacts: [] })
    const sourceRead = mkSourceRead()
    fsMocks.readFile.mockImplementation(async (path: string) => {
      if (String(path) === sourceRead.readPath) throw new Error("EACCES: permission denied")
      throw new Error("ENOENT: no facts.json")
    })
    const { params, runCanonDualWriteHook } = mkParams(snapshot, { sourceRead })

    const result = await commitIngestSnapshot(params)

    expect(result.status).toBe("source_unavailable")
    if (result.status !== "source_unavailable") throw new Error("expected source_unavailable")
    expect(result.reason).toContain("EACCES")
    expect(result.sourceReadRef?.readPath).toBe(sourceRead.readPath)
    expect(ioMocks.saveSnapshot).not.toHaveBeenCalled()
    expect(ioMocks.saveChapterIngestOutput).not.toHaveBeenCalled()
    expect(fsMocks.writeFileAtomic).not.toHaveBeenCalled()
    expect(runCanonDualWriteHook).not.toHaveBeenCalled()
  })

  it("同一 AbortSignal 在 saveSnapshot 前已取消 → cancelled，零 save/output/facts/Canon", async () => {
    const snapshot = mkSnapshot({ newCanonFacts: [] })
    const sourceRead = mkSourceRead()
    const controller = new AbortController()
    // 源复查这一步完成后才取消 → 只能由紧跟 saveSnapshot 前的同一 signal 检查拦住。
    fsMocks.readFile.mockImplementation(async (path: string) => {
      if (String(path) === sourceRead.readPath) {
        controller.abort()
        return CHAPTER_SOURCE
      }
      throw new Error("ENOENT: no facts.json")
    })
    const { params, runCanonDualWriteHook } = mkParams(snapshot, { sourceRead, signal: controller.signal })

    const result = await commitIngestSnapshot(params)

    expect(result.status).toBe("cancelled")
    if (result.status !== "cancelled") throw new Error("expected cancelled")
    expect(result.sourceReadRef?.readPath).toBe(sourceRead.readPath)
    expect(ioMocks.saveSnapshot).not.toHaveBeenCalled()
    expect(ioMocks.saveChapterIngestOutput).not.toHaveBeenCalled()
    expect(fsMocks.writeFileAtomic).not.toHaveBeenCalled()
    expect(runCanonDualWriteHook).not.toHaveBeenCalled()
  })

  it("实体校验异常被非致命 catch 吸收后，源守卫仍在 catch 外执行：变化仍拒绝", async () => {
    validationMocks.linkSnapshotEntities.mockRejectedValueOnce(new Error("link boom"))
    const snapshot = mkSnapshot({ newCanonFacts: [] })
    const sourceRead = mkSourceRead()
    fsMocks.readFile.mockImplementation(async (path: string) => {
      if (String(path) === sourceRead.readPath) return `${CHAPTER_SOURCE}改`
      throw new Error("ENOENT: no facts.json")
    })
    const { params } = mkParams(snapshot, { sourceRead })

    const result = await commitIngestSnapshot(params)

    expect(loggerMocks.warn).toHaveBeenCalledWith(
      "Chapter Ingest",
      "Validation failed",
      expect.objectContaining({ error: expect.stringContaining("link boom") }),
    )
    expect(result.status).toBe("source_changed")
    expect(ioMocks.saveSnapshot).not.toHaveBeenCalled()
  })
})
