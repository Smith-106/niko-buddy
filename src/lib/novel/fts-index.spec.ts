import { beforeEach, describe, expect, it, vi } from "vitest"

// 覆盖增补：rebuildWikiFtsIndex 的 IO 层错误路径（wiki 目录不可读 / 单文件读失败 / 无标题回退）。
// 只用依赖替换拦在 @/commands/fs 边界，被测模块本身与纯函数层不动。
const fsMocks = vi.hoisted(() => ({
  readFile: vi.fn(),
  listDirectory: vi.fn(),
  writeFileAtomic: vi.fn(),
}))
vi.mock("@/commands/fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/commands/fs")>()
  return {
    ...actual,
    readFile: (...args: unknown[]) => fsMocks.readFile(...args),
    listDirectory: (...args: unknown[]) => fsMocks.listDirectory(...args),
    writeFileAtomic: (...args: unknown[]) => fsMocks.writeFileAtomic(...args),
  }
})

import {
  rebuildWikiFtsIndex,
  buildFtsIndex,
  FTS_INDEX_VERSION,
  searchFtsIndex,
  type FtsIndex,
} from "./fts-index"

const corpus = [
  { id: "entities/张三", title: "张三", text: "张三是一名剑客，在雪夜敲响李四的门。" },
  { id: "entities/李四", title: "李四", text: "李四是青云山弟子，擅长炼丹。" },
  { id: "concepts/雪夜", title: "雪夜", text: "雪夜事件发生在第三章，主角见证了一场血月。" },
]

describe("fts-index (64 号实施：可重建持久 FTS 索引)", () => {
  it("build：倒排正确（token → docId 序，含 tf 多次出现）", () => {
    const idx = buildFtsIndex(corpus, { now: "2026-09-06T00:00:00.000Z" })
    expect(idx.version).toBe(FTS_INDEX_VERSION)
    expect(idx.postings["张三"]).toBeTruthy()
    // 张三出现在 doc0 标题+正文 → 至少 2 次
    expect(idx.postings["张三"].filter((id) => id === "entities/张三").length).toBeGreaterThanOrEqual(2)
    expect(idx.docFreq["张三"]).toBe(1)
  })

  it("中文 bigram 查询召回：雪夜 → 命中 doc0 与 doc2", () => {
    const idx = buildFtsIndex(corpus)
    const hits = searchFtsIndex(idx, "雪夜")
    expect(hits.length).toBeGreaterThanOrEqual(2)
  })

  it("BM25 排序：高频匹配 doc 靠前", () => {
    const idx = buildFtsIndex(corpus)
    const hits = searchFtsIndex(idx, "张三")
    expect(hits[0].id).toBe("entities/张三")
    expect(hits[0].score).toBeGreaterThan(0)
  })

  it("重建幂等：同语料两次 build 深比较（除 builtAt）", () => {
    const a = buildFtsIndex(corpus, { now: "T" })
    const b = buildFtsIndex(corpus, { now: "T" })
    expect(JSON.stringify(a)).toBe(JSON.stringify(b))
  })

  it("空语料：空索引，查询返回 []", () => {
    const idx = buildFtsIndex([], { now: "T" })
    expect(searchFtsIndex(idx, "雪夜")).toEqual([])
  })

  it("单文档索引", () => {
    const idx = buildFtsIndex([corpus[0]])
    expect(Object.keys(idx.docs)).toHaveLength(1)
    const hits = searchFtsIndex(idx, "剑客")
    expect(hits).toHaveLength(1)
  })

  it("重建后旧词条消失（全量重建语义）", () => {
    const idx1 = buildFtsIndex(corpus)
    const idx2 = buildFtsIndex([corpus[0]])
    expect(idx2.postings["青云山"]).toBeUndefined()
    // 原语料 3 篇含 青云山 相关词；重建 1 篇后倒排收缩
    expect(Object.keys(idx2.postings).length).toBeLessThan(Object.keys(idx1.postings).length)
  })

  it("topK 截断", () => {
    const idx = buildFtsIndex(corpus)
    const hits = searchFtsIndex(idx, "雪夜", 1)
    expect(hits.length).toBeLessThanOrEqual(1)
  })

  it("零命中返回 []", () => {
    const idx = buildFtsIndex(corpus)
    // 用全角字母组合（bigram 下无共享词元）
    expect(searchFtsIndex(idx, "ＱＷＥＲＴＹＺＸＣＶＢ")).toEqual([])
  })

  it("纯性：searchFtsIndex 不改索引", () => {
    const idx = buildFtsIndex(corpus, { now: "T" })
    const snapshot = JSON.stringify(idx)
    searchFtsIndex(idx, "雪夜")
    expect(JSON.stringify(idx)).toBe(snapshot)
  })

  it("空查询返回 []", () => {
    const idx = buildFtsIndex(corpus)
    expect(searchFtsIndex(idx, "  ")).toEqual([])
  })

  it("docs 元数据含 length/path", () => {
    const idx = buildFtsIndex(corpus, { now: "T" })
    const meta = (idx as FtsIndex).docs["entities/张三"]
    expect(meta.length).toBeGreaterThan(0)
    expect(meta.path).toBe("entities/张三")
  })
})

describe("fts-index 覆盖增补：损坏/不完整索引的查询降级", () => {
  it("倒排指向未知 docId（索引与 docs 不同步）→ 跳过幽灵文档，不抛且不返回它", () => {
    // 手工构造损坏索引：postings 里有 ghost，docs 里没有对应元数据。
    // 消费方契约：检索绝不因索引损坏而抛（宁可少召回，不可挂死）。
    const idx: FtsIndex = {
      version: FTS_INDEX_VERSION,
      docs: {
        d1: { id: "d1", title: "真文档", path: "entities/d1", length: 3 },
        d2: { id: "d2", title: "旁文档", path: "entities/d2", length: 3 },
      },
      postings: { zzz: ["ghost", "d1"] },
      docFreq: { zzz: 2 },
      builtAt: "T",
    }
    const hits = searchFtsIndex(idx, "zzz")
    expect(hits.map((h) => h.id)).toEqual(["d1"])
    expect(hits[0]!.title).toBe("真文档")
    expect(hits[0]!.score).toBeGreaterThan(0)
  })

  it("docs 为空但倒排残留 → 零命中（avgLen 除零保护）", () => {
    const idx: FtsIndex = {
      version: FTS_INDEX_VERSION,
      docs: {},
      postings: { zzz: ["d1"] },
      docFreq: { zzz: 1 },
      builtAt: "T",
    }
    expect(searchFtsIndex(idx, "zzz")).toEqual([])
  })

  it("docFreq 缺项 + 部分查询词不在倒排 → 仍按命中词打分（n 缺省 0 / 无倒排词跳过）", () => {
    const idx: FtsIndex = {
      version: FTS_INDEX_VERSION,
      docs: { d1: { id: "d1", title: "t", path: "p/d1", length: 4 } },
      // 只有 zzz 有倒排；qqq 无倒排；docFreq 全缺项（旧版/残缺索引形态）
      postings: { zzz: ["d1"] },
      docFreq: {},
      builtAt: "T",
    }
    const hits = searchFtsIndex(idx, "zzz qqq")
    expect(hits).toHaveLength(1)
    expect(hits[0]!.id).toBe("d1")
    expect(Number.isFinite(hits[0]!.score)).toBe(true)
    expect(hits[0]!.score).toBeGreaterThan(0)
  })
})

describe("fts-index 覆盖增补：rebuildWikiFtsIndex 的可重建副作用与错误路径", () => {
  beforeEach(() => {
    fsMocks.readFile.mockReset()
    fsMocks.listDirectory.mockReset()
    fsMocks.writeFileAtomic.mockReset()
  })

  it("wiki 目录不可读 → indexed:0 + 显式 error（零写盘，不抛）", async () => {
    fsMocks.listDirectory.mockRejectedValue(new Error("ENOENT: wiki"))
    const result = await rebuildWikiFtsIndex("/proj")
    expect(result).toEqual({ indexed: 0, errors: ["无法读取 wiki 目录"] })
    expect(fsMocks.writeFileAtomic).not.toHaveBeenCalled()
  })

  it("单文件读失败 → 该文件记 error，其余文件仍入索引并原子落盘（无标题则回退 pageId）", async () => {
    fsMocks.listDirectory.mockResolvedValue([
      { name: "good.md", path: "/proj/wiki/good.md", is_dir: false },
      { name: "broken.md", path: "/proj/wiki/broken.md", is_dir: false },
      { name: "untitled.md", path: "/proj/wiki/untitled.md", is_dir: false },
    ])
    fsMocks.readFile.mockImplementation(async (path: string) => {
      if (path.endsWith("broken.md")) throw new Error("EACCES: 权限不足")
      if (path.endsWith("untitled.md")) return "正文没有一级标题，只有散文。"
      return "# 张三\n\n张三是一名剑客。"
    })
    fsMocks.writeFileAtomic.mockResolvedValue(undefined)
    const progress: Array<{ completed: number; total: number; current: string }> = []

    const result = await rebuildWikiFtsIndex("/proj", (p) => progress.push({ ...p }))

    expect(result.indexed).toBe(2)
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]).toContain("broken.md")
    expect(result.errors[0]).toContain("权限不足")

    // 落盘一次，且内容是可回读的倒排（good.md 标题进 docs，untitled 回退 pageId）。
    expect(fsMocks.writeFileAtomic).toHaveBeenCalledTimes(1)
    const [writtenPath, writtenBody] = fsMocks.writeFileAtomic.mock.calls[0] as [string, string]
    expect(writtenPath.endsWith("/.niko-buddy/fts-index.json")).toBe(true)
    const written = JSON.parse(writtenBody) as FtsIndex
    expect(Object.keys(written.docs).sort()).toEqual(["good", "untitled"])
    expect(written.docs.good!.title).toBe("张三")
    expect(written.docs.untitled!.title).toBe("untitled")
    expect(written.postings.zzz).toBeUndefined()

    // 进度回调：逐文件（completed = 当前下标）+ 末尾一条完成态。
    expect(progress.map((p) => p.completed)).toEqual([0, 1, 2, 3])
    expect(progress[progress.length - 1]!.current).toBe("完成")
    expect(progress[progress.length - 1]!.total).toBe(3)
  })
})
