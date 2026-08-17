import { beforeEach, describe, expect, it, vi } from "vitest"

const fsMocks = vi.hoisted(() => ({
  listDirectory: vi.fn(),
  readFile: vi.fn(),
}))

vi.mock("@/commands/fs", () => ({
  listDirectory: fsMocks.listDirectory,
  readFile: fsMocks.readFile,
}))

import { listBindableNovelCharacters } from "./bindable-characters"

function mdNode(name: string, path: string) {
  return { name, path, is_dir: false }
}

function dirNode(name: string, path: string, children: unknown[]) {
  return { name, path, is_dir: true, children }
}

describe("bindable-characters listBindableNovelCharacters", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("collects character entity names from wiki/entities", async () => {
    fsMocks.listDirectory.mockImplementation(async (p: string) => {
      if (p.endsWith("/wiki/entities")) {
        return [
          mdNode("白砚.md", "/novel/wiki/entities/白砚.md"),
          mdNode("组织.md", "/novel/wiki/entities/组织.md"),
          dirNode("sub", "/novel/wiki/entities/sub", [
            mdNode("林动.md", "/novel/wiki/entities/sub/林动.md"),
          ]),
          mdNode("readme.txt", "/novel/wiki/entities/readme.txt"),
        ]
      }
      return []
    })
    fsMocks.readFile.mockImplementation(async (p: string) => {
      if (p.endsWith("白砚.md")) {
        return "---\ntype: entity\ntags: [character]\ntitle: 白砚\n---\n正文"
      }
      if (p.endsWith("组织.md")) {
        return "---\ntype: entity\ntags: [organization]\ntitle: 组织\n---\n正文"
      }
      if (p.endsWith("林动.md")) {
        return "---\ntype: entity\ntags: character, protagonist\ntitle: 林动\n---\n正文"
      }
      return ""
    })
    const names = await listBindableNovelCharacters("/novel")
    expect(names).toEqual(["白砚", "林动"])
  })

  it("entity 页标题命中 IGNORE 列表 → addName 提前返回（不收录）", async () => {
    fsMocks.listDirectory.mockImplementation(async (p: string) => {
      if (p.endsWith("/wiki/entities")) {
        return [mdNode("人物设定.md", "/novel/wiki/entities/人物设定.md")]
      }
      return []
    })
    fsMocks.readFile.mockResolvedValue(
      "---\ntype: entity\ntags: [character]\ntitle: 人物设定\n---\n正文",
    )
    const names = await listBindableNovelCharacters("/novel")
    expect(names).toEqual([])
  })

  it("skips entities without character tags and non-entity pages", async () => {
    fsMocks.listDirectory.mockImplementation(async (p: string) => {
      if (p.endsWith("/wiki/entities")) {
        return [
          mdNode("a.md", "/novel/wiki/entities/a.md"),
          mdNode("b.md", "/novel/wiki/entities/b.md"),
          mdNode("c.md", "/novel/wiki/entities/c.md"),
          mdNode("d.md", "/novel/wiki/entities/d.md"),
        ]
      }
      return []
    })
    fsMocks.readFile.mockImplementation(async (p: string) => {
      if (p.endsWith("a.md")) {
        return "---\ntype: entity\n---\n正文" // no tags
      }
      if (p.endsWith("b.md")) {
        return "---\ntype: page\ntags: [character]\n---\n正文" // not entity
      }
      if (p.endsWith("c.md")) {
        return "---\ntype: entity\ntags:\n  - character\n---\n# 从标题提取\n正文" // title from heading
      }
      return "没有 frontmatter 的正文" // parseFrontmatter -> null
    })
    const names = await listBindableNovelCharacters("/novel")
    expect(names).toEqual(["从标题提取"])
  })

  it("skips unreadable entity files and missing entity dir", async () => {
    fsMocks.listDirectory.mockImplementation(async (p: string) => {
      if (p.endsWith("/wiki/entities")) {
        return [mdNode("bad.md", "/novel/wiki/entities/bad.md")]
      }
      return []
    })
    fsMocks.readFile.mockRejectedValue(new Error("ENOENT"))
    const names = await listBindableNovelCharacters("/novel")
    expect(names).toEqual([])
  })

  it("skips unreadable outline files", async () => {
    fsMocks.listDirectory.mockImplementation(async (p: string) => {
      if (p.endsWith("/wiki/entities")) return []
      if (p.endsWith("/wiki/outlines")) {
        return [mdNode("人物.md", "/novel/wiki/outlines/人物.md")]
      }
      return []
    })
    fsMocks.readFile.mockRejectedValue(new Error("ENOENT"))
    const names = await listBindableNovelCharacters("/novel")
    expect(names).toEqual([])
  })

  it("throws on missing entities dir is tolerated and continues to outlines", async () => {
    fsMocks.listDirectory.mockImplementation(async (p: string) => {
      if (p.endsWith("/wiki/entities")) throw new Error("no entities dir")
      if (p.endsWith("/wiki/outlines")) {
        return [mdNode("人物.md", "/novel/wiki/outlines/人物.md")]
      }
      return []
    })
    fsMocks.readFile.mockResolvedValue(
      "---\ntitle: 人物\n---\n## 白砚\n正文\n## 王迦\n正文",
    )
    const names = await listBindableNovelCharacters("/novel")
    expect(names).toEqual(["白砚", "王迦"])
  })

  it("extracts character sections from outline headings, filtering non-character sections", async () => {
    fsMocks.listDirectory.mockImplementation(async (p: string) => {
      if (p.endsWith("/wiki/entities")) return []
      if (p.endsWith("/wiki/outlines")) {
        return [
          mdNode("人物-主.md", "/novel/wiki/outlines/人物-主.md"),
          mdNode("其它.md", "/novel/wiki/outlines/其它.md"),
        ]
      }
      return []
    })
    fsMocks.readFile.mockImplementation(async (p: string) => {
      if (p.endsWith("人物-主.md")) {
        return [
          "---",
          "title: 主要人物",
          "outline_category: characters",
          "---",
          "",
          "## 白砚",
          "冷静的观察者。",
          "## 王迦",
          "智性掌控者。",
          "## 苏未晞",
          "怯懦的受害者。",
          "## 人物关系",
          "白砚与王迦是旧友。",
          "## 总览",
          "全书状态。",
          "## 群像",
          "性格与群像定位：全员。",
        ].join("\n")
      }
      return "---\ntitle: 设定说明\n---\n没有角色标题。"
    })
    const names = await listBindableNovelCharacters("/novel")
    // zh-CN collation: 白 < 苏 < 王
    expect(names).toEqual(["白砚", "苏未晞", "王迦"])
  })

  it("filters ignored names after heading extraction", async () => {
    fsMocks.listDirectory.mockImplementation(async (p: string) => {
      if (p.endsWith("/wiki/entities")) return []
      if (p.endsWith("/wiki/outlines")) return [mdNode("人物.md", "/novel/wiki/outlines/人物.md")]
      return []
    })
    fsMocks.readFile.mockResolvedValue([
      "---",
      "outline_category: characters",
      "---",
      "## 白砚",
      "正文",
      "## 人物关系",
      "白砚与王迦是旧友。",
    ].join("\n"))

    expect(await listBindableNovelCharacters("/novel")).toEqual(["白砚"])
  })

  it("filters ignored outline heading names", async () => {
    fsMocks.listDirectory.mockImplementation(async (p: string) => {
      if (p.endsWith("/wiki/entities")) return []
      if (p.endsWith("/wiki/outlines")) return [mdNode("人物.md", "/novel/wiki/outlines/人物.md")]
      return []
    })
    fsMocks.readFile.mockResolvedValue([
      "---",
      "outline_category: characters",
      "---",
      "## 人物设定",
      "说明",
      "## 白砚",
      "正文",
    ].join("\n"))

    expect(await listBindableNovelCharacters("/novel")).toEqual(["白砚"])
  })

  it("filters empty-titled, ignored and oversized outline headings", async () => {
    fsMocks.listDirectory.mockImplementation(async (p: string) => {
      if (p.endsWith("/wiki/entities")) return []
      if (p.endsWith("/wiki/outlines")) {
        return [mdNode("人物.md", "/novel/wiki/outlines/人物.md")]
      }
      return []
    })
    fsMocks.readFile.mockResolvedValue(
      [
        "---",
        "outline_category: characters",
        "---",
        "## ：",
        "空标题体。",
        "## 人物设定",
        "设定体。",
        "## " + "长".repeat(45),
        "超长标题体。",
        "## 白砚",
        "正文。",
      ].join("\n"),
    )
    const names = await listBindableNovelCharacters("/novel")
    expect(names).toEqual(["白砚"])
  })

  it("includes outline by outline_category and strips 标题：前缀 in headings", async () => {
    fsMocks.listDirectory.mockImplementation(async (p: string) => {
      if (p.endsWith("/wiki/entities")) return []
      if (p.endsWith("/wiki/outlines")) {
        return [mdNode("detail.md", "/novel/wiki/outlines/detail.md")]
      }
      return []
    })
    fsMocks.readFile.mockResolvedValue(
      [
        "---",
        "outline_category: characters",
        "---",
        "### 苏未晞",
        "正文",
        "### 角色：林动",
        "正文",
      ].join("\n"),
    )
    const names = await listBindableNovelCharacters("/novel")
    // heading prefix after ： is kept when not in ignore list
    expect(names).toEqual(["角色", "苏未晞"])
  })

  it("falls back to page title when outline has no character headings", async () => {
    fsMocks.listDirectory.mockImplementation(async (p: string) => {
      if (p.endsWith("/wiki/entities")) return []
      if (p.endsWith("/wiki/outlines")) {
        return [mdNode("characters.md", "/novel/wiki/outlines/characters.md")]
      }
      return []
    })
    fsMocks.readFile.mockResolvedValue(
      "---\ntitle: 林动\noutline_category: characters\n---\n正文无标题",
    )
    const names = await listBindableNovelCharacters("/novel")
    expect(names).toEqual(["林动"])
  })

  it("skips ignored page title fallback and too-long names", async () => {
    fsMocks.listDirectory.mockImplementation(async (p: string) => {
      if (p.endsWith("/wiki/entities")) return []
      if (p.endsWith("/wiki/outlines")) {
        return [
          mdNode("role.md", "/novel/wiki/outlines/role.md"),
          mdNode("long.md", "/novel/wiki/outlines/long.md"),
        ]
      }
      return []
    })
    fsMocks.readFile.mockImplementation(async (p: string) => {
      if (p.endsWith("role.md")) return "---\ntitle: 角色设定\n---\n正文"
      return "---\ntitle: " + "长".repeat(45) + "\n---\n正文"
    })
    const names = await listBindableNovelCharacters("/novel")
    expect(names).toEqual([])
  })

  it("handles entity title > 40 chars filtered and heading title extraction", async () => {
    fsMocks.listDirectory.mockImplementation(async (p: string) => {
      if (p.endsWith("/wiki/entities")) {
        return [mdNode("long.md", "/novel/wiki/entities/long.md")]
      }
      return []
    })
    fsMocks.readFile.mockResolvedValue(
      "---\ntype: entity\ntags: [character]\ntitle: " + "长".repeat(50) + "\n---\n正文",
    )
    const names = await listBindableNovelCharacters("/novel")
    expect(names).toEqual([])
  })

  it("falls back to minimum heading level when no level repeats", async () => {
    fsMocks.listDirectory.mockImplementation(async (p: string) => {
      if (p.endsWith("/wiki/entities")) return []
      if (p.endsWith("/wiki/outlines")) {
        return [mdNode("人物.md", "/novel/wiki/outlines/人物.md")]
      }
      return []
    })
    fsMocks.readFile.mockResolvedValue(
      [
        "---",
        "title: 人物",
        "---",
        "## 白砚",
        "正文一",
        "### 王迦",
        "正文二",
        "#### 李昭然",
        "正文三",
      ].join("\n"),
    )
    const names = await listBindableNovelCharacters("/novel")
    // each level occurs once -> primary level = min(2,3,4) = 2 -> only 白砚
    expect(names).toEqual(["白砚"])
  })

  it("returns empty when both dirs are unreadable", async () => {
    fsMocks.listDirectory.mockRejectedValue(new Error("boom"))
    const names = await listBindableNovelCharacters("/novel")
    expect(names).toEqual([])
  })

  it("skips outline file without character hints entirely", async () => {
    fsMocks.listDirectory.mockImplementation(async (p: string) => {
      if (p.endsWith("/wiki/entities")) return []
      if (p.endsWith("/wiki/outlines")) {
        return [mdNode("plot.md", "/novel/wiki/outlines/plot.md")]
      }
      return []
    })
    fsMocks.readFile.mockResolvedValue("---\ntitle: 主线\n---\n## 白砚\n正文")
    const names = await listBindableNovelCharacters("/novel")
    // path/title don't match 人物|角色 and no outline_category -> skipped
    expect(names).toEqual([])
  })
})
