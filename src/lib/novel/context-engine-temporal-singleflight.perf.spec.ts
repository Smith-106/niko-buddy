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
  __getTemporalFactsInFlightSizeForTests,
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

/**
 * ISS-20260709-030 singleflight 可观测性 + facts.json 故障回退。
 *
 * 覆盖 loadTemporalFactsCachedInner 的三个分支：
 *   - in-flight 计数器读写（__getTemporalFactsInFlightSizeForTests）
 *   - 重复 readdir 行同 path → mtime 只取一次（ISS-20260709-026 去重）
 *   - 空快照 + facts.json 不可读 → fail-open []（空 catch 防御）
 *   - 快照存在 + facts.json 有效 → 优先投影事实表，不读快照
 */
describe("ISS-20260709-030 singleflight 可观测性与 facts.json 回退", () => {
  beforeEach(() => {
    __resetTemporalFactsCacheForTests()
    chapterIngestMocks.loadSnapshot.mockReset()
    chapterIngestMocks.listSnapshots.mockReset()
    fsMocks.listDirectory.mockReset()
    fsMocks.getFileModifiedTime.mockReset()
    fsMocks.readFile.mockReset()
  })

  it("reset 后 in-flight 为 0；冷构建期间为 1，settle 后回到 0", async () => {
    expect(__getTemporalFactsInFlightSizeForTests()).toBe(0)
    fsMocks.listDirectory.mockResolvedValue([snapshotFile("001.snapshot.json")])
    fsMocks.getFileModifiedTime.mockResolvedValue(1_000)
    fsMocks.readFile.mockRejectedValue(new Error("not found"))
    chapterIngestMocks.listSnapshots.mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 20))
      return [1]
    })
    chapterIngestMocks.loadSnapshot.mockImplementation(async (_pp: string, n: number) => makeSnapshot(n))

    const pending = loadTemporalFactsCached("/P-inflight")
    // 同步 map 写入先于首个 await：并发调用可观测到在建构建
    expect(__getTemporalFactsInFlightSizeForTests()).toBe(1)
    const facts = await pending
    expect(facts.length).toBeGreaterThan(0)
    expect(__getTemporalFactsInFlightSizeForTests()).toBe(0)
  })

  it("重复 readdir 行（同 path，均携带 mtime）→ 第二行命中去重，结果仍正确折叠", async () => {
    // 同一快照文件出现两行（大小写别名/重复 readdir）：首行写入 map，次行命中去重
    const dup = { ...snapshotFile("001.snapshot.json"), mtime_ms: 1_000 }
    fsMocks.listDirectory.mockResolvedValue([dup, { ...dup }])
    fsMocks.readFile.mockRejectedValue(new Error("not found"))
    chapterIngestMocks.listSnapshots.mockResolvedValue([1])
    chapterIngestMocks.loadSnapshot.mockImplementation(async (_pp: string, n: number) => makeSnapshot(n))

    const facts = await loadTemporalFactsCached("/P-dupe")
    // 同趟 readdir 元数据复用：无需逐个取 mtime；折叠结果不受重复行影响
    expect(fsMocks.getFileModifiedTime).not.toHaveBeenCalled()
    expect(facts.length).toBeGreaterThan(0)
  })

  it("空快照 + facts.json 不可读 → fail-open []（catch 不抛错）", async () => {
    fsMocks.listDirectory.mockResolvedValue([])
    fsMocks.readFile.mockRejectedValue(new Error("facts.json missing"))

    const facts = await loadTemporalFactsCached("/P-empty-unreadable")
    expect(facts).toEqual([])
    expect(fsMocks.readFile).toHaveBeenCalledWith("/P-empty-unreadable/.novel/facts.json")
  })

  it("快照存在 + facts.json 损坏 → 回退快照折叠（additive 安全，不因坏表阻断）", async () => {
    fsMocks.listDirectory.mockResolvedValue([snapshotFile("001.snapshot.json")])
    fsMocks.getFileModifiedTime.mockResolvedValue(1_000)
    fsMocks.readFile.mockResolvedValue("corrupted{{{not-json")
    chapterIngestMocks.listSnapshots.mockResolvedValue([1])
    chapterIngestMocks.loadSnapshot.mockImplementation(async (_pp: string, n: number) => makeSnapshot(n))

    const facts = await loadTemporalFactsCached("/P-facts-corrupt")
    // 坏表不阻断：回退到快照折叠，快照链被实际读取
    expect(chapterIngestMocks.loadSnapshot).toHaveBeenCalled()
    expect(facts.length).toBeGreaterThan(0)
    expect(facts.some((f) => f.source.startsWith("facts-file:"))).toBe(false)
  })

  it("快照存在 + facts.json 有效 → 优先投影事实表，不读快照", async () => {
    fsMocks.listDirectory.mockResolvedValue([snapshotFile("001.snapshot.json")])
    fsMocks.getFileModifiedTime.mockResolvedValue(1_000)
    fsMocks.readFile.mockResolvedValue(
      JSON.stringify({
        schema_version: "facts/1.0",
        facts: [
          {
            id: "f1",
            subject: "林动",
            predicate: "持有",
            object: "青铜古戒",
            valid_at: 1,
          },
        ],
        episodes: [],
        next_id: 2,
      }),
    )
    chapterIngestMocks.listSnapshots.mockResolvedValue([1])
    chapterIngestMocks.loadSnapshot.mockImplementation(async (_pp: string, n: number) => makeSnapshot(n))

    const facts = await loadTemporalFactsCached("/P-facts-first")
    // 事实表命中：投影 facts-file 来源，快照链一次也不读
    expect(facts).toHaveLength(1)
    expect(facts[0]).toMatchObject({ subject: "林动", object: "青铜古戒", source: "facts-file:f1" })
    expect(chapterIngestMocks.loadSnapshot).not.toHaveBeenCalled()
  })
})
