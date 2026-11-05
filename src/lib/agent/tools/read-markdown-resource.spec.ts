import { beforeEach, describe, expect, it, vi } from "vitest"
import { listDirectory, readFile } from "@/commands/fs"
import type { FileNode } from "@/types/wiki"
import { readMarkdownResource } from "./read-markdown-resource"

vi.mock("@/commands/fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/commands/fs")>()
  return { ...actual, listDirectory: vi.fn(), readFile: vi.fn() }
})

const listMock = vi.mocked(listDirectory)
const readMock = vi.mocked(readFile)

function fileNode(name: string, path: string, is_dir = false): FileNode {
  return { name, path, is_dir }
}

beforeEach(() => {
  listMock.mockReset()
  readMock.mockReset()
  listMock.mockResolvedValue([])
  readMock.mockRejectedValue(new Error("not found"))
})

describe("readMarkdownResource 显式路径", () => {
  it(" base 内相对路径命中：返回内容并回填 params.path 与 params.name", async () => {
    readMock.mockResolvedValue("大纲正文")
    const params: Record<string, unknown> = { path: "sub/a.md", name: "" }
    const out = await readMarkdownResource("/base", params, "大纲", readMock)
    expect(out).toBe("大纲正文")
    expect(params.path).toBe("/base/sub/a.md")
    expect(params.name).toBe("a")
  })

  it("已填写 name 时不覆盖", async () => {
    readMock.mockResolvedValue("x")
    const params: Record<string, unknown> = { path: "a.md", name: "keep" }
    await readMarkdownResource("/base", params, "大纲", readMock)
    expect(params.name).toBe("keep")
  })

  it("越界相对路径被拒绝", async () => {
    const params: Record<string, unknown> = { path: "../../etc/a.md" }
    const out = await readMarkdownResource("/base", params, "大纲", readMock)
    expect(out).toContain("无法读取大纲")
    expect(out).toContain("必须位于大纲目录内")
    expect(readMock).not.toHaveBeenCalled()
  })

  it(" base 外绝对路径被拒绝", async () => {
    const out = await readMarkdownResource("/base", { path: "/other/a.md" }, "大纲", readMock)
    expect(out).toContain("必须位于大纲目录内")
  })

  it("空 baseDir 直接报错", async () => {
    const out = await readMarkdownResource("", { path: "a.md" }, "大纲", readMock)
    expect(out).toContain("必须位于大纲目录内")
  })

  it("显式路径读不到时按 basename 模糊兜底", async () => {
    readMock.mockImplementation(async (p: string) => {
      if (p === "/base/docs/missing-notes.md") return "模糊命中"
      throw new Error("not found")
    })
    listMock.mockResolvedValue([fileNode("missing-notes.md", "/base/docs/missing-notes.md")])
    const params: Record<string, unknown> = { path: "missing.md" }
    const out = await readMarkdownResource("/base", params, "大纲", readMock)
    expect(out).toBe("模糊命中")
    expect(params.path).toBe("/base/docs/missing-notes.md")
  })
})

describe("readMarkdownResource 名称解析", () => {
  it("缺名称与路径时报错", async () => {
    const out = await readMarkdownResource("/base", {}, "记忆", readMock)
    expect(out).toBe("错误：缺少记忆名称或文件路径")
  })

  it("常规名直接命中 base 下文件", async () => {
    readMock.mockImplementation(async (p: string) => {
      if (p === "/base/alpha.md") return "alpha 正文"
      throw new Error("not found")
    })
    const out = await readMarkdownResource("/base", { name: "alpha" }, "大纲", readMock)
    expect(out).toBe("alpha 正文")
    expect(listMock).not.toHaveBeenCalled()
  })

  it("带 .md 后缀的名称同样直达", async () => {
    readMock.mockResolvedValue("正文")
    const out = await readMarkdownResource("/base", { name: "alpha.md" }, "大纲", readMock)
    expect(out).toBe("正文")
    expect(readMock).toHaveBeenCalledWith("/base/alpha.md")
  })

  it("模糊唯一命中（包含匹配）读候选文件", async () => {
    readMock.mockImplementation(async (p: string) => {
      if (p === "/base/docs/alpha-notes.md") return "候选正文"
      throw new Error("not found")
    })
    listMock.mockResolvedValue([fileNode("alpha-notes.md", "/base/docs/alpha-notes.md")])
    const params: Record<string, unknown> = { name: "alpha" }
    const out = await readMarkdownResource("/base", params, "大纲", readMock)
    expect(out).toBe("候选正文")
    expect(params.path).toBe("/base/docs/alpha-notes.md")
    expect(params.name).toBe("alpha")
  })

  it("章节号匹配：第5章命中 chapter5 候选", async () => {
    readMock.mockImplementation(async (p: string) => {
      if (p === "/base/chapters/chapter5.md") return "第五章"
      throw new Error("not found")
    })
    listMock.mockResolvedValue([fileNode("chapter5.md", "/base/chapters/chapter5.md")])
    const out = await readMarkdownResource("/base", { name: "第5章" }, "章节", readMock)
    expect(out).toBe("第五章")
  })

  it("数字+章字部分匹配走 60 分支", async () => {
    readMock.mockImplementation(async (p: string) => {
      if (p === "/base/第5章设定.md") return "设定正文"
      throw new Error("not found")
    })
    listMock.mockResolvedValue([fileNode("第5章设定.md", "/base/第5章设定.md")])
    const out = await readMarkdownResource("/base", { name: "第5章x" }, "大纲", readMock)
    expect(out).toBe("设定正文")
  })

  it("命中但读不到时报已匹配不可读", async () => {
    listMock.mockResolvedValue([fileNode("alpha.md", "/base/docs/alpha.md")])
    const out = await readMarkdownResource("/base", { name: "alpha" }, "大纲", readMock)
    expect(out).toContain("已匹配到大纲「alpha」")
    expect(out).toContain("无法读取文件")
  })

  it("多候选同分无法唯一确定时列出可用候选", async () => {
    listMock.mockResolvedValue([
      fileNode("ax.md", "/base/ax.md"),
      fileNode("bx.md", "/base/bx.md"),
    ])
    const out = await readMarkdownResource("/base", { name: "x" }, "大纲", readMock)
    expect(out).toContain("可用候选")
    expect(out).toContain("ax")
    expect(out).toContain("bx")
  })

  it("无任何候选时提示确认文件存在", async () => {
    const out = await readMarkdownResource("/base", { name: "ghost" }, "大纲", readMock)
    expect(out).toBe("错误：无法读取大纲「ghost」，请确认文件存在")
  })

  it("候选列表最多列 8 条", async () => {
    listMock.mockResolvedValue(
      Array.from({ length: 10 }, (_, i) => fileNode(`f${i}.md`, `/base/f${i}.md`)),
    )
    const out = await readMarkdownResource("/base", { name: "zzz" }, "大纲", readMock)
    const lines = out.split("\n").filter((l) => /^\d+\. /.test(l))
    expect(lines).toHaveLength(8)
  })

  it("展示名用显式路径回退（无 name 时）", async () => {
    const out = await readMarkdownResource("/base", { path: "nope.md" }, "大纲", readMock)
    expect(out).toBe("错误：无法读取大纲「nope.md」，请确认文件存在")
  })
})

describe("readMarkdownResource 目录候选", () => {
  it("命中目录时列出其下条目", async () => {
    listMock.mockImplementation(async (p: string) => {
      if (p === "/base") return [fileNode("设定", "/base/设定", true)]
      if (p === "/base/设定") {
        return [
          fileNode("主角.md", "/base/设定/主角.md"),
          fileNode("readme.txt", "/base/设定/readme.txt"),
        ]
      }
      return []
    })
    const out = await readMarkdownResource("/base", { name: "设定" }, "设定", readMock)
    expect(out).toContain("是目录，不是单个设定")
    expect(out).toContain("主角")
    expect(out).not.toContain("readme")
  })

  it("空目录提示无可读条目", async () => {
    listMock.mockImplementation(async (p: string) => {
      if (p === "/base") return [fileNode("空目录", "/base/空目录", true)]
      return []
    })
    const out = await readMarkdownResource("/base", { name: "空目录" }, "设定", readMock)
    expect(out).toContain("目录下没有找到可读取的 .md 条目")
  })

  it("超深目录按占位收录不递归", async () => {
    listMock.mockImplementation(async (p: string) => {
      const depth: Record<string, FileNode[]> = {
        "/base": [fileNode("d1", "/base/d1", true)],
        "/base/d1": [fileNode("d2", "/base/d1/d2", true)],
        "/base/d1/d2": [fileNode("d3", "/base/d1/d2/d3", true)],
      }
      if (p === "/base/d1/d2/d3") return [fileNode("d4", "/base/d1/d2/d3/d4", true)]
      return depth[p] ?? []
    })
    // d4 所在层已达最大深度：查询 d4 命中占位目录，提示无条目而非递归
    const out = await readMarkdownResource("/base", { name: "d4" }, "设定", readMock)
    expect(out).toContain("目录下没有找到可读取的 .md 条目")
  })

  it("目录枚举失败按空处理", async () => {
    listMock.mockRejectedValue(new Error("ls down"))
    const out = await readMarkdownResource("/base", { name: "ghost" }, "大纲", readMock)
    expect(out).toContain("请确认文件存在")
  })

  it("归一化后无意义的文件名不参与评分（仅列出不命中）", async () => {
    listMock.mockResolvedValue([fileNode("---.md", "/base/---.md")])
    const out = await readMarkdownResource("/base", { name: "abc" }, "大纲", readMock)
    expect(out).toContain("可用候选")
    expect(out).not.toContain("已匹配到")
  })
})
