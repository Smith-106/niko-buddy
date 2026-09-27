/** C4 冒烟覆盖：src/lib/novel/context-engine-outline-helpers.ts（自动生成，核心行为由专项 spec 加深） */
import { describe, expect, it } from "vitest"
import { flattenOutlineMarkdownFiles, readFrontmatterChapterNumber, numberToChineseChapter, chapterLabels, includesChapterMarker } from "./context-engine-outline-helpers"
describe("context-engine-outline-helpers.ts smoke", () => {
  it("exports flattenOutlineMarkdownFiles", () => {
    expect(flattenOutlineMarkdownFiles).toBeDefined()
  })
  it("exports readFrontmatterChapterNumber", () => {
    expect(readFrontmatterChapterNumber).toBeDefined()
  })
  it("exports numberToChineseChapter", () => {
    expect(numberToChineseChapter).toBeDefined()
  })
  it("exports chapterLabels", () => {
    expect(chapterLabels).toBeDefined()
  })
  it("exports includesChapterMarker", () => {
    expect(includesChapterMarker).toBeDefined()
  })
})
