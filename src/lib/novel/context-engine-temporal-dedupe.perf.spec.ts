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
