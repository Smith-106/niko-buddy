/** C4 冒烟覆盖：src/lib/novel/context-engine-outline-helpers.ts（自动生成，核心行为由专项 spec 加深） */
import { describe, expect, it } from "vitest"
import { groupOutlineSources, selectOutlineSources, flattenOutlineMarkdownFiles, readFrontmatterChapterNumber, numberToChineseChapter, chapterLabels, includesChapterMarker } from "./context-engine-outline-helpers"
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


describe("outline 来源稳定分组", () => {
  it("canonical 优先且排除 backup，常规文件组保持原顺序与对象身份", () => {
    const backup = { path: "/p/story-outline.backup-old.md" }
    const first = { path: "/p/z.md" }
    const second = { path: "/p/a.md" }
    const canonical = { path: "C:\\p\\STORY-OUTLINE.MD" }
    const input = [backup, first, second, canonical]
    expect(selectOutlineSources(input)).toEqual([canonical, first, second])
    expect(groupOutlineSources(input)).toEqual([[canonical], [first, second]])
    expect(input).toEqual([backup, first, second, canonical])
    expect(selectOutlineSources(input)[1]).toBe(first)
  })

  it("backup-only 保留原顺序，名称中的 backupish 不误判", () => {
    const first = { path: "/p/story-outline.backup-z.md" }
    const second = { path: "/p/story-outline.bak-a.md" }
    expect(selectOutlineSources([first, second])).toEqual([first, second])
    const normal = { path: "/p/backupish-outline.md" }
    expect(selectOutlineSources([first, normal, second])).toEqual([normal])
  })

  it("树扁平化保持目录原序与 .MD 兼容，来源策略在扁平化之后生效", () => {
    const canonical = { name: "story-outline.MD", path: "/p/story-outline.MD", is_dir: false }
    const backup = { name: "story-outline.backup.md", path: "/p/story-outline.backup.md", is_dir: false }
    const tree = [{ name: "sub", path: "/p/sub", is_dir: true, children: [backup] }, canonical]
    expect(flattenOutlineMarkdownFiles(tree)).toEqual([backup, canonical])
    expect(selectOutlineSources(flattenOutlineMarkdownFiles(tree))).toEqual([canonical])
    expect(groupOutlineSources([])).toEqual([])
  })
})
