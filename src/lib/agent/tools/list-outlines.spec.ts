/** C4 冒烟覆盖：src/lib/agent/tools/list-outlines.ts（自动生成，核心行为由专项 spec 加深） */
import { describe, expect, it, vi } from "vitest"
import { createListOutlinesTool } from "./list-outlines"
import * as outlineHelpers from "./outline-list-helpers"

vi.mock("@/commands/fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/commands/fs")>()
  return {
    ...actual,
    listDirectory: vi.fn(),
    readFile: vi.fn(),
  }
})
import { listDirectory, readFile } from "@/commands/fs"

describe("list-outlines.ts smoke", () => {
  it("exports createListOutlinesTool", () => {
    expect(createListOutlinesTool).toBeDefined()
  })
})

describe("list_outlines chapterNumber 参数归一", () => {
  const oneFile = [
    { name: "总纲.md", path: "/project/wiki/outlines/总纲.md", is_dir: false },
  ]

  it("数字字符串章号 \"167\" 视同数字 167（标注本次目标章号）", async () => {
    vi.mocked(listDirectory).mockResolvedValue(oneFile)
    vi.mocked(readFile).mockResolvedValue("---\ntype: outline\n---\n")
    const tool = createListOutlinesTool("/project/wiki/outlines", readFile)

    const result = await tool.execute({ chapterNumber: "167" })

    expect(result).toContain("总纲.md  type=outline")
    expect(result).toContain("本次目标章号：第 167 章")
  })

  it("数字字符串 \"0\" 不是有效章号（不标注目标章号）", async () => {
    vi.mocked(listDirectory).mockResolvedValue(oneFile)
    vi.mocked(readFile).mockResolvedValue("---\ntype: outline\n---\n")
    const tool = createListOutlinesTool("/project/wiki/outlines", readFile)

    const result = await tool.execute({ chapterNumber: "0" })

    expect(result).toContain("可用大纲列表:")
    expect(result).toContain("总纲.md  type=outline")
    expect(result).not.toContain("本次目标章号")
  })

  it("options 未注入 readTextFile 时回退 @/commands/fs readFile", async () => {
    vi.mocked(listDirectory).mockResolvedValue([
      { name: "卷一.md", path: "/project/wiki/outlines/卷一.md", is_dir: false },
    ])
    vi.mocked(readFile).mockResolvedValue("---\ntype: volume\n---\n")
    const tool = createListOutlinesTool("/project/wiki/outlines", {
      getDefaultChapterNumber: () => undefined,
    })

    const result = await tool.execute({})

    expect(result).toContain("卷一.md  type=volume")
    expect(vi.mocked(readFile)).toHaveBeenCalledWith("/project/wiki/outlines/卷一.md")
  })

  it("非数字字符串/负数/布尔均退化为缺省（不标注目标章号）", async () => {
    vi.mocked(listDirectory).mockResolvedValue(oneFile)
    vi.mocked(readFile).mockResolvedValue("---\ntype: outline\n---\n")
    const tool = createListOutlinesTool("/project/wiki/outlines", readFile)

    for (const raw of ["第167章", -3, true] as const) {
      const result = await tool.execute({ chapterNumber: raw })
      expect(result).not.toContain("本次目标章号")
    }
    expect(vi.mocked(listDirectory)).toHaveBeenCalled()
  })
})

describe("list_outlines 列目录失败降级", () => {
  it("列表构建抛错时返回错误文案（不向调用方抛异常）", async () => {
    const spy = vi
      .spyOn(outlineHelpers, "listOutlineEntries")
      .mockRejectedValueOnce(new Error("outline index exploded"))
    try {
      const tool = createListOutlinesTool("/project/wiki/outlines", readFile)
      await expect(tool.execute({})).resolves.toBe("错误：无法列出大纲目录")
    } finally {
      spy.mockRestore()
    }
  })
})
