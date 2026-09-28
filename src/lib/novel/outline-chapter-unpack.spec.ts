// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest"
import {
  parseOutlineToChapters,
  unpackOutlineToChapterFiles,
} from "./outline-chapter-unpack"

const mocks = vi.hoisted(() => ({
  createDirectory: vi.fn(),
  fileExists: vi.fn(),
  writeFileAtomic: vi.fn(),
}))

vi.mock("@/commands/fs", () => ({
  createDirectory: mocks.createDirectory,
  fileExists: mocks.fileExists,
  writeFileAtomic: mocks.writeFileAtomic,
}))

describe("outline-chapter-unpack (大纲自动解构分发器)", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.createDirectory.mockResolvedValue(undefined)
    mocks.writeFileAtomic.mockResolvedValue(undefined)
  })

  it("正确识别并解析阿拉伯数字与中文数字章节大纲", () => {
    const sampleOutline = `
# 作品总纲：太虚之门

这是作品背景简介。

## 第1章：初入青云
少年林尘在测试中展现异象，被长老收为亲传弟子。
此时暗流涌动。

### 第2章 寒潭试炼
林尘进入后山寒潭，发现远古龙骸残卷。

## 第十二回：万宗朝圣
三千道州盛会开启，群雄逐鹿。

## Chapter 13: The Void Gateway
林尘踏入太虚之门，开启新篇章。
`

    const parsed = parseOutlineToChapters(sampleOutline)

    expect(parsed).toHaveLength(4)
    expect(parsed[0]).toEqual({
      chapterNumber: 1,
      title: "初入青云",
      summary: "少年林尘在测试中展现异象，被长老收为亲传弟子。\n此时暗流涌动。",
    })
    expect(parsed[1]).toEqual({
      chapterNumber: 2,
      title: "寒潭试炼",
      summary: "林尘进入后山寒潭，发现远古龙骸残卷。",
    })
    expect(parsed[2]).toEqual({
      chapterNumber: 12,
      title: "万宗朝圣",
      summary: "三千道州盛会开启，群雄逐鹿。",
    })
    expect(parsed[3]).toEqual({
      chapterNumber: 13,
      title: "The Void Gateway",
      summary: "林尘踏入太虚之门，开启新篇章。",
    })
  })

  it("无章节标记的大纲返回空数组", () => {
    const unstructured = "这是一段没有章节大纲标题的普通设定文本。"
    expect(parseOutlineToChapters(unstructured)).toEqual([])
    expect(parseOutlineToChapters("")).toEqual([])
  })

  it("unpackOutlineToChapterFiles 自动铺排章节骨架文件并跳过已存在章节", async () => {
    const outlineText = `
## 第1章：风起
第一章大纲设定。

## 第2章：云涌
第二章大纲设定。
`
    // 模拟第1章已存在，第2章不存在
    mocks.fileExists.mockImplementation(async (path: string) => {
      return path.includes("chapter-001.md")
    })

    const result = await unpackOutlineToChapterFiles({
      projectPath: "/test/project",
      outlineContent: outlineText,
      overwriteExisting: false,
    })

    expect(result.totalParsed).toBe(2)
    expect(result.skippedCount).toBe(1)
    expect(result.createdCount).toBe(1)
    expect(result.createdFiles).toHaveLength(1)
    expect(result.createdFiles[0]).toContain("chapter-002.md")

    expect(mocks.writeFileAtomic).toHaveBeenCalledTimes(1)
    const writtenContent = mocks.writeFileAtomic.mock.calls[0][1] as string
    expect(writtenContent).toContain("chapter_status: planned")
    expect(writtenContent).toContain("chapter_number: 2")
    expect(writtenContent).toContain("# 第2章 云涌")
    expect(writtenContent).toContain("第二章大纲设定。")
  })
})
