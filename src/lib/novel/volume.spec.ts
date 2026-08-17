import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  searchWiki: vi.fn(),
  readFile: vi.fn(),
}))

vi.mock("@/lib/search", () => ({
  searchWiki: mocks.searchWiki,
}))
vi.mock("@/commands/fs", () => ({
  readFile: mocks.readFile,
}))

import { getChapterVolumes, isVolumePage, parseVolumeMeta } from "./volume"

describe("volume parseVolumeMeta", () => {
  it("parses numeric volume_number and typed fields", () => {
    const meta = parseVolumeMeta({
      volume_number: 2,
      title: "第二卷",
      summary: "简介",
      chapter_range_start: 11,
      chapter_range_end: 20,
    })
    expect(meta).toEqual({
      volumeNumber: 2,
      title: "第二卷",
      summary: "简介",
      chapterRangeStart: 11,
      chapterRangeEnd: 20,
    })
  })

  it("parses string volume_number and range strings", () => {
    const meta = parseVolumeMeta({
      volume_number: "3",
      chapter_range_start: "21",
      chapter_range_end: "30",
    })
    expect(meta?.volumeNumber).toBe(3)
    expect(meta?.chapterRangeStart).toBe(21)
    expect(meta?.chapterRangeEnd).toBe(30)
    expect(meta?.title).toBe("第3卷") // default title
    expect(meta?.summary).toBe("") // default summary
  })

  it("returns null for missing/invalid/zero/negative volume numbers", () => {
    expect(parseVolumeMeta({})).toBeNull()
    expect(parseVolumeMeta({ volume_number: "abc" })).toBeNull()
    expect(parseVolumeMeta({ volume_number: 0 })).toBeNull()
    expect(parseVolumeMeta({ volume_number: -1 })).toBeNull()
    expect(parseVolumeMeta({ volume_number: null })).toBeNull()
  })

  it("handles non-string non-number range as undefined", () => {
    const meta = parseVolumeMeta({ volume_number: 1, chapter_range_start: true })
    expect(meta?.chapterRangeStart).toBeUndefined()
    expect(meta?.chapterRangeEnd).toBeUndefined()
  })
})

describe("volume isVolumePage", () => {
  it("detects type volume and outline_type volume-outline", () => {
    expect(isVolumePage({ type: "volume" })).toBe(true)
    expect(isVolumePage({ outline_type: "volume-outline" })).toBe(true)
  })

  it("detects volume_number of either type", () => {
    expect(isVolumePage({ volume_number: 1 })).toBe(true)
    expect(isVolumePage({ volume_number: "1" })).toBe(true)
  })

  it("returns false otherwise", () => {
    expect(isVolumePage({ type: "chapter" })).toBe(false)
    expect(isVolumePage({})).toBe(false)
  })
})

describe("volume getChapterVolumes", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.searchWiki.mockResolvedValue([{ path: "C:/novel/wiki/vol-1.md" }])
  })

  it("collects volumes whose range contains the chapter", async () => {
    mocks.readFile.mockResolvedValue(
      [
        "---",
        "volume_number: 1",
        "title: 第一卷",
        "chapter_range_start: 1",
        "chapter_range_end: 10",
        "---",
        "正文",
      ].join("\n"),
    )
    const volumes = await getChapterVolumes("C:/novel", 5)
    expect(volumes).toEqual([
      {
        volumeNumber: 1,
        title: "第一卷",
        summary: "",
        chapterRangeStart: 1,
        chapterRangeEnd: 10,
      },
    ])
    expect(mocks.searchWiki).toHaveBeenCalledWith("C:/novel", "volume 第 卷 chapter_range")
  })

  it("excludes volumes not containing the chapter", async () => {
    mocks.readFile.mockResolvedValue(
      [
        "---",
        "volume_number: 1",
        "chapter_range_start: 20",
        "chapter_range_end: 30",
        "---",
        "正文",
      ].join("\n"),
    )
    expect(await getChapterVolumes("C:/novel", 5)).toEqual([])
  })

  it("skips pages without frontmatter or invalid volume meta", async () => {
    mocks.readFile
      .mockResolvedValueOnce("无 frontmatter")
      .mockResolvedValueOnce("---\nvolume_number: 0\n---\n正文")
    expect(await getChapterVolumes("C:/novel", 5)).toEqual([])
  })

  it("handles ranges with partial definition (no range -> excluded)", async () => {
    mocks.readFile.mockResolvedValue("---\nvolume_number: 1\n---\n正文")
    expect(await getChapterVolumes("C:/novel", 5)).toEqual([])
  })

  it("tolerates read failures and search failures", async () => {
    mocks.readFile.mockRejectedValue(new Error("ENOENT"))
    expect(await getChapterVolumes("C:/novel", 5)).toEqual([])
    mocks.searchWiki.mockRejectedValue(new Error("search down"))
    expect(await getChapterVolumes("C:/novel", 5)).toEqual([])
  })

  it("parses quoted and boolean scalar values from frontmatter", async () => {
    mocks.readFile.mockResolvedValue(
      [
        "---",
        'volume_number: "2"',
        "title: '带引号的卷名'",
        "hidden_flag: true",
        "disabled_flag: false",
        "chapter_range_start: 11",
        "chapter_range_end: 20",
        "---",
        "正文",
      ].join("\n"),
    )
    const volumes = await getChapterVolumes("C:/novel", 15)
    expect(volumes[0].volumeNumber).toBe(2)
    expect(volumes[0].title).toBe("带引号的卷名")
  })
})
