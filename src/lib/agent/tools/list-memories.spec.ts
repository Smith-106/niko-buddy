/** C4 冒烟覆盖：src/lib/agent/tools/list-memories.ts（自动生成，核心行为由专项 spec 加深） */
import { beforeEach, describe, expect, it, vi } from "vitest"
import { createListMemoriesTool } from "./list-memories"

const fsMocks = vi.hoisted(() => ({
  listDirectory: vi.fn<(path: string) => Promise<import("@/types/wiki").FileNode[]>>(),
}))

vi.mock("@/commands/fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/commands/fs")>()
  return { ...actual, listDirectory: fsMocks.listDirectory }
})

beforeEach(() => {
  fsMocks.listDirectory.mockReset()
})

describe("list-memories.ts smoke", () => {
  it("exports createListMemoriesTool", () => {
    expect(createListMemoriesTool).toBeDefined()
  })
})

describe("list_memories 工具行为", () => {
  it("只列 .md 文件、去掉扩展名并按序号编号（目录与非 md 文件不进清单）", async () => {
    fsMocks.listDirectory.mockResolvedValue([
      { name: "角色设定.md", path: "/mem/角色设定.md", is_dir: false },
      { name: "notes.txt", path: "/mem/notes.txt", is_dir: false },
      { name: "sub", path: "/mem/sub", is_dir: true },
      { name: "行文习惯.md", path: "/mem/行文习惯.md", is_dir: false },
    ])
    const tool = createListMemoriesTool("/mem")
    const output = await tool.execute({})

    expect(fsMocks.listDirectory).toHaveBeenCalledWith("/mem")
    // 目录 sub 与 notes.txt 被过滤；编号从 1 开始连续
    expect(output).toBe("可用记忆条目列表:\n1. 角色设定\n2. 行文习惯")
  })

  it("记忆目录为空 → 只有表头，不伪造条目", async () => {
    fsMocks.listDirectory.mockResolvedValue([])
    const tool = createListMemoriesTool("/mem")
    expect(await tool.execute({})).toBe("可用记忆条目列表:\n")
  })

  it("列目录失败 → 返回错误文案而不是抛错（agent 工具不得中断会话）", async () => {
    fsMocks.listDirectory.mockRejectedValue(new Error("ENOENT: no such file or directory"))
    const tool = createListMemoriesTool("/missing")
    await expect(tool.execute({})).resolves.toBe("错误：无法列出记忆目录")
  })

  it("工具元数据：只读分类 + 无参数", () => {
    const tool = createListMemoriesTool("/mem")
    expect(tool.name).toBe("list_memories")
    expect(tool.category).toBe("read")
    expect(tool.parameters).toEqual({})
  })
})
