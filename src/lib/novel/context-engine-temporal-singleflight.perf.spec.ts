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
    fsMocks.readFile.mockImplementation(async (path: string) => {
      if (path.endsWith("/.novel/facts.json")) return "corrupted{{{not-json"
      throw new Error("ENOENT")
    })
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

describe("K-6 / R2-P1-2 时序事实缓存 6 段 revision 与 .novel 浅层列举", () => {
  beforeEach(() => {
    __resetTemporalFactsCacheForTests()
    chapterIngestMocks.loadSnapshot.mockReset()
    chapterIngestMocks.listSnapshots.mockReset()
    fsMocks.listDirectory.mockReset()
    fsMocks.getFileModifiedTime.mockReset()
    fsMocks.readFile.mockReset()
  })

  function makeFactsJson(objectVal: string): string {
    return JSON.stringify({
      schema_version: "facts/1.0",
      facts: [{ id: "f1", subject: "林动", predicate: "持有", object: objectVal, valid_at: 1 }],
      episodes: [],
      next_id: 2,
    })
  }

  it("浅层 listDirectory(.novel, { maxDepth: 1 }) 并行直读 snapshots/（0 次 getFileModifiedTime）且 facts.json / snapshots 变更均立即失效", async () => {
    let factsMtime = 1_000
    let snapMtime = 100
    let factsPayload = makeFactsJson("旧古戒")
    fsMocks.listDirectory.mockImplementation(async (dir: string, options?: { maxDepth?: number }) => {
      if (dir === "/P-k6/.novel") {
        expect(options).toEqual({ maxDepth: 1 })
        return [
          { name: "facts.json", path: "/P-k6/.novel/facts.json", is_dir: false, mtime_ms: factsMtime },
          {
            name: "projection-status.json",
            path: "/P-k6/.novel/projection-status.json",
            is_dir: false,
            mtime_ms: 500,
          },
          // 浅层列举不展开 snapshots.children（免疫 MAX_TREE_NODES=20_000 截断）
          { name: "snapshots", path: "/P-k6/.novel/snapshots", is_dir: true },
        ]
      }
      if (dir === "/P-k6/.novel/snapshots") {
        return [
          { name: "001.snapshot.json", path: "/P-k6/.novel/snapshots/001.snapshot.json", is_dir: false, mtime_ms: snapMtime },
        ]
      }
      throw new Error(`unexpected listDirectory: ${dir}`)
    })
    fsMocks.readFile.mockImplementation(async (p: string) => {
      if (p === "/P-k6/.novel/facts.json") return factsPayload
      throw new Error("ENOENT")
    })

    const first = await loadTemporalFactsCached("/P-k6")
    expect(first[0]?.object).toBe("旧古戒")
    expect(fsMocks.listDirectory).toHaveBeenCalledWith("/P-k6/.novel", { maxDepth: 1 })
    expect(fsMocks.listDirectory).toHaveBeenCalledWith("/P-k6/.novel/snapshots")
    expect(fsMocks.getFileModifiedTime).not.toHaveBeenCalled()

    // mtime 未变 → 命中缓存，不再读 facts.json
    fsMocks.readFile.mockClear()
    const hit = await loadTemporalFactsCached("/P-k6")
    expect(hit).toBe(first)
    expect(fsMocks.readFile).not.toHaveBeenCalled()

    // facts.json mtime 变化 → 6 段 revision 失效，重读 facts.json
    factsMtime = 2_000
    factsPayload = makeFactsJson("新古戒")
    const refreshed = await loadTemporalFactsCached("/P-k6")
    expect(refreshed).not.toBe(first)
    expect(refreshed[0]?.object).toBe("新古戒")

    // snapshots/*.snapshot.json mtime 变化 → 6 段 revision 同样失效
    snapMtime = 300
    factsPayload = makeFactsJson("快照刷新后古戒")
    const refreshedBySnap = await loadTemporalFactsCached("/P-k6")
    expect(refreshedBySnap).not.toBe(refreshed)
    expect(refreshedBySnap[0]?.object).toBe("快照刷新后古戒")
    expect(fsMocks.getFileModifiedTime).not.toHaveBeenCalled()
  })

  it("兼容旧 mock：snapshots 直读为空且 .novel 树返回 snapshots.children 时回退提取子树（0 次 getFileModifiedTime）", async () => {
    let snapMtime = 100
    fsMocks.listDirectory.mockImplementation(async (dir: string) => {
      if (dir === "/P-k6-compat/.novel") {
        return [
          {
            name: "snapshots",
            path: "/P-k6-compat/.novel/snapshots",
            is_dir: true,
            children: [
              {
                name: "001.snapshot.json",
                path: "/P-k6-compat/.novel/snapshots/001.snapshot.json",
                is_dir: false,
                mtime_ms: snapMtime,
              },
            ],
          },
        ]
      }
      throw new Error(`unexpected listDirectory: ${dir}`)
    })
    fsMocks.readFile.mockRejectedValue(new Error("ENOENT"))
    chapterIngestMocks.listSnapshots.mockResolvedValue([1])
    chapterIngestMocks.loadSnapshot.mockImplementation(async (_pp: string, n: number) => makeSnapshot(n))

    const first = await loadTemporalFactsCached("/P-k6-compat")
    expect(first.length).toBeGreaterThan(0)
    expect(chapterIngestMocks.loadSnapshot).toHaveBeenCalledTimes(1)
    expect(fsMocks.listDirectory).toHaveBeenCalledWith("/P-k6-compat/.novel", { maxDepth: 1 })
    expect(fsMocks.getFileModifiedTime).not.toHaveBeenCalled()

    // 子树中 snapshot mtime 变更仍触发失效
    snapMtime = 250
    await loadTemporalFactsCached("/P-k6-compat")
    expect(chapterIngestMocks.loadSnapshot).toHaveBeenCalledTimes(2)
    expect(fsMocks.getFileModifiedTime).not.toHaveBeenCalled()
  })

  it("空快照下 facts.json 新增/变更使 emptyRevision 失效", async () => {
    let hasFacts = false
    let factsMtime = 0
    let factsPayload = ""
    fsMocks.listDirectory.mockImplementation(async (dir: string) => {
      if (dir === "/P-k6-empty/.novel") {
        return [
          ...(hasFacts
            ? [{ name: "facts.json", path: "/P-k6-empty/.novel/facts.json", is_dir: false, mtime_ms: factsMtime }]
            : []),
          { name: "snapshots", path: "/P-k6-empty/.novel/snapshots", is_dir: true },
        ]
      }
      if (dir === "/P-k6-empty/.novel/snapshots") return []
      throw new Error(`unexpected listDirectory: ${dir}`)
    })
    fsMocks.readFile.mockImplementation(async (p: string) => {
      if (p === "/P-k6-empty/.novel/facts.json" && hasFacts) return factsPayload
      throw new Error("ENOENT")
    })

    const empty = await loadTemporalFactsCached("/P-k6-empty")
    expect(empty).toEqual([])
    expect(fsMocks.listDirectory).toHaveBeenCalledWith("/P-k6-empty/.novel", { maxDepth: 1 })

    // 写入 facts.json → emptyRevision 从 0:0:0:0:0:0 变为 0:0:0:0:3000:0，缓存失效
    hasFacts = true
    factsMtime = 3_000
    factsPayload = makeFactsJson("空快照新事实")
    const populated = await loadTemporalFactsCached("/P-k6-empty")
    expect(populated).toHaveLength(1)
    expect(populated[0]?.object).toBe("空快照新事实")
    expect(fsMocks.listDirectory).toHaveBeenCalledWith("/P-k6-empty/.novel/snapshots")
  })

  it("projection-status.json 变更使缓存失效（快照不变也重折叠）", async () => {
    let ledgerMtime = 100
    fsMocks.listDirectory.mockImplementation(async (dir: string) => {
      if (dir === "/P-k6-ledger/.novel") {
        return [
          {
            name: "projection-status.json",
            path: "/P-k6-ledger/.novel/projection-status.json",
            is_dir: false,
            mtime_ms: ledgerMtime,
          },
          { name: "snapshots", path: "/P-k6-ledger/.novel/snapshots", is_dir: true },
        ]
      }
      if (dir === "/P-k6-ledger/.novel/snapshots") {
        return [
          {
            name: "001.snapshot.json",
            path: "/P-k6-ledger/.novel/snapshots/001.snapshot.json",
            is_dir: false,
            mtime_ms: 1_000,
          },
        ]
      }
      return []
    })
    fsMocks.readFile.mockRejectedValue(new Error("ENOENT"))
    chapterIngestMocks.listSnapshots.mockResolvedValue([1])
    chapterIngestMocks.loadSnapshot.mockImplementation(async (_pp: string, n: number) => makeSnapshot(n))

    await loadTemporalFactsCached("/P-k6-ledger")
    expect(chapterIngestMocks.loadSnapshot).toHaveBeenCalledTimes(1)
    expect(fsMocks.listDirectory).toHaveBeenCalledWith("/P-k6-ledger/.novel", { maxDepth: 1 })

    // 台账 mtime 变化 → 失效并重新加载快照
    ledgerMtime = 200
    await loadTemporalFactsCached("/P-k6-ledger")
    expect(chapterIngestMocks.loadSnapshot).toHaveBeenCalledTimes(2)
    expect(fsMocks.getFileModifiedTime).not.toHaveBeenCalled()
  })

  it("节点存在但缺 mtime_ms → 回退 getFileModifiedTime（单节点抛错降级 0 不阻断）", async () => {
    fsMocks.listDirectory.mockImplementation(async (dir: string) => {
      if (dir === "/P-k6-fallback/.novel") {
        return [
          { name: "facts.json", path: "/P-k6-fallback/.novel/facts.json", is_dir: false },
          { name: "projection-status.json", path: "/P-k6-fallback/.novel/projection-status.json", is_dir: false },
          { name: "snapshots", path: "/P-k6-fallback/.novel/snapshots", is_dir: true },
        ]
      }
      return []
    })
    let factsMtime = 100
    fsMocks.getFileModifiedTime.mockImplementation(async (p: string) => {
      if (p.endsWith("facts.json")) return factsMtime
      throw new Error("stat failed")
    })
    let payload = makeFactsJson("回退甲")
    fsMocks.readFile.mockImplementation(async (p: string) => {
      if (p.endsWith("facts.json")) return payload
      throw new Error("ENOENT")
    })

    const first = await loadTemporalFactsCached("/P-k6-fallback")
    expect(first[0]?.object).toBe("回退甲")
    expect(fsMocks.getFileModifiedTime).toHaveBeenCalledWith("/P-k6-fallback/.novel/facts.json")
    expect(fsMocks.getFileModifiedTime).toHaveBeenCalledWith("/P-k6-fallback/.novel/projection-status.json")

    factsMtime = 200
    payload = makeFactsJson("回退乙")
    const second = await loadTemporalFactsCached("/P-k6-fallback")
    expect(second[0]?.object).toBe("回退乙")
  })

  it("listDirectory(.novel) 抛错 → 异常降级回退 listSnapshotEntriesWithMtime", async () => {
    fsMocks.listDirectory.mockImplementation(async (dir: string) => {
      if (dir === "/P-k6-err/.novel") throw new Error("permission denied")
      if (dir === "/P-k6-err/.novel/snapshots") {
        return [{ name: "001.snapshot.json", path: "/P-k6-err/.novel/snapshots/001.snapshot.json", is_dir: false, mtime_ms: 999 }]
      }
      return []
    })
    fsMocks.readFile.mockRejectedValue(new Error("ENOENT"))
    chapterIngestMocks.listSnapshots.mockResolvedValue([1])
    chapterIngestMocks.loadSnapshot.mockImplementation(async (_pp: string, n: number) => makeSnapshot(n))

    const facts = await loadTemporalFactsCached("/P-k6-err")
    expect(facts.length).toBeGreaterThan(0)
    expect(fsMocks.listDirectory).toHaveBeenCalledWith("/P-k6-err/.novel", { maxDepth: 1 })
    expect(fsMocks.listDirectory).toHaveBeenCalledWith("/P-k6-err/.novel/snapshots")
  })
})
