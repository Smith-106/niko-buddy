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

function mkParams(snapshot: ChapterSnapshot) {
  const runCanonDualWriteHook = vi.fn(async () => {})
  return {
    params: {
      pp: "E:/Novel",
      snapshot,
      fm: { title: "第十二章 雪夜" },
      canonDualWriteDeps: undefined,
      runCanonDualWriteHook,
    },
    runCanonDualWriteHook,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  fsMocks.readFile.mockReset()
  fsMocks.readFile.mockRejectedValue(new Error("ENOENT: no facts.json"))
  fsMocks.writeFileAtomic.mockReset()
  fsMocks.writeFileAtomic.mockResolvedValue(undefined)
  ioMocks.saveSnapshot.mockReset()
  ioMocks.saveSnapshot.mockResolvedValue(undefined)
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

    await expect(commitIngestSnapshot(params)).resolves.toBeUndefined()

    expect(loggerMocks.warn).toHaveBeenCalledWith(
      "Chapter Ingest",
      "facts-store write skipped",
      expect.objectContaining({ error: expect.stringContaining("EROFS") }),
    )
    // 吞错边界不得中断提交后链路
    expect(runCanonDualWriteHook).toHaveBeenCalledTimes(1)
    expect(validationMocks.clearTemporalFactsCache).not.toHaveBeenCalled()
  })
})
