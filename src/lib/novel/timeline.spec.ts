import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  readFile: vi.fn(),
  writeFile: vi.fn(),
  normalizePath: vi.fn((p: string) => p),
}))

vi.mock("@/commands/fs", () => ({
  readFile: (...args: unknown[]) => mocks.readFile(...args),
  writeFile: (...args: unknown[]) => mocks.writeFile(...args),
}))

vi.mock("@/lib/path-utils", () => ({
  normalizePath: (p: string) => mocks.normalizePath(p),
}))

import { getTimelineEvents, loadTimeline, mergeSnapshotTimeline } from "./timeline"

describe("timeline", () => {
  beforeEach(() => {
    mocks.readFile.mockReset()
    mocks.writeFile.mockReset()
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

  it("returns an empty structure when the file is missing or invalid", async () => {
    const err: NodeJS.ErrnoException = new Error("ENOENT")
    err.code = "ENOENT"
    mocks.readFile.mockRejectedValueOnce(err)
    expect(await loadTimeline("E:/Novel")).toEqual({ version: 1, entries: [], serial: 0, updatedAt: "" })

    // invalid JSON
    mocks.readFile.mockResolvedValueOnce("not json")
    expect(await loadTimeline("E:/Novel")).toEqual({ version: 1, entries: [], serial: 0, updatedAt: "" })

    // wrong shape (version mismatch)
    mocks.readFile.mockResolvedValueOnce(JSON.stringify({ version: 2, entries: [] }))
    expect(await loadTimeline("E:/Novel")).toEqual({ version: 1, entries: [], serial: 0, updatedAt: "" })
  })

  it("mergeSnapshotTimeline no-ops on empty events", async () => {
    await mergeSnapshotTimeline("E:/Novel", 1, [])
    expect(mocks.writeFile).not.toHaveBeenCalled()
  })

  it("mergeSnapshotTimeline appends and dedupes events, bumping serial", async () => {
    mocks.readFile.mockResolvedValueOnce(JSON.stringify({
      version: 1,
      entries: [{ chapterNumber: 1, event: "既有事件" }],
      serial: 5,
      updatedAt: "",
    }))

    await mergeSnapshotTimeline("E:/Novel", 1, ["既有事件", "新事件", "新事件"])

    expect(mocks.writeFile).toHaveBeenCalledTimes(1)
    const [path, content] = mocks.writeFile.mock.calls[0] as [string, string]
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
})
