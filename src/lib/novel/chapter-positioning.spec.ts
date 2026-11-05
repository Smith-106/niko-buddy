/** C4 冒烟覆盖：src/lib/novel/chapter-positioning.ts（自动生成，核心行为由专项 spec 加深） */
import { describe, expect, it } from "vitest"
import { checkChapterPositioningDistribution, checkAdjacentEmotionClustering, parsePositionTableFromMarkdown } from "./chapter-positioning"
import type { ChapterPosition, ChapterPositionType, GenrePositioningBaseline } from "./chapter-positioning"
describe("chapter-positioning.ts smoke", () => {
  it("exports checkChapterPositioningDistribution", () => {
    expect(checkChapterPositioningDistribution).toBeDefined()
  })
  it("exports checkAdjacentEmotionClustering", () => {
    expect(checkAdjacentEmotionClustering).toBeDefined()
  })
  it("exports parsePositionTableFromMarkdown", () => {
    expect(parsePositionTableFromMarkdown).toBeDefined()
  })
})

describe("parsePositionTableFromMarkdown 数值格", () => {
  const table = (pressure: string, emotion: string) =>
    [
      "| 章 | 定位 | 压力级(1-5) | 情绪强度(1-10) | 说明 |",
      "| --- | --- | --- | --- | --- |",
      `| 1 | 高潮 | ${pressure} | ${emotion} | 初遇 |`,
    ].join(String.fromCharCode(10))

  it("整格数字才采纳", () => {
    const parsed = parsePositionTableFromMarkdown(table("3", "7"))
    expect(parsed).toHaveLength(1)
    expect(parsed[0]).toMatchObject({ chapterNumber: 1, pressureLevel: 3, emotionIntensity: 7 })
  })

  it("区间占位 1-5 不被 parseInt 截成 1", () => {
    expect(parsePositionTableFromMarkdown(table("1-5", "1-10"))).toHaveLength(0)
  })

  it("非数字格整行跳过", () => {
    expect(parsePositionTableFromMarkdown(table("高", "7"))).toHaveLength(0)
  })
})

describe("checkAdjacentEmotionClustering", () => {
  const pos = (
    chapterNumber: number,
    type: ChapterPositionType,
    emotionIntensity: number,
  ): ChapterPosition => ({
    chapterNumber,
    type,
    pressureLevel: 3,
    emotionIntensity: emotionIntensity as ChapterPosition["emotionIntensity"],
    note: "",
  })

  it("空数组与不足 3 章时无警告", () => {
    expect(checkAdjacentEmotionClustering([])).toEqual([])
    expect(checkAdjacentEmotionClustering([pos(1, "climax", 9), pos(2, "climax", 9)])).toEqual([])
  })

  it("连续 3 章同类型且情绪均大于 7 时警告", () => {
    const warnings = checkAdjacentEmotionClustering([
      pos(4, "climax", 8),
      pos(5, "climax", 9),
      pos(6, "climax", 10),
    ])
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain("4、5、6章")
    expect(warnings[0]).toContain("climax")
  })

  it("类型不同或情绪不足时不警告", () => {
    expect(
      checkAdjacentEmotionClustering([pos(1, "climax", 9), pos(2, "turn", 9), pos(3, "climax", 9)]),
    ).toEqual([])
    expect(
      checkAdjacentEmotionClustering([pos(1, "climax", 7), pos(2, "climax", 7), pos(3, "climax", 7)]),
    ).toEqual([])
  })

  it("滑动窗口内多处扎堆分别警告", () => {
    const warnings = checkAdjacentEmotionClustering([
      pos(1, "buildup", 8),
      pos(2, "buildup", 8),
      pos(3, "buildup", 8),
      pos(4, "buildup", 8),
    ])
    expect(warnings).toHaveLength(2)
  })
})

describe("checkChapterPositioningDistribution", () => {
  const pos = (
    chapterNumber: number,
    type: ChapterPositionType,
    emotionIntensity = 5,
  ): ChapterPosition => ({
    chapterNumber,
    type,
    pressureLevel: 3,
    emotionIntensity: emotionIntensity as ChapterPosition["emotionIntensity"],
    note: "",
  })

  it("空数组返回空警告", () => {
    expect(checkChapterPositioningDistribution([])).toEqual([])
  })

  it("高压章超 30% 时警告", () => {
    const positions = [
      pos(1, "climax", 5),
      pos(2, "climax", 5),
      pos(3, "turn", 5),
      pos(4, "turn", 5),
      ...Array.from({ length: 6 }, (_, i) => pos(5 + i, "development", 5)),
    ]
    const warnings = checkChapterPositioningDistribution(positions)
    expect(warnings.some((w) => w.includes("高压章") && w.includes("40.0%"))).toBe(true)
  })

  it("高压章恰好 30% 时不警告", () => {
    const positions = [
      pos(1, "climax", 5),
      pos(2, "turn", 5),
      pos(3, "turn", 5),
      ...Array.from({ length: 7 }, (_, i) => pos(4 + i, "development", 5)),
    ]
    expect(
      checkChapterPositioningDistribution(positions).some((w) => w.includes("高压章")),
    ).toBe(false)
  })

  it("收束章超 10% 时警告", () => {
    const positions = [
      pos(1, "resolution", 5),
      pos(2, "resolution", 5),
      ...Array.from({ length: 8 }, (_, i) => pos(3 + i, "development", 5)),
    ]
    const warnings = checkChapterPositioningDistribution(positions)
    expect(warnings.some((w) => w.includes("收束章") && w.includes("20.0%"))).toBe(true)
  })

  it("与基线偏差超 15% 时逐类型警告", () => {
    const positions = Array.from({ length: 10 }, (_, i) => pos(i + 1, "opening", 5))
    const warnings = checkChapterPositioningDistribution(positions)
    expect(warnings.some((w) => w.includes('"opening"') && w.includes("100.0%"))).toBe(true)
    expect(warnings.some((w) => w.includes('"development"'))).toBe(true)
  })

  it("符合基线的分布无警告", () => {
    const types: ChapterPositionType[] = [
      ...Array<string>(2).fill("opening"),
      ...Array<string>(6).fill("development"),
      ...Array<string>(5).fill("buildup"),
      ...Array<string>(3).fill("turn"),
      ...Array<string>(3).fill("climax"),
      ...Array<string>(1).fill("resolution"),
    ] as ChapterPositionType[]
    // 交错排列避免情绪扎堆：情绪全部取 5
    const positions = types.map((type, i) => pos(i + 1, type, 5))
    expect(checkChapterPositioningDistribution(positions)).toEqual([])
  })

  it("自定义基线生效", () => {
    const positions = Array.from({ length: 10 }, (_, i) => pos(i + 1, "opening", 5))
    const flat: GenrePositioningBaseline = {
      opening: 100,
      development: 0,
      buildup: 0,
      turn: 0,
      climax: 0,
      resolution: 0,
    }
    expect(
      checkChapterPositioningDistribution(positions, flat).some((w) => w.includes("偏差")),
    ).toBe(false)
  })

  it("透出相邻情绪扎堆警告", () => {
    const positions = [pos(1, "climax", 9), pos(2, "climax", 9), pos(3, "climax", 9)]
    const warnings = checkChapterPositioningDistribution(positions)
    expect(warnings.some((w) => w.includes("连续3章"))).toBe(true)
  })
})

describe("parsePositionTableFromMarkdown 扩展", () => {
  const doc = (...rows: string[]) =>
    [
      "# 卷纲",
      "",
      "| 章 | 定位 | 压力级(1-5) | 情绪强度(1-10) | 说明 |",
      "| --- | --- | --- | --- | --- |",
      ...rows,
    ].join("\n")

  it("解析多行并保留说明", () => {
    const parsed = parsePositionTableFromMarkdown(
      doc("| 1 | 开场 | 2 | 6 | 楔子 |", "| 2 | 高潮 | 5 | 9 | 决战 |") ,
    )
    expect(parsed).toEqual([
      { chapterNumber: 1, type: "opening", pressureLevel: 2, emotionIntensity: 6, note: "楔子" },
      { chapterNumber: 2, type: "climax", pressureLevel: 5, emotionIntensity: 9, note: "决战" },
    ])
  })

  it("中文标签映射全部类型", () => {
    const parsed = parsePositionTableFromMarkdown(
      doc(
        "| 1 | 发展 | 3 | 5 | |",
        "| 2 | 铺垫 | 3 | 5 | |",
        "| 3 | 转折 | 3 | 5 | |",
        "| 4 | 收束 | 1 | 2 | |",
      ),
    )
    expect(parsed.map((p) => p.type)).toEqual(["development", "buildup", "turn", "resolution"])
  })

  it("无表格时返回空数组", () => {
    expect(parsePositionTableFromMarkdown("# 标题\n纯文本")).toEqual([])
    expect(parsePositionTableFromMarkdown("")).toEqual([])
  })

  it("未知定位标签的行被跳过", () => {
    expect(parsePositionTableFromMarkdown(doc("| 1 | 爆发 | 3 | 7 | |"))).toEqual([])
  })

  it("超界的压力级与情绪强度被跳过", () => {
    expect(parsePositionTableFromMarkdown(doc("| 1 | 高潮 | 6 | 7 | |"))).toEqual([])
    expect(parsePositionTableFromMarkdown(doc("| 1 | 高潮 | 0 | 7 | |"))).toEqual([])
    expect(parsePositionTableFromMarkdown(doc("| 1 | 高潮 | 3 | 11 | |"))).toEqual([])
  })

  it("非数字章号与列数不足的行被跳过", () => {
    expect(parsePositionTableFromMarkdown(doc("| 一 | 高潮 | 3 | 7 | |"))).toEqual([])
    expect(parsePositionTableFromMarkdown(doc("| 1 | 高潮 | 3 |"))).toEqual([])
  })

  it("无空格分隔行被跳过", () => {
    const md = [
      "| 章 | 定位 | 压力级 | 情绪 | 说明 |",
      "|---|---|---|---|---|",
      "| 1 | 高潮 | 3 | 7 | 决战 |",
    ].join("\n")
    expect(parsePositionTableFromMarkdown(md)).toEqual([
      { chapterNumber: 1, type: "climax", pressureLevel: 3, emotionIntensity: 7, note: "决战" },
    ])
  })

  it("表头缺情绪列时不建表", () => {
    const md = ["| 章 | 定位 |", "| --- | --- |", "| 1 | 高潮 |"].join("\n")
    expect(parsePositionTableFromMarkdown(md)).toEqual([])
  })

  it("说明列缺失时默认为空", () => {
    expect(
      parsePositionTableFromMarkdown(doc("| 3 | 转折 | 4 | 8 |")),
    ).toEqual([
      { chapterNumber: 3, type: "turn", pressureLevel: 4, emotionIntensity: 8, note: "" },
    ])
  })
})
