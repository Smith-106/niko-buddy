import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  readFile: vi.fn(),
  writeFileAtomic: vi.fn(),
  normalizePath: vi.fn((p: string) => p),
}))

vi.mock("@/commands/fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/commands/fs")>()
  return {
    ...actual,
      readFile: (...args: unknown[]) => mocks.readFile(...args),
      writeFileAtomic: (...args: unknown[]) => mocks.writeFileAtomic(...args),
  }
})

vi.mock("@/lib/path-utils", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/path-utils")>()
  return {
    ...actual,
      normalizePath: (p: string) => mocks.normalizePath(p),
  }
})

import { getTimelineEvents, loadTimeline, mergeSnapshotTimeline, removeChapterTimelineEvents } from "./timeline"

describe("timeline", () => {
  beforeEach(() => {
    mocks.readFile.mockReset()
    mocks.writeFileAtomic.mockReset()
  })

  it("loads an existing timeline file", async () => {
    mocks.readFile.mockResolvedValueOnce(JSON.stringify({
      version: 1,
      entries: [{ chapterNumber: 2, event: "事件B" }],
      serial: 1,
      updatedAt: "2026-01-01",
    }))

    const tl = await loadTimeline("E:/Novel")
    expect(tl.version).toBe(1)
    expect(tl.entries).toEqual([{ chapterNumber: 2, event: "事件B" }])
    expect(mocks.normalizePath).toHaveBeenCalledWith("E:/Novel")
  })

  it("returns an empty structure when the file is missing", async () => {
    const err: NodeJS.ErrnoException = new Error("ENOENT")
    err.code = "ENOENT"
    mocks.readFile.mockRejectedValueOnce(err)
    expect(await loadTimeline("E:/Novel")).toEqual({ version: 1, entries: [], serial: 0, updatedAt: "" })
  })

  it.each([
    new Error("EACCES: permission denied"),
    new Error("INVALID_UTF8: invalid data"),
    new Error("Failed to read exact UTF-8 from 'E:/not found/.novel/timeline.json': Access is denied. (os error 5)"),
  ])(
    "merge rejects on real read failure (%s) and writes nothing",
    async (readError) => {
      mocks.readFile.mockRejectedValueOnce(readError)
      await expect(mergeSnapshotTimeline("E:/Novel", 1, ["新事件"])).rejects.toBe(readError)
      expect(mocks.writeFileAtomic).not.toHaveBeenCalled()
    },
  )

  it.each([
    "not json",
    JSON.stringify({ version: 2, entries: [] }),
    JSON.stringify({ version: 1, entries: [null], serial: 1, updatedAt: "" }),
  ])("merge rejects on invalid timeline document and writes nothing", async (rawDoc) => {
    mocks.readFile.mockResolvedValueOnce(rawDoc)
    await expect(mergeSnapshotTimeline("E:/Novel", 1, ["新事件"])).rejects.toThrow()
    expect(mocks.writeFileAtomic).not.toHaveBeenCalled()
  })

  it("mergeSnapshotTimeline no-ops on empty events", async () => {
    await mergeSnapshotTimeline("E:/Novel", 1, [])
    expect(mocks.writeFileAtomic).not.toHaveBeenCalled()
  })

  it("mergeSnapshotTimeline appends and dedupes events, bumping serial", async () => {
    mocks.readFile.mockResolvedValueOnce(JSON.stringify({
      version: 1,
      entries: [{ chapterNumber: 1, event: "既有事件" }],
      serial: 5,
      updatedAt: "",
    }))

    await mergeSnapshotTimeline("E:/Novel", 1, ["既有事件", "新事件", "新事件"])

    expect(mocks.writeFileAtomic).toHaveBeenCalledTimes(1)
    const [path, content] = mocks.writeFileAtomic.mock.calls[0] as [string, string]
    expect(path).toContain(".novel/timeline.json")
    const written = JSON.parse(content)
    expect(written.serial).toBe(6)
    expect(written.entries).toEqual([
      { chapterNumber: 1, event: "既有事件" },
      { chapterNumber: 1, event: "新事件" },
    ])
    expect(written.updatedAt).toBeTruthy()
  })

  it("getTimelineEvents sorts by chapter number", async () => {
    mocks.readFile.mockResolvedValueOnce(JSON.stringify({
      version: 1,
      entries: [
        { chapterNumber: 3, event: "三" },
        { chapterNumber: 1, event: "一" },
        { chapterNumber: 2, event: "二" },
      ],
      serial: 0,
      updatedAt: "",
    }))

    const events = await getTimelineEvents("E:/Novel")
    expect(events.map((e) => e.chapterNumber)).toEqual([1, 2, 3])
  })

  it("does not write when appending would overflow the timeline serial", async () => {
    mocks.readFile.mockResolvedValueOnce(JSON.stringify({ version: 1, entries: [], serial: Number.MAX_SAFE_INTEGER, updatedAt: "" }))
    await expect(mergeSnapshotTimeline("E:/Novel", 1, ["new event"])).rejects.toThrow("Timeline serial is exhausted")
    expect(mocks.writeFileAtomic).not.toHaveBeenCalled()
  })

  it("serializes concurrent merges — both events land", async () => {
    let raw = JSON.stringify({ version: 1, entries: [], serial: 0, updatedAt: "" })
    mocks.readFile.mockImplementation(async () => raw)
    mocks.writeFileAtomic.mockImplementation(async (_path: string, value: string) => { raw = value })
    await Promise.all([
      mergeSnapshotTimeline("E:/Novel", 1, ["A"]),
      mergeSnapshotTimeline("E:/Novel", 2, ["B"]),
    ])
    const written = JSON.parse(raw)
    expect(written.entries).toEqual([
      { chapterNumber: 1, event: "A" },
      { chapterNumber: 2, event: "B" },
    ])
  })

  it("R2-M03 removeChapterTimelineEvents removes target chapter events under lock and no-ops when absent", async () => {
    mocks.readFile.mockResolvedValueOnce(JSON.stringify({
      version: 1,
      entries: [
        { chapterNumber: 1, event: "第一章" },
        { chapterNumber: 2, event: "第二章A" },
        { chapterNumber: 2, event: "第二章B" },
        { chapterNumber: 3, event: "第三章" },
      ],
      serial: 4,
      updatedAt: "2026-01-01",
    }))

    await expect(removeChapterTimelineEvents("E:/Novel", 2)).resolves.toBe(true)
    expect(mocks.writeFileAtomic).toHaveBeenCalledTimes(1)
    const written = JSON.parse(mocks.writeFileAtomic.mock.calls[0]![1] as string)
    expect(written.serial).toBe(5)
    expect(written.entries).toEqual([
      { chapterNumber: 1, event: "第一章" },
      { chapterNumber: 3, event: "第三章" },
    ])

    // 无该章或文件缺失时零写盘返回 false
    mocks.writeFileAtomic.mockClear()
    const enoent = Object.assign(new Error("ENOENT"), { code: "ENOENT" })
    mocks.readFile.mockRejectedValueOnce(enoent)
    await expect(removeChapterTimelineEvents("E:/Novel", 99)).resolves.toBe(false)
    expect(mocks.writeFileAtomic).not.toHaveBeenCalled()
  })
})
