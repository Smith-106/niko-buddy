/** C4 冒烟覆盖：src/lib/novel/chapter-positioning.ts（自动生成，核心行为由专项 spec 加深） */
import { describe, expect, it } from "vitest"
import { checkChapterPositioningDistribution, checkAdjacentEmotionClustering, parsePositionTableFromMarkdown } from "./chapter-positioning"
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
