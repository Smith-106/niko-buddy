import { beforeEach, describe, expect, it, vi } from "vitest"
import {
  __resetTemporalFactsCacheForTests,
  listSnapshotEntriesWithMtime,
} from "./context-engine-temporal"

const mocks = vi.hoisted(() => ({
  listDirectory: vi.fn(),
  getFileModifiedTime: vi.fn<(path: string) => Promise<number>>(),
}))

vi.mock("@/commands/fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/commands/fs")>()
  return {
    ...actual,
    listDirectory: mocks.listDirectory,
    getFileModifiedTime: mocks.getFileModifiedTime,
  }
})

beforeEach(() => {
  vi.clearAllMocks()
  __resetTemporalFactsCacheForTests()
})

function file(name: string, path: string): { name: string; path: string; is_dir: boolean } {
  return { name, path, is_dir: false }
}

describe("ISS-20260709-026 listSnapshotEntriesWithMtime key去重", () => {
  it("duplicate file.path values share one getFileModifiedTime call with order backfilled", async () => {
    const dupPath = "/P/.novel/snapshots/001.snapshot.json"
    mocks.listDirectory.mockResolvedValue([
      file("001.snapshot.json", dupPath),
      file("001.snapshot.json", dupPath),
      file("002.snapshot.json", "/P/.novel/snapshots/002.snapshot.json"),
    ])
    mocks.getFileModifiedTime.mockImplementation(async (p: string) =>
      p.endsWith("001.snapshot.json") ? 111 : 222,
    )

    const entries = await listSnapshotEntriesWithMtime("/P")

    expect(entries).toEqual([
      { number: 1, snapshotMtime: 111 },
      { number: 1, snapshotMtime: 111 },
      { number: 2, snapshotMtime: 222 },
    ])
    // Two unique keys → two getters, not three
    expect(mocks.getFileModifiedTime).toHaveBeenCalledTimes(2)
  })

  it("unique paths still fetch one mtime each", async () => {
    mocks.listDirectory.mockResolvedValue([
      file("001.snapshot.json", "/P/.novel/snapshots/001.snapshot.json"),
      file("002.snapshot.json", "/P/.novel/snapshots/002.snapshot.json"),
    ])
    mocks.getFileModifiedTime.mockResolvedValue(1000)
    const entries = await listSnapshotEntriesWithMtime("/P")
    expect(entries).toHaveLength(2)
    expect(mocks.getFileModifiedTime).toHaveBeenCalledTimes(2)
  })
})

/**
 * ISS-20260709-032：FileNode 携带 mtime_ms 后，listDirectory 一趟 readdir
 * 即可拿到 mtime，不再逐文件发 getFileModifiedTime IPC。
 */
describe("ISS-20260709-032 mtime 随 readdir 返回，零额外 IPC", () => {
  it("全部节点带 mtime_ms → 不调用 getFileModifiedTime", async () => {
    mocks.listDirectory.mockResolvedValue([
      { name: "001.snapshot.json", path: "/P/.novel/snapshots/001.snapshot.json", is_dir: false, mtime_ms: 111 },
      { name: "002.snapshot.json", path: "/P/.novel/snapshots/002.snapshot.json", is_dir: false, mtime_ms: 222 },
    ])
    const entries = await listSnapshotEntriesWithMtime("/P")
    expect(entries).toEqual([
      { number: 1, snapshotMtime: 111 },
      { number: 2, snapshotMtime: 222 },
    ])
    expect(mocks.getFileModifiedTime).not.toHaveBeenCalled()
  })

  it("混合节点：仅缺 mtime_ms 的回退逐个取，其余复用 readdir 值", async () => {
    mocks.listDirectory.mockResolvedValue([
      { name: "001.snapshot.json", path: "/P/.novel/snapshots/001.snapshot.json", is_dir: false, mtime_ms: 111 },
      { name: "002.snapshot.json", path: "/P/.novel/snapshots/002.snapshot.json", is_dir: false },
    ])
    mocks.getFileModifiedTime.mockResolvedValue(999)
    const entries = await listSnapshotEntriesWithMtime("/P")
    expect(entries).toEqual([
      { number: 1, snapshotMtime: 111 },
      { number: 2, snapshotMtime: 999 },
    ])
    expect(mocks.getFileModifiedTime).toHaveBeenCalledTimes(1)
    expect(mocks.getFileModifiedTime).toHaveBeenCalledWith("/P/.novel/snapshots/002.snapshot.json")
  })
})
