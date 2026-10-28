import { beforeEach, describe, expect, it, vi } from "vitest"
import type { ChapterSnapshot } from "./chapter-ingest"

const chapterIngestMocks = vi.hoisted(() => ({
  loadSnapshot: vi.fn(),
  listSnapshots: vi.fn(),
}))

vi.mock("@/lib/novel/chapter-ingest", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/novel/chapter-ingest")>()
  return {
    ...actual,
    loadSnapshot: chapterIngestMocks.loadSnapshot,
    listSnapshots: chapterIngestMocks.listSnapshots,
  }
})

const fsMocks = vi.hoisted(() => ({
  listDirectory: vi.fn(),
  getFileModifiedTime: vi.fn(),
  readFile: vi.fn(),
}))

vi.mock("@/commands/fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/commands/fs")>()
  return {
    ...actual,
    listDirectory: fsMocks.listDirectory,
    getFileModifiedTime: fsMocks.getFileModifiedTime,
    readFile: fsMocks.readFile,
  }
})

import {
  __resetTemporalFactsCacheForTests,
  loadAllSnapshots,
  loadTemporalFactsCached,
} from "./context-engine-temporal"

function snapshotFile(name: string): { name: string; path: string; is_dir: boolean } {
  return { name, path: `/P/.novel/snapshots/${name}`, is_dir: false }
}

function makeSnapshot(n: number): ChapterSnapshot {
  return {
    chapterNumber: n,
    summary: `第${n}章摘要`,
    endingHook: "",
    characterStateChanges: [],
    foreshadowingChanges: [],
    timelineEvents: [],
    newCanonFacts: [`事实${n}`],
  } as unknown as ChapterSnapshot
}

describe("ISS-20260709-030 cold-cache singleflight单次构建", () => {
  beforeEach(() => {
    __resetTemporalFactsCacheForTests()
    chapterIngestMocks.loadSnapshot.mockReset()
    chapterIngestMocks.listSnapshots.mockReset()
    fsMocks.listDirectory.mockReset()
    fsMocks.getFileModifiedTime.mockReset()
    fsMocks.readFile.mockReset()
  })

  it("concurrent cold-cache loads share one build (loadSnapshot once per snapshot)", async () => {
    fsMocks.listDirectory.mockResolvedValue([
      snapshotFile("001.snapshot.json"),
      snapshotFile("002.snapshot.json"),
    ])
    fsMocks.getFileModifiedTime.mockResolvedValue(1_000)
    // facts.json absent → snapshot fold path
    fsMocks.readFile.mockRejectedValue(new Error("not found"))
    chapterIngestMocks.listSnapshots.mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 20))
      return [1, 2]
    })
    chapterIngestMocks.loadSnapshot.mockImplementation(async (_pp: string, n: number) => makeSnapshot(n))

    const [first, second] = await Promise.all([
      loadTemporalFactsCached("/P"),
      loadTemporalFactsCached("/P"),
    ])

    // One build total: each snapshot loaded once, not twice
    expect(chapterIngestMocks.loadSnapshot).toHaveBeenCalledTimes(2)
    expect(first).toBe(second)
    expect(first.length).toBeGreaterThan(0)
  })
})

/**
 * ISS-20260709-030 第二层：同一次 buildContextPack 里 relatedChapters 与
 * temporal facts 各自调 loadAllSnapshots，同批 snapshot 只应 readFile 一次。
 */
describe("ISS-20260709-030 loadAllSnapshots in-flight 去重", () => {
  beforeEach(() => {
    __resetTemporalFactsCacheForTests()
    chapterIngestMocks.loadSnapshot.mockReset()
    chapterIngestMocks.listSnapshots.mockReset()
    fsMocks.listDirectory.mockReset()
    fsMocks.getFileModifiedTime.mockReset()
    fsMocks.readFile.mockReset()
  })

  it("并发两次 loadAllSnapshots 共享一次 list+load", async () => {
    chapterIngestMocks.listSnapshots.mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 20))
      return [1, 2, 3]
    })
    chapterIngestMocks.loadSnapshot.mockImplementation(async (_pp: string, n: number) => makeSnapshot(n))

    const [a, b] = await Promise.all([loadAllSnapshots("/P"), loadAllSnapshots("/P")])

    expect(a).toHaveLength(3)
    expect(b).toHaveLength(3)
    expect(chapterIngestMocks.listSnapshots).toHaveBeenCalledTimes(1)
    expect(chapterIngestMocks.loadSnapshot).toHaveBeenCalledTimes(3)
  })

  it("settle 后释放 in-flight，后续调用重新加载（不引入持久缓存）", async () => {
    chapterIngestMocks.listSnapshots.mockResolvedValue([1])
    chapterIngestMocks.loadSnapshot.mockImplementation(async (_pp: string, n: number) => makeSnapshot(n))

    await loadAllSnapshots("/P")
    await loadAllSnapshots("/P")

    expect(chapterIngestMocks.listSnapshots).toHaveBeenCalledTimes(2)
  })
})
