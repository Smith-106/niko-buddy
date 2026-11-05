import { describe, expect, it, vi } from "vitest"
import { createListDeductionsTool } from "./list-deductions"

const mocks = vi.hoisted(() => ({
  listDirectory: vi.fn(),
}))

vi.mock("@/commands/fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/commands/fs")>()
  return {
    ...actual,
    listDirectory: mocks.listDirectory,
  }
})

describe("list-deductions（推演结果列表工具）", () => {
  it("元信息正确：read 类、无需参数", () => {
    const tool = createListDeductionsTool("/sim")
    expect(tool.name).toBe("list_deductions")
    expect(tool.category).toBe("read")
    expect(tool.parameters).toEqual({})
    expect(tool.description).toContain("推演")
  })

  it("只列 .json 非目录文件并去后缀编号", async () => {
    mocks.listDirectory.mockResolvedValue([
      { name: "case-a.json", is_dir: false },
      { name: "case-b.json", is_dir: false },
      { name: "notes.md", is_dir: false },
      { name: "archive.json", is_dir: true },
    ])
    const tool = createListDeductionsTool("/sim")
    const out = await tool.execute({})
    expect(mocks.listDirectory).toHaveBeenCalledWith("/sim")
    expect(out).toBe("可用推演结果列表:\n1. case-a\n2. case-b")
  })

  it("空目录返回只有表头的列表", async () => {
    mocks.listDirectory.mockResolvedValue([])
    const tool = createListDeductionsTool("/sim")
    await expect(tool.execute({})).resolves.toBe("可用推演结果列表:\n")
  })

  it("目录读取失败返回错误提示而非抛错", async () => {
    mocks.listDirectory.mockRejectedValue(new Error("ENOENT"))
    const tool = createListDeductionsTool("/sim")
    await expect(tool.execute({})).resolves.toBe("错误：无法列出推演结果目录")
  })
})
