/** C4 冒烟 + K-2 实体子目录/章节目录命中覆盖：src/lib/novel/vector-search-core.ts */
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { EmbeddingConfig } from "@/stores/wiki-store"
import { ENTITY_SUBDIRS } from "./entity-subdir-resolver"

const mocks = vi.hoisted(() => ({
  readFile: vi.fn(),
  listDirectory: vi.fn(),
  searchByEmbedding: vi.fn(),
}))

vi.mock("@/commands/fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/commands/fs")>()
  return {
    ...actual,
    readFile: (...args: unknown[]) => mocks.readFile(...args),
    listDirectory: (...args: unknown[]) => mocks.listDirectory(...args),
  }
})

vi.mock("@/lib/embedding", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/embedding")>()
  return {
    ...actual,
    searchByEmbedding: (...args: unknown[]) => mocks.searchByEmbedding(...args),
  }
})

import { VECTOR_WIKI_DIRS, extractTitle, runVectorSearchShared } from "./vector-search-core"

const PP = "/proj"
const embOn: EmbeddingConfig = {
  enabled: true,
  endpoint: "http://127.0.0.1:1",
  apiKey: "k",
  model: "m",
}

describe("vector-search-core.ts smoke", () => {
  it("exports VECTOR_WIKI_DIRS with 13 dirs keeping entities first and memory included", () => {
    expect(VECTOR_WIKI_DIRS).toHaveLength(13)
    expect(VECTOR_WIKI_DIRS[0]).toBe("entities")
    for (const sub of ENTITY_SUBDIRS) {
      expect(VECTOR_WIKI_DIRS).toContain(`entities/${sub}`)
    }
    expect(VECTOR_WIKI_DIRS).toContain("chapters")
    expect(VECTOR_WIKI_DIRS).toContain("memory")
  })
  it("exports extractTitle", () => {
    expect(extractTitle).toBeDefined()
  })
  it("exports runVectorSearchShared", () => {
    expect(runVectorSearchShared).toBeDefined()
  })
})

describe("K-2 runVectorSearchShared 实体子目录与 chapters 命中", () => {
  beforeEach(() => {
    mocks.readFile.mockReset()
    mocks.listDirectory.mockReset()
    mocks.listDirectory.mockResolvedValue([])
    mocks.searchByEmbedding.mockReset()
  })

  it.each([
    ...ENTITY_SUBDIRS.map((sub) => `entities/${sub}`),
    "chapters",
    "memory",
  ])("可从 wiki/%s 命中对应页面", async (dir) => {
    const targetPath = `${PP}/wiki/${dir}/doc-1.md`
    mocks.searchByEmbedding.mockResolvedValue([{ id: "doc-1", score: 0.91 }])
    mocks.readFile.mockImplementation(async (p: unknown) => {
      if (String(p) === targetPath) return `# 命中 ${dir}\n正文内容`
      throw new Error("ENOENT")
    })

    const hits = await runVectorSearchShared({ pp: PP, query: "q", limit: 3, embCfg: embOn })
    expect(hits).toHaveLength(1)
    expect(hits[0]?.path).toBe(targetPath)
    expect(hits[0]?.title).toBe(`命中 ${dir}`)
  })

  it("R2-M02: 仅纯数字遗留 page_id (/^\\d{3,}$/) 额外兼容探测 wiki/chapters/chapter-${safeId}.md", async () => {
    const targetPath = `${PP}/wiki/chapters/chapter-003.md`
    mocks.searchByEmbedding.mockResolvedValue([{ id: "003", score: 0.89 }])
    mocks.readFile.mockImplementation(async (p: unknown) => {
      if (String(p) === targetPath) return "# 第三章\n正文"
      throw new Error("ENOENT")
    })

    const hits = await runVectorSearchShared({ pp: PP, query: "q", limit: 1, embCfg: embOn })
    expect(hits).toHaveLength(1)
    expect(hits[0]?.path).toBe(targetPath)
    expect(hits[0]?.title).toBe("第三章")

    // 非纯数字 id（如 "chapter-003" 或 "12"）绝不额外探测 chapter-<id>.md
    mocks.readFile.mockClear()
    mocks.searchByEmbedding.mockResolvedValue([{ id: "chapter-003", score: 0.89 }])
    mocks.readFile.mockRejectedValue(new Error("ENOENT"))
    await runVectorSearchShared({ pp: PP, query: "q", limit: 1, embCfg: embOn })
    const probed = mocks.readFile.mock.calls.map((c) => String(c[0]))
    expect(probed.some((p) => p.includes("chapter-chapter-003.md"))).toBe(false)
  })

  it("entities 顶层仍优先于实体子目录与 chapters", async () => {
    mocks.searchByEmbedding.mockResolvedValue([{ id: "same", score: 0.9 }])
    mocks.readFile.mockImplementation(async (p: unknown) => {
      const key = String(p)
      if (key === `${PP}/wiki/entities/same.md`) return "# 顶层实体\n正文"
      if (key === `${PP}/wiki/entities/characters/same.md`) return "# 子目录角色\n正文"
      if (key === `${PP}/wiki/chapters/same.md`) return "# 章节\n正文"
      throw new Error("ENOENT")
    })

    const hits = await runVectorSearchShared({ pp: PP, query: "q", limit: 1, embCfg: embOn })
    expect(hits).toHaveLength(1)
    expect(hits[0]?.path).toBe(`${PP}/wiki/entities/same.md`)
    expect(hits[0]?.title).toBe("顶层实体")
  })

  it("R3-M06: 卷子目录 wiki/chapters/vol-1/chapter-003.md 通过 chapter-003 与纯数字 003 均可命中", async () => {
    const volPath = `${PP}/wiki/chapters/vol-1/chapter-003.md`
    mocks.listDirectory.mockImplementation(async (dir: unknown) => {
      if (String(dir) === `${PP}/wiki/chapters`) {
        return [
          {
            name: "vol-1",
            path: `${PP}/wiki/chapters/vol-1`,
            is_dir: true,
            children: [{ name: "chapter-003.md", path: volPath, is_dir: false }],
          },
        ]
      }
      return []
    })
    mocks.readFile.mockImplementation(async (p: unknown) => {
      if (String(p) === volPath) return "# 第三章 卷子目录\n正文"
      throw new Error("ENOENT")
    })

    mocks.searchByEmbedding.mockResolvedValue([{ id: "chapter-003", score: 0.92 }])
    const byStem = await runVectorSearchShared({ pp: PP, query: "q", limit: 2, embCfg: embOn })
    expect(byStem).toHaveLength(1)
    expect(byStem[0]?.path).toBe(volPath)
    expect(byStem[0]?.title).toBe("第三章 卷子目录")

    mocks.searchByEmbedding.mockResolvedValue([{ id: "003", score: 0.9 }])
    const byLegacyNum = await runVectorSearchShared({ pp: PP, query: "q", limit: 2, embCfg: embOn })
    expect(byLegacyNum).toHaveLength(1)
    expect(byLegacyNum[0]?.path).toBe(volPath)
  })

  it("R3-M06: 严格过滤草稿文件（.draft.md / -去AI味稿.md），绝不作为向量命中返回", async () => {
    const draftPath = `${PP}/wiki/chapters/chapter-003.draft.md`
    const antiAiPath = `${PP}/wiki/chapters/vol-1/chapter-003-去AI味稿.md`
    mocks.listDirectory.mockResolvedValue([
      { name: "chapter-003.draft.md", path: draftPath, is_dir: false },
      {
        name: "vol-1",
        path: `${PP}/wiki/chapters/vol-1`,
        is_dir: true,
        children: [{ name: "chapter-003-去AI味稿.md", path: antiAiPath, is_dir: false }],
      },
    ])
    mocks.readFile.mockImplementation(async (p: unknown) => {
      if (String(p) === draftPath || String(p) === antiAiPath) return "# 草稿\n正文"
      throw new Error("ENOENT")
    })
    mocks.searchByEmbedding.mockResolvedValue([
      { id: "chapter-003.draft", score: 0.95 },
      { id: "chapter-003-去AI味稿", score: 0.94 },
    ])

    const hits = await runVectorSearchShared({ pp: PP, query: "q", limit: 5, embCfg: embOn })
    expect(hits).toEqual([])
  })
})
