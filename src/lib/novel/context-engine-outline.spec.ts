/**
 * context-engine-outline 行为测试（新建：此前无专属 spec）。
 *
 * 覆盖：emptyPack/readOutlineContent/resolveChapterOutlineProtectedCap/
 * pickChapterOutlineByNumber/readChapterOutlineDirect/
 * readProjectRootFilledOutline/readChapterOutlineContent 全分支。
 * 零 LLM；searchWiki + fs + findChapterFileByNumber 均 mock。
 */
import { beforeEach, describe, expect, it, vi } from "vitest"
import {
  emptyPack,
  pickChapterOutlineByNumber,
  readChapterOutlineContent,
  readChapterOutlineDirect,
  readOutlineContent,
  readProjectRootFilledOutline,
  resolveChapterOutlineProtectedCap,
} from "./context-engine-outline"
import { CHAPTER_OUTLINE_PROTECTED_CAP, setCurrentBuildBudget } from "./context-engine-gaps"

const fsMocks = vi.hoisted(() => ({
  readFile: vi.fn<(path: string) => Promise<string>>(),
  listDirectory: vi.fn<(path: string) => Promise<unknown[]>>(),
}))
vi.mock("@/commands/fs", async () => {
  const actual = await vi.importActual<typeof import("@/commands/fs")>("@/commands/fs")
  return { ...actual, ...fsMocks }
})

const searchMocks = vi.hoisted(() => ({ searchWiki: vi.fn() }))
vi.mock("@/lib/search", async () => {
  const actual = await vi.importActual<typeof import("@/lib/search")>("@/lib/search")
  return { ...actual, searchWiki: searchMocks.searchWiki }
})

const chapterUtilsMocks = vi.hoisted(() => ({ findChapterFileByNumber: vi.fn() }))
vi.mock("./chapter-utils", async () => {
  const actual = await vi.importActual<typeof import("./chapter-utils")>("./chapter-utils")
  return { ...actual, findChapterFileByNumber: chapterUtilsMocks.findChapterFileByNumber }
})

beforeEach(() => {
  vi.clearAllMocks()
  setCurrentBuildBudget(null)
  chapterUtilsMocks.findChapterFileByNumber.mockResolvedValue(null)
})

const node = (name: string, path: string, children?: unknown[]) => ({
  name,
  path,
  is_dir: false,
  children,
})

describe("emptyPack", () => {
  it("返回 task 透传的空上下文包", () => {
    const pack = emptyPack("写第3章")
    expect(pack.task).toBe("写第3章")
    expect(pack.outline).toBe("")
    expect(pack.chapterGoal).toBe("")
    expect(pack.recentChapterContents).toEqual([])
    expect(pack.gaps).toEqual([])
    expect(pack.styleExemplars).toEqual([])
    expect(pack.activeEntities).toEqual([])
  })
})

describe("readOutlineContent", () => {
  it("多命中拼接（--- 分隔），单个读取失败吞空", async () => {
    searchMocks.searchWiki.mockResolvedValueOnce([{ path: "a.md" }, { path: "b.md" }, { path: "c.md" }])
    fsMocks.readFile.mockImplementationOnce(async () => "甲")
    fsMocks.readFile.mockImplementationOnce(async () => {
      throw new Error("boom")
    })
    fsMocks.readFile.mockImplementationOnce(async () => "乙")
    const out = await readOutlineContent("/proj")
    expect(out).toBe("甲\n\n---\n\n乙")
    expect(searchMocks.searchWiki).toHaveBeenCalledWith("/proj", "outline type:outline")
  })

  it("零命中返回空串", async () => {
    searchMocks.searchWiki.mockResolvedValueOnce([])
    await expect(readOutlineContent("/proj")).resolves.toBe("")
  })

  it("searchWiki 抛错降级为空串", async () => {
    searchMocks.searchWiki.mockRejectedValueOnce(new Error("net down"))
    await expect(readOutlineContent("/proj")).resolves.toBe("")
  })
})

describe("resolveChapterOutlineProtectedCap", () => {
  it("无 build 预算时回退静态常量", () => {
    expect(resolveChapterOutlineProtectedCap()).toBe(CHAPTER_OUTLINE_PROTECTED_CAP)
  })

  it("有 build 预算时取自适应 maxPageSize", () => {
    setCurrentBuildBudget({ maxPageSize: 1234 } as never)
    expect(resolveChapterOutlineProtectedCap()).toBe(1234)
    setCurrentBuildBudget(null)
  })
})

describe("pickChapterOutlineByNumber", () => {
  const fm = (n: number) => `---\nchapter_number: ${n}\n---\n第${n}章细纲正文`
  it("frontmatter 章号优先命中", () => {
    const out = pickChapterOutlineByNumber(
      [
        { path: "a.md", content: "第9章别的" },
        { path: "b.md", content: fm(3) },
      ],
      3,
    )
    expect(out).toContain("第3章细纲正文")
  })

  it("无 frontmatter 时 heading/路径回退", () => {
    const out = pickChapterOutlineByNumber([{ path: "第5章.md", content: "杂文" }], 5)
    expect(out).toBe("杂文")
  })

  it("全不命中返回空串", () => {
    expect(pickChapterOutlineByNumber([{ path: "x.md", content: "无关" }], 7)).toBe("")
    expect(pickChapterOutlineByNumber([], 7)).toBe("")
  })
})

describe("readChapterOutlineDirect", () => {
  it("wiki 前缀命中 frontmatter 即早退（增量批读）", async () => {
    fsMocks.listDirectory.mockResolvedValueOnce([
      { name: "outlines", path: "/proj/wiki/outlines", is_dir: true, children: [node("c3.md", "/proj/wiki/outlines/c3.md")] },
    ])
    fsMocks.readFile.mockImplementation(async (p: string) =>
      p.endsWith("c3.md") ? "---\nchapter_number: 3\n---\n第三章细纲" : "",
    )
    const out = await readChapterOutlineDirect("/proj", 3)
    expect(out).toContain("第三章细纲")
    expect(chapterUtilsMocks.findChapterFileByNumber).not.toHaveBeenCalled()
  })

  it("wiki 无命中时回退项目根 FILLED 文件", async () => {
    fsMocks.listDirectory.mockResolvedValueOnce([])
    fsMocks.readFile.mockImplementation(async (p: string) => {
      if (p.endsWith("Chapter-3-Outline-FILLED.md")) return "根目录细纲"
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" })
    })
    const out = await readChapterOutlineDirect("/proj", 3)
    expect(out).toBe("根目录细纲")
  })

  it("批量中单个文件读取失败被吞空，其余继续", async () => {
    fsMocks.listDirectory.mockResolvedValueOnce([
      { name: "outlines", path: "/proj/wiki/outlines", is_dir: true, children: [
        node("bad.md", "/proj/wiki/outlines/bad.md"),
        node("c3.md", "/proj/wiki/outlines/c3.md"),
      ] },
    ])
    fsMocks.readFile.mockImplementation(async (p: string) => {
      if (p.endsWith("bad.md")) throw new Error("flaky io")
      return "---\nchapter_number: 3\n---\n第三章细纲"
    })
    const out = await readChapterOutlineDirect("/proj", 3)
    expect(out).toContain("第三章细纲")
  })

  it("无 frontmatter 时全量扫描后走 heading 回退", async () => {
    fsMocks.listDirectory.mockResolvedValueOnce([
      { name: "outlines", path: "/proj/wiki/outlines", is_dir: true, children: [node("c3.md", "/proj/wiki/outlines/c3.md")] },
    ])
    fsMocks.readFile.mockImplementation(async () => "第3章 只有标题行细纲")
    const out = await readChapterOutlineDirect("/proj", 3)
    expect(out).toBe("第3章 只有标题行细纲")
    expect(chapterUtilsMocks.findChapterFileByNumber).not.toHaveBeenCalled()
  })

  it("wiki 与根目录皆空时探测骨架章节（planned + summary）", async () => {
    fsMocks.listDirectory.mockResolvedValueOnce([])
    fsMocks.readFile.mockImplementation(async (p: string) => {
      if (p === "/proj/ch3.md") {
        return "---\nchapter_status: planned\nsummary: 大纲纲要\n---\n正文草稿"
      }
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" })
    })
    chapterUtilsMocks.findChapterFileByNumber.mockResolvedValueOnce("/proj/ch3.md")
    const out = await readChapterOutlineDirect("/proj", 3)
    expect(out).toContain("# 第3章大纲纲要")
    expect(out).toContain("大纲纲要")
  })

  it("骨架状态已完结（published）不被当作大纲", async () => {
    fsMocks.listDirectory.mockResolvedValueOnce([])
    fsMocks.readFile.mockImplementation(async (p: string) => {
      if (p.endsWith("ch3.md")) return "---\nchapter_status: published\n---\n已发布正文"
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" })
    })
    chapterUtilsMocks.findChapterFileByNumber.mockResolvedValueOnce("/proj/ch3.md")
    await expect(readChapterOutlineDirect("/proj", 3)).resolves.toBe("")
  })

  it("listDirectory 抛错直落根目录回退", async () => {
    fsMocks.listDirectory.mockRejectedValueOnce(new Error("io"))
    fsMocks.readFile.mockImplementation(async (p: string) => {
      if (p.endsWith("chapter-3-outline.md")) return "小写回退"
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" })
    })
    await expect(readChapterOutlineDirect("/proj", 3)).resolves.toBe("小写回退")
  })
})

describe("readProjectRootFilledOutline", () => {
  it("四种文件名按序尝试，首个非空胜出", async () => {
    fsMocks.readFile.mockImplementation(async (p: string) => {
      if (p.endsWith("Chapter-4-Outline.md")) return "  有料  "
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" })
    })
    await expect(readProjectRootFilledOutline("/proj", 4)).resolves.toBe("  有料  ")
  })

  it("全空/全缺返回空串", async () => {
    fsMocks.readFile.mockImplementation(async (p: string) => {
      if (p.endsWith("Chapter-5-Outline.md")) return "   "
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" })
    })
    await expect(readProjectRootFilledOutline("/proj", 5)).resolves.toBe("")
  })
})

describe("readChapterOutlineContent", () => {
  it("无章号直接空串（不触达 IO）", async () => {
    await expect(readChapterOutlineContent("/proj")).resolves.toBe("")
    await expect(readChapterOutlineContent("/proj", 0)).resolves.toBe("")
    expect(fsMocks.listDirectory).not.toHaveBeenCalled()
    expect(searchMocks.searchWiki).not.toHaveBeenCalled()
  })

  it("direct 命中直接返回", async () => {
    fsMocks.listDirectory.mockResolvedValueOnce([
      { name: "outlines", path: "/proj/wiki/outlines", is_dir: true, children: [node("c6.md", "/proj/wiki/outlines/c6.md")] },
    ])
    fsMocks.readFile.mockImplementation(async () => "---\nchapter_number: 6\n---\n第六章")
    await expect(readChapterOutlineContent("/proj", 6)).resolves.toContain("第六章")
  })

  it("direct 为空时走 search 回退（多 query 并发，首个有结果者胜）", async () => {
    fsMocks.listDirectory.mockResolvedValueOnce([])
    fsMocks.readFile.mockImplementation(async (p: string) => {
      if (p.includes("Outline")) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" })
      if (p === "hit.md") return "搜索到的细纲"
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" })
    })
    searchMocks.searchWiki.mockImplementation(async (_pp: string, q: string) =>
      q.startsWith("第2章") ? [{ path: "hit.md" }] : [],
    )
    const out = await readChapterOutlineContent("/proj", 2)
    expect(out).toBe("搜索到的细纲")
    expect(searchMocks.searchWiki).toHaveBeenCalledTimes(3)
  })

  it("search 命中但读取失败则跳过，最终空串", async () => {
    fsMocks.listDirectory.mockResolvedValueOnce([])
    fsMocks.readFile.mockRejectedValue(Object.assign(new Error("ENOENT"), { code: "ENOENT" }))
    searchMocks.searchWiki.mockImplementation(async () => [{ path: "hit.md" }])
    await expect(readChapterOutlineContent("/proj", 2)).resolves.toBe("")
  })

  it("search 全空返回空串", async () => {
    fsMocks.listDirectory.mockResolvedValueOnce([])
    fsMocks.readFile.mockRejectedValue(Object.assign(new Error("ENOENT"), { code: "ENOENT" }))
    searchMocks.searchWiki.mockResolvedValue([])
    await expect(readChapterOutlineContent("/proj", 2)).resolves.toBe("")
  })

  it("search 单路抛错被吞（catch → []）", async () => {
    fsMocks.listDirectory.mockResolvedValueOnce([])
    fsMocks.readFile.mockRejectedValue(Object.assign(new Error("ENOENT"), { code: "ENOENT" }))
    searchMocks.searchWiki.mockImplementation(async (_pp: string, q: string) => {
      if (q.includes("chapter_number")) throw new Error("flaky")
      return []
    })
    await expect(readChapterOutlineContent("/proj", 2)).resolves.toBe("")
  })
})
