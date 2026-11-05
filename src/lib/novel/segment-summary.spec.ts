/**
 * segment-summary 行为测试（新建：此前无专属 spec）。
 *
 * 覆盖：纯函数（segmentIndexForChapter/segmentRange/group/build/getLatest/
 * filePath）全分支 + 薄持久层（load 降级/save best-effort）全分支。
 * 零 LLM；文件 IO 经 @/commands/fs mock。
 */
import { beforeEach, describe, expect, it, vi } from "vitest"
import {
  SEGMENT_SIZE,
  SEGMENT_SUMMARIES_FILE,
  buildSegmentSummaryInput,
  getLatestSegmentSummaryText,
  groupChapterNumbersBySegment,
  loadSegmentSummaries,
  saveSegmentSummaries,
  segmentIndexForChapter,
  segmentRange,
  segmentSummariesFilePath,
  type SegmentSummaries,
} from "./segment-summary"

const fsMocks = vi.hoisted(() => ({
  readFile: vi.fn<(path: string) => Promise<string>>(),
  writeFileAtomic: vi.fn<(path: string, content: string) => Promise<void>>(),
  createDirectory: vi.fn<(path: string) => Promise<void>>(),
}))
vi.mock("@/commands/fs", async () => {
  const actual = await vi.importActual<typeof import("@/commands/fs")>("@/commands/fs")
  return { ...actual, ...fsMocks }
})

beforeEach(() => {
  vi.clearAllMocks()
  fsMocks.createDirectory.mockResolvedValue(undefined)
  fsMocks.writeFileAtomic.mockResolvedValue(undefined)
})

describe("segmentIndexForChapter", () => {
  it("按 SEGMENT_SIZE=10 分段", () => {
    expect(SEGMENT_SIZE).toBe(10)
    expect(segmentIndexForChapter(1)).toBe(0)
    expect(segmentIndexForChapter(10)).toBe(0)
    expect(segmentIndexForChapter(11)).toBe(1)
    expect(segmentIndexForChapter(25)).toBe(2)
  })

  it("非法章号归 0 段（0/负数/NaN/Infinity/非数字）", () => {
    for (const bad of [0, -3, NaN, Infinity, -Infinity]) {
      expect(segmentIndexForChapter(bad)).toBe(0)
    }
  })

  it("小数章号先取整再分段", () => {
    expect(segmentIndexForChapter(10.9)).toBe(0)
    expect(segmentIndexForChapter(11.2)).toBe(1)
  })
})

describe("segmentRange", () => {
  it("段索引映射到 1-based 闭区间", () => {
    expect(segmentRange(0)).toEqual({ startChapter: 1, endChapter: 10 })
    expect(segmentRange(2)).toEqual({ startChapter: 21, endChapter: 30 })
  })

  it("非法索引归 0 段（负数/NaN/小数取整）", () => {
    expect(segmentRange(-1)).toEqual({ startChapter: 1, endChapter: 10 })
    expect(segmentRange(NaN)).toEqual({ startChapter: 1, endChapter: 10 })
    expect(segmentRange(1.9)).toEqual({ startChapter: 11, endChapter: 20 })
  })
})

describe("groupChapterNumbersBySegment", () => {
  it("空输入得空 Map", () => {
    expect(groupChapterNumbersBySegment([]).size).toBe(0)
  })

  it("跨段分组且段内升序（不突变入参）", () => {
    const input = [25, 3, 11, 1, 10]
    const groups = groupChapterNumbersBySegment(input)
    expect(input).toEqual([25, 3, 11, 1, 10])
    expect([...groups.entries()]).toEqual([
      [2, [25]],
      [0, [1, 3, 10]],
      [1, [11]],
    ])
  })

  it("非法章号落 0 段", () => {
    const groups = groupChapterNumbersBySegment([0, -5, 2])
    expect(groups.get(0)).toEqual([-5, 0, 2])
  })
})

describe("buildSegmentSummaryInput", () => {
  it("空/全空白输入返回空串", () => {
    expect(buildSegmentSummaryInput([])).toBe("")
    expect(buildSegmentSummaryInput([{ chapterNumber: 1, summary: "   " }])).toBe("")
    expect(buildSegmentSummaryInput([{ chapterNumber: NaN, summary: "x" }])).toBe("")
    expect(buildSegmentSummaryInput([{ chapterNumber: 0, summary: "x" }])).toBe("")
  })

  it("单章段只取一次", () => {
    expect(buildSegmentSummaryInput([{ chapterNumber: 3, summary: "开篇" }])).toBe(
      "【段0 第1-10章】第3章：开篇",
    )
  })

  it("多章段取首尾拼入，多段按段序排列", () => {
    const out = buildSegmentSummaryInput([
      { chapterNumber: 12, summary: "尾" },
      { chapterNumber: 2, summary: "中" },
      { chapterNumber: 11, summary: "首" },
      { chapterNumber: 1, summary: "头" },
    ])
    expect(out).toBe(
      [
        "【段0 第1-10章】首第1章：头｜尾第2章：中",
        "【段1 第11-20章】首第11章：首｜尾第12章：尾",
      ].join("\n"),
    )
  })

  it("同章号重复条目走单次格式", () => {
    const out = buildSegmentSummaryInput([
      { chapterNumber: 5, summary: "甲" },
      { chapterNumber: 5, summary: "乙" },
    ])
    expect(out).toBe("【段0 第1-10章】第5章：甲")
  })

  it("非法条目被过滤、合法条目保留", () => {
    const out = buildSegmentSummaryInput([
      { chapterNumber: -1, summary: "坏" },
      { chapterNumber: 7, summary: "" },
      { chapterNumber: 7, summary: "好" },
    ])
    expect(out).toBe("【段0 第1-10章】第7章：好")
  })
})

describe("getLatestSegmentSummaryText", () => {
  it("空表/null/非对象返回空串", () => {
    expect(getLatestSegmentSummaryText(null)).toBe("")
    expect(getLatestSegmentSummaryText(undefined)).toBe("")
    expect(getLatestSegmentSummaryText({})).toBe("")
    expect(getLatestSegmentSummaryText("x" as unknown as SegmentSummaries)).toBe("")
  })

  it("取最大数字 key；非数字 key 被忽略；非字符串值回空串", () => {
    expect(getLatestSegmentSummaryText({ "2": "新", "10": "最新", abc: "杂", "1": "旧" })).toBe("最新")
    expect(getLatestSegmentSummaryText({ "0": 42 } as unknown as SegmentSummaries)).toBe("")
  })
})

describe("持久层", () => {
  it("segmentSummariesFilePath 拼出运行期路径", () => {
    const p = segmentSummariesFilePath("/proj")
    expect(p.endsWith(`/${SEGMENT_SUMMARIES_FILE}`)).toBe(true)
    expect(p).toContain(".novel/segment-summaries.json")
  })

  it("load：缺失/空/非法/数组 → {}", async () => {
    fsMocks.readFile.mockRejectedValueOnce(Object.assign(new Error("ENOENT"), { code: "ENOENT" }))
    await expect(loadSegmentSummaries("/proj")).resolves.toEqual({})
    fsMocks.readFile.mockResolvedValueOnce("")
    await expect(loadSegmentSummaries("/proj")).resolves.toEqual({})
    fsMocks.readFile.mockResolvedValueOnce("   ")
    await expect(loadSegmentSummaries("/proj")).resolves.toEqual({})
    fsMocks.readFile.mockResolvedValueOnce("{bad json")
    await expect(loadSegmentSummaries("/proj")).resolves.toEqual({})
    fsMocks.readFile.mockResolvedValueOnce("[1,2]")
    await expect(loadSegmentSummaries("/proj")).resolves.toEqual({})
  })

  it("load：只保留字符串值", async () => {
    fsMocks.readFile.mockResolvedValueOnce(JSON.stringify({ "0": "甲", "1": 42, "2": null, "3": "乙" }))
    await expect(loadSegmentSummaries("/proj")).resolves.toEqual({ "0": "甲", "3": "乙" })
  })

  it("load：命中文件路径", async () => {
    fsMocks.readFile.mockResolvedValueOnce("{}")
    await loadSegmentSummaries("/proj")
    expect(fsMocks.readFile).toHaveBeenCalledWith(segmentSummariesFilePath("/proj"))
  })

  it("save：建目录 + 原子写 JSON；失败吞掉不抛", async () => {
    await saveSegmentSummaries("/proj", { "0": "甲" })
    expect(fsMocks.createDirectory).toHaveBeenCalledWith(expect.stringContaining(".novel"))
    expect(fsMocks.writeFileAtomic).toHaveBeenCalledWith(
      segmentSummariesFilePath("/proj"),
      JSON.stringify({ "0": "甲" }, null, 2),
    )
    fsMocks.writeFileAtomic.mockRejectedValueOnce(new Error("disk full"))
    await expect(saveSegmentSummaries("/proj", {})).resolves.toBeUndefined()
    fsMocks.createDirectory.mockRejectedValueOnce(new Error("no perm"))
    await expect(saveSegmentSummaries("/proj", {})).resolves.toBeUndefined()
  })
})
