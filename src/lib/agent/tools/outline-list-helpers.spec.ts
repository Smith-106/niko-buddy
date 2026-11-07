import { beforeEach, describe, expect, it, vi } from "vitest"
import {
  buildOutlineListToolResult,
  extractOutlineFolder,
  extractOutlineTypeFields,
  formatOutlineListLine,
  listOutlineEntries,
  type OutlineListEntry,
} from "./outline-list-helpers"

vi.mock("@/commands/fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/commands/fs")>()
  return { ...actual, listDirectory: vi.fn(), readFile: vi.fn() }
})
import { listDirectory } from "@/commands/fs"

describe("outline-list-helpers", () => {
  it("extracts type and outline_type from frontmatter", () => {
    expect(
      extractOutlineTypeFields(`---
type: outline
title: "第三卷大纲"
---

正文`),
    ).toEqual({ type: "outline", outlineType: undefined })

    expect(
      extractOutlineTypeFields(`---
type: concept
outline_type: volume-outline
title: "规则"
---
`),
    ).toEqual({ type: "concept", outlineType: "volume-outline" })

    expect(extractOutlineTypeFields("# 无 frontmatter")).toEqual({})
  })

  it("extracts standard outline folder from relative path", () => {
    expect(extractOutlineFolder("章纲/第52章-条件.md")).toBe("章纲")
    expect(extractOutlineFolder("设定/写作通则.md")).toBe("设定")
    expect(extractOutlineFolder("第三卷大纲.md")).toBeUndefined()
    expect(extractOutlineFolder("其他/说明.md")).toBeUndefined()
  })

  it("formats list lines with folder first, then optional type fields", () => {
    const withFolderAndType: OutlineListEntry = {
      relativePath: "卷纲/第三卷.md",
      absolutePath: "/p/wiki/outlines/卷纲/第三卷.md",
      folder: "卷纲",
      type: "outline",
      outlineType: "volume-outline",
    }
    expect(formatOutlineListLine(withFolderAndType, 0)).toBe(
      "1. 卷纲/第三卷.md  folder=卷纲  type=outline  outline_type=volume-outline",
    )

    const folderOnly: OutlineListEntry = {
      relativePath: "章纲/第52章-条件.md",
      absolutePath: "/p/wiki/outlines/章纲/第52章-条件.md",
      folder: "章纲",
    }
    expect(formatOutlineListLine(folderOnly, 1)).toBe(
      "2. 章纲/第52章-条件.md  folder=章纲",
    )
  })

  it("builds tool result with folder-first guidance and optional target chapter", () => {
    const result = buildOutlineListToolResult(
      [
        {
          relativePath: "章纲/第52章-条件.md",
          absolutePath: "/o/章纲/第52章-条件.md",
          folder: "章纲",
        },
        {
          relativePath: "设定/写作通则.md",
          absolutePath: "/o/设定/写作通则.md",
          folder: "设定",
        },
        {
          relativePath: "卷纲/第三卷.md",
          absolutePath: "/o/卷纲/第三卷.md",
          folder: "卷纲",
          type: "outline",
          outlineType: "volume-outline",
        },
        {
          relativePath: "全局设定.md",
          absolutePath: "/o/全局设定.md",
          type: "overview",
        },
      ],
      167,
    )

    expect(result).toContain("1. 章纲/第52章-条件.md  folder=章纲")
    expect(result).toContain("2. 设定/写作通则.md  folder=设定")
    expect(result).toContain("3. 卷纲/第三卷.md  folder=卷纲  type=outline  outline_type=volume-outline")
    expect(result).toContain("4. 全局设定.md  type=overview")
    expect(result).toContain("本次目标章号：第 167 章")
    expect(result).toContain("优先按文件夹（folder）分流")
    expect(result).toContain("章纲：本章主候选")
    expect(result).toContain("设定：全书硬约束")
    expect(result).toContain("旧兼容：overview≈大纲")
    expect(result).toContain("优先在章纲中定位")
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 覆盖增补：listOutlineEntries 的文件系统边界（目录缺失/非 md/深度上限/根外路径）
// ─────────────────────────────────────────────────────────────────────────────

describe("outline-list-helpers 覆盖增补：目录遍历与路径归一", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("大纲目录不可读时返回空清单，不抛错", async () => {
    vi.mocked(listDirectory).mockRejectedValue(new Error("ENOENT: no such directory"))

    const entries = await listOutlineEntries("/missing", async () => "")

    expect(entries).toEqual([])
  })

  it("只收录 .md 文件，非 Markdown 条目被跳过", async () => {
    vi.mocked(listDirectory).mockResolvedValue([
      { name: "第三卷.md", path: "/o/第三卷.md", is_dir: false },
      { name: "封面.png", path: "/o/封面.png", is_dir: false },
    ])

    const entries = await listOutlineEntries("/o", async () => "")

    expect(entries.map((entry) => entry.relativePath)).toEqual(["第三卷.md"])
  })

  it("嵌套深度达到上限后停止下钻，浅层文件仍按原顺序收录", async () => {
    vi.mocked(listDirectory).mockImplementation(async (path: string) => [
      { name: `第${path.length}层.md`, path: `${path}/第${path.length}层.md`, is_dir: false },
      { name: "下一层", path: `${path}/下一层`, is_dir: true },
    ])

    const entries = await listOutlineEntries("/o", async () => "")

    // depth 0..4 共 5 层；第 5 层的目录条目命中 maxDepth 守卫，不再递归
    expect(vi.mocked(listDirectory)).toHaveBeenCalledTimes(5)
    expect(entries).toHaveLength(5)
    expect(entries.filter((entry) => entry.relativePath.endsWith("层.md"))).toHaveLength(5)
  })

  it("文件路径等于大纲根目录时，相对路径回退为文件名", async () => {
    vi.mocked(listDirectory).mockResolvedValue([
      { name: "总纲.md", path: "/o", is_dir: false },
    ])

    const entries = await listOutlineEntries("/o/", async () => "")

    expect(entries).toHaveLength(1)
    expect(entries[0].relativePath).toBe("总纲.md")
    expect(entries[0].absolutePath).toBe("/o")
  })

  it("文件路径在大纲根目录之外时，相对路径回退为路径末段", async () => {
    vi.mocked(listDirectory).mockResolvedValue([
      { name: "外部.md", path: "/elsewhere/外部.md", is_dir: false },
    ])

    const entries = await listOutlineEntries("/o", async () => "")

    expect(entries[0].relativePath).toBe("外部.md")
  })

  it("单个文件读取失败仍列入清单（只有路径，没有 frontmatter 字段）", async () => {
    vi.mocked(listDirectory).mockResolvedValue([
      { name: "a.md", path: "/o/a.md", is_dir: false },
    ])

    const entries = await listOutlineEntries("/o", async () => {
      throw new Error("read failed")
    })

    expect(entries).toHaveLength(1)
    expect(entries[0].relativePath).toBe("a.md")
    expect(entries[0].type).toBeUndefined()
    expect(entries[0].outlineType).toBeUndefined()
  })

  it("清单按相对路径做中文数字序排序", async () => {
    vi.mocked(listDirectory).mockResolvedValue([
      { name: "第10章.md", path: "/o/第10章.md", is_dir: false },
      { name: "第2章.md", path: "/o/第2章.md", is_dir: false },
    ])

    const entries = await listOutlineEntries("/o", async () => "")

    expect(entries.map((entry) => entry.relativePath)).toEqual(["第2章.md", "第10章.md"])
  })

  it("空清单返回占位文案而不是空串", () => {
    expect(buildOutlineListToolResult([])).toBe("可用大纲列表:\n（空）")
  })

  it("未传目标章号时不追加章号提示行", () => {
    const result = buildOutlineListToolResult([
      {
        relativePath: "章纲/第1章.md",
        absolutePath: "/o/章纲/第1章.md",
        folder: "章纲",
      },
    ])

    expect(result).toContain("1. 章纲/第1章.md  folder=章纲")
    expect(result).not.toContain("本次目标章号")
  })

  it("目标章号为 0（无意义章号）时不追加提示行", () => {
    const result = buildOutlineListToolResult(
      [{ relativePath: "卷纲/第一卷.md", absolutePath: "/o/卷纲/第一卷.md", folder: "卷纲" }],
      0,
    )

    expect(result).not.toContain("本次目标章号")
  })
})

describe("extractOutlineTypeFields 数值字段", () => {
  it("frontmatter 数值标量被转成字符串（不丢弃）", () => {
    const fields = extractOutlineTypeFields("---\nvolume: 3\n---\n正文")
    expect(fields).toBeTruthy()
  })
})
