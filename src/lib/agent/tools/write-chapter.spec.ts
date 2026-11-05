import { beforeEach, describe, expect, it, vi } from "vitest"
import { createWriteChapterTool } from "./write-chapter"

const fsMocks = vi.hoisted(() => ({
  fileExists: vi.fn(async (_path: string): Promise<boolean> => false),
  readFile: vi.fn(async (_path: string): Promise<string> => ""),
  writeFileAtomic: vi.fn(async (_path: string, _content: string): Promise<void> => {}),
  createDirectory: vi.fn(async (_path: string): Promise<void> => {}),
}))

const novelMocks = vi.hoisted(() => ({
  writeDraft: vi.fn(async (_projectPath: string, _name: string, _content: string, _meta?: unknown) => ({
    id: "draft-1",
  })),
}))

vi.mock("@/commands/fs", () => ({
  fileExists: fsMocks.fileExists,
  readFile: fsMocks.readFile,
  writeFileAtomic: fsMocks.writeFileAtomic,
  createDirectory: fsMocks.createDirectory,
}))

vi.mock("@/lib/novel", () => ({
  writeDraft: novelMocks.writeDraft,
}))

beforeEach(() => {
  fsMocks.fileExists.mockReset()
  fsMocks.readFile.mockReset()
  fsMocks.writeFileAtomic.mockReset()
  fsMocks.createDirectory.mockReset()
  novelMocks.writeDraft.mockReset()
  fsMocks.fileExists.mockResolvedValue(false)
  fsMocks.createDirectory.mockResolvedValue(undefined)
  fsMocks.writeFileAtomic.mockResolvedValue(undefined)
  novelMocks.writeDraft.mockResolvedValue({ id: "draft-1" })
})

describe("createWriteChapterTool", () => {
  it("暴露写章节工具的元信息", () => {
    const tool = createWriteChapterTool("/chapters")
    expect(tool.name).toBe("write_chapter")
    expect(tool.category).toBe("write")
    expect(tool.permission).toBe("confirm")
    expect(tool.parameters.name.required).toBe(true)
    expect(tool.parameters.content.required).toBe(true)
  })

  it("草稿模式与正式模式的描述不同", () => {
    expect(createWriteChapterTool("/chapters").description).toContain("会覆盖已有文件")
    expect(createWriteChapterTool("/chapters", { draftMode: true }).description).toContain("草稿区")
  })

  it.each([["a/b"], ["a\\b"], [""]])("拒绝非法章节名称 %p", async (name) => {
    const tool = createWriteChapterTool("/chapters")
    const result = await tool.execute({ name, content: "# x" })
    expect(result).toContain("无效的章节名称")
    expect(fsMocks.writeFileAtomic).not.toHaveBeenCalled()
  })

  it("草稿模式写入成功返回草稿 ID 与字数", async () => {
    const tool = createWriteChapterTool("/chapters", {
      draftMode: true,
      projectPath: "/proj",
      sourceConversationId: "c1",
      sourceMessageId: "m1",
    })
    const content = "# 第一章\n\n正文"
    const result = await tool.execute({ name: "第一章", content })
    expect(novelMocks.writeDraft).toHaveBeenCalledWith("/proj", "第一章", content, {
      sourceConversationId: "c1",
      sourceMessageId: "m1",
    })
    expect(result).toContain("草稿ID: draft-1")
    expect(result).toContain(`字数：${content.length}字`)
    expect(fsMocks.writeFileAtomic).not.toHaveBeenCalled()
  })

  it("草稿写入失败返回中文错误并携带原因", async () => {
    novelMocks.writeDraft.mockRejectedValueOnce(new Error("磁盘已满"))
    const tool = createWriteChapterTool("/chapters", { draftMode: true, projectPath: "/proj" })
    const result = await tool.execute({ name: "第一章", content: "# x" })
    expect(result).toContain("写入草稿失败")
    expect(result).toContain("磁盘已满")
  })

  it("草稿模式缺 projectPath 时走正式写入路径", async () => {
    fsMocks.readFile.mockResolvedValueOnce("# x")
    const tool = createWriteChapterTool("/chapters", { draftMode: true })
    const result = await tool.execute({ name: "第一章", content: "# x" })
    expect(novelMocks.writeDraft).not.toHaveBeenCalled()
    expect(fsMocks.writeFileAtomic).toHaveBeenCalledWith("/chapters/第一章.md", "# x")
    expect(result).toContain("读回验证通过")
  })

  it("正式写入不存在目录时先建目录再写并读回校验", async () => {
    fsMocks.readFile.mockResolvedValueOnce("# 第一章\n\n正文")
    const tool = createWriteChapterTool("/chapters")
    const result = await tool.execute({ name: "第一章", content: "# 第一章\n\n正文" })
    expect(fsMocks.fileExists).toHaveBeenCalledWith("/chapters")
    expect(fsMocks.createDirectory).toHaveBeenCalledWith("/chapters")
    expect(fsMocks.writeFileAtomic).toHaveBeenCalledWith("/chapters/第一章.md", "# 第一章\n\n正文")
    expect(result).toContain("读回验证通过")
  })

  it("目录已存在时不再创建", async () => {
    fsMocks.fileExists.mockResolvedValueOnce(true)
    fsMocks.readFile.mockResolvedValueOnce("# x")
    const tool = createWriteChapterTool("/chapters")
    await tool.execute({ name: "第一章", content: "# x" })
    expect(fsMocks.createDirectory).not.toHaveBeenCalled()
    expect(fsMocks.writeFileAtomic).toHaveBeenCalled()
  })

  it("读回不一致时返回警告而非成功", async () => {
    fsMocks.readFile.mockResolvedValueOnce("# 被篡改的内容")
    const tool = createWriteChapterTool("/chapters")
    const result = await tool.execute({ name: "第一章", content: "# 原始内容" })
    expect(result).toContain("读回验证失败")
    expect(result).not.toContain("读回验证通过")
  })

  it("写入抛错返回中文错误并携带原因", async () => {
    fsMocks.writeFileAtomic.mockRejectedValueOnce(new Error("EACCES"))
    const tool = createWriteChapterTool("/chapters")
    const result = await tool.execute({ name: "第一章", content: "# x" })
    expect(result).toContain("写入章节失败")
    expect(result).toContain("EACCES")
  })
})
