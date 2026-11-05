import { beforeEach, describe, expect, it, vi } from "vitest"
import { createSearchChaptersTool } from "./search-chapters"

const fsMocks = vi.hoisted(() => ({
  listDirectory: vi.fn(async (_dir: string): Promise<unknown[]> => []),
  readFile: vi.fn(async (_path: string): Promise<string> => ""),
}))

vi.mock("@/commands/fs", () => ({
  listDirectory: fsMocks.listDirectory,
  readFile: fsMocks.readFile,
}))

interface FakeFile {
  name: string
  path: string
  is_dir: boolean
}

function fakeFile(name: string, chaptersDir = "/chapters"): FakeFile {
  return { name, path: `${chaptersDir}/${name}`, is_dir: false }
}

function toolWith(
  files: FakeFile[],
  contents: Record<string, string | Error>,
  chaptersDir = "/chapters",
) {
  fsMocks.listDirectory.mockResolvedValueOnce(files as never)
  const readTextFile = vi.fn(async (path: string): Promise<string> => {
    const entry = contents[path]
    if (entry instanceof Error) throw entry
    return entry ?? ""
  })
  return createSearchChaptersTool(chaptersDir, readTextFile)
}

beforeEach(() => {
  fsMocks.listDirectory.mockReset()
  fsMocks.readFile.mockReset()
})

describe("createSearchChaptersTool", () => {
  it("暴露搜索工具的元信息", () => {
    const tool = createSearchChaptersTool("/chapters", async () => "")
    expect(tool.name).toBe("search_chapters")
    expect(tool.category).toBe("read")
  })

  it.each([[""], ["   "]])("缺少关键词时拒绝搜索 %p", async (keyword) => {
    const tool = toolWith([], {})
    const result = await tool.execute({ keyword })
    expect(result).toContain("缺少搜索关键词")
  })

  it("目录不可读时返回中文错误", async () => {
    fsMocks.listDirectory.mockRejectedValueOnce(new Error("ENOENT"))
    const tool = createSearchChaptersTool("/chapters", async () => "")
    const result = await tool.execute({ keyword: "林川" })
    expect(result).toContain("无法搜索章节目录")
  })

  it("无匹配时报告已搜索文件数", async () => {
    const tool = toolWith(
      [fakeFile("第一章.md"), fakeFile("第二章.md"), fakeFile("notes.txt")],
      { "/chapters/第一章.md": "无关内容", "/chapters/第二章.md": "其他内容" },
    )
    const result = await tool.execute({ keyword: "林川" })
    expect(result).toContain("未找到匹配章节：林川")
    expect(result).toContain("已搜索 2 个章节文件")
  })

  it("正文命中返回前后省略号片段", async () => {
    const content = `${"前".repeat(200)}林川${"后".repeat(200)}`
    const tool = toolWith([fakeFile("第一章.md")], { "/chapters/第一章.md": content })
    const result = await tool.execute({ keyword: "林川" })
    expect(result).toContain("搜索章节内容中匹配「林川」的结果")
    expect(result).toContain("1. 第一章")
    expect(result).toContain("命中位置：正文")
    const snippetLine = result.split("\n").find((line) => line.startsWith("命中片段："))
    expect(snippetLine).toBeDefined()
    expect(snippetLine!.startsWith("命中片段：...")).toBe(true)
    expect(snippetLine!.endsWith("...")).toBe(true)
    expect(snippetLine).toContain("林川")
  })

  it("短正文命中不加省略号", async () => {
    const tool = toolWith([fakeFile("第一章.md")], { "/chapters/第一章.md": "林川拔剑" })
    const result = await tool.execute({ keyword: "林川" })
    const snippetLine = result.split("\n").find((line) => line.startsWith("命中片段："))
    expect(snippetLine).toBe("命中片段：林川拔剑")
  })

  it("仅文件名命中返回文件名位置与正文前导", async () => {
    const tool = toolWith([fakeFile("林川外传.md")], { "/chapters/林川外传.md": "完全无关的正文" })
    const result = await tool.execute({ keyword: "林川" })
    expect(result).toContain("命中位置：文件名")
    expect(result).toContain("命中片段：完全无关的正文")
  })

  it("空章节文件名命中返回空内容提示", async () => {
    const tool = toolWith([fakeFile("林川外传.md")], { "/chapters/林川外传.md": "   " })
    const result = await tool.execute({ keyword: "林川" })
    expect(result).toContain("命中片段：（章节内容为空）")
  })

  it("超长前导正文截断到 160 字", async () => {
    const tool = toolWith([fakeFile("林川外传.md")], { "/chapters/林川外传.md": `无关${"正".repeat(200)}文` })
    const result = await tool.execute({ keyword: "林川" })
    const snippetLine = result.split("\n").find((line) => line.startsWith("命中片段："))
    expect(snippetLine!.endsWith("...")).toBe(true)
    expect(snippetLine!.length).toBeLessThanOrEqual("命中片段：".length + 163)
  })

  it("单个章节读取失败计入失败数但不阻断其他命中", async () => {
    const tool = toolWith(
      [fakeFile("坏章.md"), fakeFile("好章.md")],
      { "/chapters/坏章.md": new Error("EIO"), "/chapters/好章.md": "林川在此" },
    )
    const result = await tool.execute({ keyword: "林川" })
    expect(result).toContain("1. 好章")
    expect(result).toContain("另有 1 个章节读取失败")
  })

  it("全部未命中但有读取失败时同样报告失败数", async () => {
    const tool = toolWith(
      [fakeFile("坏章.md")],
      { "/chapters/坏章.md": new Error("EIO") },
    )
    const result = await tool.execute({ keyword: "林川" })
    expect(result).toContain("未找到匹配章节")
    expect(result).toContain("另有 1 个章节读取失败")
  })

  it("超过 10 条只返回前 10 条并提示", async () => {
    const files = Array.from({ length: 11 }, (_, i) => fakeFile(`第${i + 1}章.md`))
    const contents: Record<string, string> = {}
    for (const f of files) contents[f.path] = "林川现身"
    const tool = toolWith(files, contents)
    const result = await tool.execute({ keyword: "林川" })
    expect(result).toContain("10. 第10章")
    expect(result).not.toContain("11. 第11章")
    expect(result).toContain("仅显示前 10 条匹配结果")
  })

  it("省略 readTextFile 时使用模块默认读取", async () => {
    fsMocks.listDirectory.mockResolvedValueOnce([fakeFile("第一章.md")] as never)
    fsMocks.readFile.mockResolvedValueOnce("林川拔剑")
    const tool = createSearchChaptersTool("/chapters")
    const result = await tool.execute({ keyword: "林川" })
    expect(result).toContain("1. 第一章")
    expect(fsMocks.readFile).toHaveBeenCalledWith("/chapters/第一章.md")
  })

  it("搜索大小写不敏感", async () => {
    const tool = toolWith([fakeFile("第一章.md")], { "/chapters/第一章.md": "LinChuan appears" })
    const result = await tool.execute({ keyword: "linchuan" })
    expect(result).toContain("1. 第一章")
    expect(result).toContain("命中位置：正文")
  })
})
