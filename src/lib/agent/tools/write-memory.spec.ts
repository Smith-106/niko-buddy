import { beforeEach, describe, expect, it, vi } from "vitest"
import { createWriteMemoryTool } from "./write-memory"

const fsMocks = vi.hoisted(() => ({
  fileExists: vi.fn(async (_p: string): Promise<boolean> => false),
  readFile: vi.fn(async (_p: string): Promise<string> => ""),
  writeFileAtomic: vi.fn(async (_p: string, _c: string): Promise<void> => {}),
}))

vi.mock("@/commands/fs", () => ({
  fileExists: fsMocks.fileExists,
  readFile: fsMocks.readFile,
  writeFileAtomic: fsMocks.writeFileAtomic,
}))

beforeEach(() => {
  fsMocks.fileExists.mockReset()
  fsMocks.readFile.mockReset()
  fsMocks.writeFileAtomic.mockReset()
  fsMocks.fileExists.mockResolvedValue(false)
  fsMocks.readFile.mockResolvedValue("")
  fsMocks.writeFileAtomic.mockResolvedValue(undefined)
})

describe("write_memory 预览", () => {
  it("文件不存在时按新建预览", async () => {
    const tool = createWriteMemoryTool("/mem")
    fsMocks.fileExists.mockResolvedValue(false)
    const preview = await tool.generatePreview!({ name: "喜好", content: "爱吃辣" })
    expect(fsMocks.fileExists).toHaveBeenCalledWith("/mem/喜好.md")
    expect(preview).toContain("将新建记忆「喜好」")
    expect(preview).toContain("爱吃辣")
  })

  it("文件已存在时按更新预览并提示覆盖", async () => {
    const tool = createWriteMemoryTool("/mem")
    fsMocks.fileExists.mockResolvedValue(true)
    const preview = await tool.generatePreview!({ name: "喜好", content: "爱吃甜" })
    expect(preview).toContain("将更新记忆「喜好」")
    expect(preview).toContain("原记忆将被覆盖")
  })

  it("存在性检查失败时按新建降级且不抛错", async () => {
    const tool = createWriteMemoryTool("/mem")
    fsMocks.fileExists.mockRejectedValue(new Error("fs down"))
    const preview = await tool.generatePreview!({ name: "喜好", content: "x" })
    expect(preview).toContain("将新建记忆「喜好」")
  })
})

describe("write_memory 执行", () => {
  it("写入后读回一致判验证通过", async () => {
    const tool = createWriteMemoryTool("/mem")
    fsMocks.writeFileAtomic.mockResolvedValue(undefined)
    fsMocks.readFile.mockResolvedValue("爱吃辣")
    const result = await tool.execute({ name: "喜好", content: "爱吃辣" })
    expect(fsMocks.writeFileAtomic).toHaveBeenCalledWith("/mem/喜好.md", "爱吃辣")
    expect(fsMocks.readFile).toHaveBeenCalledWith("/mem/喜好.md")
    expect(result).toBe("已写入记忆「喜好」，读回验证通过。")
  })

  it("写入后读回不一致报验证警告", async () => {
    const tool = createWriteMemoryTool("/mem")
    fsMocks.readFile.mockResolvedValue("旧内容")
    const result = await tool.execute({ name: "喜好", content: "新内容" })
    expect(result).toContain("已写入记忆「喜好」")
    expect(result).toContain("读回验证失败")
  })

  it("写入抛错返回错误文本", async () => {
    const tool = createWriteMemoryTool("/mem")
    fsMocks.writeFileAtomic.mockRejectedValue(new Error("disk full"))
    const result = await tool.execute({ name: "喜好", content: "x" })
    expect(result).toContain("错误：写入记忆失败")
    expect(result).toContain("disk full")
  })

  it("读回抛错同样归入写入失败", async () => {
    const tool = createWriteMemoryTool("/mem")
    fsMocks.readFile.mockRejectedValue(new Error("read down"))
    const result = await tool.execute({ name: "喜好", content: "x" })
    expect(result).toContain("错误：写入记忆失败")
  })
})
