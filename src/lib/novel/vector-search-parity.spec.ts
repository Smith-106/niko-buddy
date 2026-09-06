import { beforeEach, describe, expect, it, vi } from "vitest"

/**
 * P1-IMP-14 — 向量检索孪生奇偶校验（search-adapter.runVectorSearch ↔
 * context-engine.runVectorSearchForContext）。
 *
 * 两项改动前是同形双份实现（PERF-NEW-06 并行 probe / SEC-001 sanitize /
 * 300 字 snippet 折叠 / dirs 优先序），任一侧演化另一侧静默漂移。
 * IMP-14 把公共流程收一到 vector-search-core.runVectorSearchShared，
 * 两孪生改薄包装（签名零变化）。
 *
 * 本 spec 钉死两件事：
 *   A. 公共面 —— 同一输入下，两孪生投影到公共字段 {path,title,snippet} 后
 *      MUST 逐元素 deep-equal 且顺序一致（≥8 组输入，见 GROUPS）。
 *   B. 差异面 —— 唯一被参数化的语义差异是 IC-02 相关性门控（context 侧有、
 *      adapter 侧无）。该差异 MUST 只影响「候选集」，不得连带改变命中项的
 *      path/title/snippet 口径或相对顺序（见 divergence 组）。
 *
 * mock 面只覆盖外部 IO（fs / embedding）；vector-search-core / vector-relevance /
 * graph-adapter 走真实实现 —— 对拍的正是这份共享实现本身。
 */

const mocks = vi.hoisted(() => ({
  readFile: vi.fn(),
  searchByEmbedding: vi.fn(),
}))

vi.mock("@/commands/fs", () => ({
  readFile: (...args: unknown[]) => mocks.readFile(...args),
  listDirectory: vi.fn(async () => []),
  getFileModifiedTime: vi.fn(async () => 0),
}))

vi.mock("@/lib/embedding", () => ({
  searchByEmbedding: (...args: unknown[]) => mocks.searchByEmbedding(...args),
}))

import { runVectorSearch } from "./search-adapter"
import { runVectorSearchForContext } from "./context-engine"
import type { EmbeddingConfig } from "@/stores/wiki-store"

const PP = "/proj"

const embOn = (model = "m"): EmbeddingConfig => ({
  enabled: true,
  endpoint: "http://127.0.0.1:1",
  apiKey: "k",
  model,
})
const embOff = (): EmbeddingConfig => ({ ...embOn(), enabled: false })

/** 两孪生公共投影面（adapter 多 type/relevance，context 多无 —— 只比对交集）。 */
interface CommonHit {
  path: string
  title: string
  snippet: string
}

async function bothTwins(
  query: string,
  limit: number,
  embCfg: EmbeddingConfig,
): Promise<{ adapter: CommonHit[]; context: CommonHit[]; adapterRelevance: number[] }> {
  const adapterRaw = await runVectorSearch(PP, query, limit, embCfg)
  const contextRaw = await runVectorSearchForContext(PP, query, limit, { embeddingConfig: embCfg })
  return {
    adapter: adapterRaw.map((r) => ({ path: r.path, title: r.title, snippet: r.snippet })),
    context: contextRaw.map((r) => ({ path: r.path, title: r.title, snippet: r.snippet })),
    adapterRelevance: adapterRaw.map((r) => r.relevance),
  }
}

/** 命中即返回内容的 fs 桩：未登记路径一律抛错（模拟文件不存在）。 */
function filesExist(map: Record<string, string>) {
  mocks.readFile.mockImplementation(async (p: unknown) => {
    const key = String(p)
    if (key in map) return map[key]
    throw new Error(`ENOENT: ${key}`)
  })
}

const vr = (id: string, score = 0.9) => ({ id, score })

beforeEach(() => {
  mocks.readFile.mockReset()
  mocks.searchByEmbedding.mockReset()
  mocks.searchByEmbedding.mockImplementation(async () => [])
})

describe("P1-IMP-14 向量孪生奇偶：公共面 deep-equal 且顺序一致", () => {
  it("组 1 · 全部命中：三项字段逐元素相等，顺序一致", async () => {
    mocks.searchByEmbedding.mockResolvedValue([vr("alpha"), vr("beta"), vr("gamma")])
    filesExist({
      [`${PP}/wiki/entities/alpha.md`]: "# 甲\n正文 A",
      [`${PP}/wiki/concepts/beta.md`]: "# 乙\n正文 B",
      [`${PP}/wiki/sources/gamma.md`]: "# 丙\n正文 C",
    })
    const { adapter, context } = await bothTwins("q", 3, embOn())
    expect(adapter.length).toBeGreaterThan(0)
    expect(adapter).toEqual(context)
    expect(adapter.map((h) => h.path)).toEqual(context.map((h) => h.path))
    expect(adapter.map((h) => h.path)).toEqual([
      `${PP}/wiki/entities/alpha.md`,
      `${PP}/wiki/concepts/beta.md`,
      `${PP}/wiki/sources/gamma.md`,
    ])
  })

  it("组 2 · 部分文件缺失：两侧同集合同顺序", async () => {
    mocks.searchByEmbedding.mockResolvedValue([vr("a"), vr("missing-1"), vr("b"), vr("missing-2")])
    filesExist({
      [`${PP}/wiki/entities/a.md`]: "# A",
      [`${PP}/wiki/queries/b.md`]: "# B",
    })
    const { adapter, context } = await bothTwins("q", 4, embOn())
    expect(adapter).toHaveLength(2)
    expect(adapter).toEqual(context)
  })

  it("组 3 · 标题三级来源（H1 / frontmatter title / safeId 兜底）两侧一致", async () => {
    mocks.searchByEmbedding.mockResolvedValue([vr("h1"), vr("fm"), vr("bare")])
    filesExist({
      [`${PP}/wiki/entities/h1.md`]: "# 标题甲\n正文",
      [`${PP}/wiki/concepts/fm.md`]: "---\ntitle: 标题乙\n---\n正文",
      [`${PP}/wiki/sources/bare.md`]: "无标题正文",
    })
    const { adapter, context } = await bothTwins("q", 3, embOn())
    expect(adapter.map((h) => h.title)).toEqual(["标题甲", "标题乙", "bare"])
    expect(adapter).toEqual(context)
  })

  it("组 4 · 路径穿越 id：sanitize 后探测路径集一致（SEC-001 奇偶）", async () => {
    mocks.searchByEmbedding.mockResolvedValue([vr("evil/../../escape")])
    // 真实 sanitizeEntitySlug：去分隔符 → 折叠 .. → "evil.escape"（钉死实际口径，
    // 不用函数反推，否则断言自证）。
    filesExist({ [`${PP}/wiki/entities/evil.escape.md`]: "# Safe" })
    const { adapter, context } = await bothTwins("q", 1, embOn())
    const probed = mocks.readFile.mock.calls.map((c) => String(c[0]))
    // 两侧各 probe 7 个候选（6 目录 + 根），共 14 次，且候选集完全相同。
    expect(probed).toHaveLength(14)
    expect(probed.slice(0, 7)).toEqual(probed.slice(7))
    expect(probed[0]).toBe(`${PP}/wiki/entities/evil.escape.md`)
    expect(probed.every((p) => !p.includes("../"))).toBe(true)
    expect(adapter).toEqual(context)
    expect(adapter).toHaveLength(1)
  })

  it("组 5 · 空向量结果：两侧均 []", async () => {
    mocks.searchByEmbedding.mockResolvedValue([])
    filesExist({})
    const { adapter, context } = await bothTwins("q", 3, embOn())
    expect(adapter).toEqual([])
    expect(context).toEqual([])
    expect(mocks.readFile).not.toHaveBeenCalled()
  })

  it("组 6 · embedding 未启用：两侧均 [] 且不触达 embedding/fs", async () => {
    filesExist({ [`${PP}/wiki/entities/a.md`]: "# A" })
    const { adapter, context } = await bothTwins("q", 3, embOff())
    expect(adapter).toEqual([])
    expect(context).toEqual([])
    expect(mocks.searchByEmbedding).not.toHaveBeenCalled()
    expect(mocks.readFile).not.toHaveBeenCalled()
  })

  it("组 7 · searchByEmbedding 抛错：两侧均降级 []（外层 catch 奇偶）", async () => {
    mocks.searchByEmbedding.mockRejectedValue(new Error("lancedb down"))
    filesExist({})
    const { adapter, context } = await bothTwins("q", 3, embOn())
    expect(adapter).toEqual([])
    expect(context).toEqual([])
  })

  it("组 8 · 顺序敏感：乱序 id + 根回退交错，两侧输出顺序一致", async () => {
    mocks.searchByEmbedding.mockResolvedValue([vr("zeta"), vr("alpha"), vr("mid"), vr("beta")])
    filesExist({
      // zeta 只在 wiki 根命中（走根回退），alpha 走 entities 目录优先。
      [`${PP}/wiki/zeta.md`]: "# Z 根回退",
      [`${PP}/wiki/entities/alpha.md`]: "# A 目录",
      [`${PP}/wiki/queries/mid.md`]: "# M",
      [`${PP}/wiki/comparison/beta.md`]: "# B",
    })
    const { adapter, context } = await bothTwins("q", 4, embOn())
    expect(adapter.map((h) => h.path)).toEqual([
      `${PP}/wiki/zeta.md`,
      `${PP}/wiki/entities/alpha.md`,
      `${PP}/wiki/queries/mid.md`,
      `${PP}/wiki/comparison/beta.md`,
    ])
    expect(adapter).toEqual(context)
  })

  it("组 9 · 长正文 300 字截断 + 换行折叠：snippet 字节级一致", async () => {
    const long = `# 长文\n${"行一\n行二\n".repeat(80)}`
    mocks.searchByEmbedding.mockResolvedValue([vr("long")])
    filesExist({ [`${PP}/wiki/entities/long.md`]: long })
    const { adapter, context } = await bothTwins("q", 1, embOn())
    expect(adapter).toHaveLength(1)
    expect(adapter[0].snippet).toBe(long.slice(0, 300).replace(/\n/g, " "))
    expect(adapter[0].snippet).not.toContain("\n")
    expect(adapter).toEqual(context)
  })

  it("组 10 · limit 边界（结果数 > limit）：两侧同截断同顺序", async () => {
    mocks.searchByEmbedding.mockResolvedValue([vr("a"), vr("b"), vr("c"), vr("d"), vr("e")])
    filesExist({
      [`${PP}/wiki/entities/a.md`]: "# A",
      [`${PP}/wiki/entities/b.md`]: "# B",
      [`${PP}/wiki/entities/c.md`]: "# C",
      [`${PP}/wiki/entities/d.md`]: "# D",
      [`${PP}/wiki/entities/e.md`]: "# E",
    })
    const { adapter, context } = await bothTwins("q", 2, embOn())
    expect(adapter).toHaveLength(2)
    expect(adapter).toEqual(context)
    // fetch 宽度口径同为 Math.max(limit*2, 10)。
    expect(mocks.searchByEmbedding).toHaveBeenLastCalledWith(PP, "q", expect.anything(), 10)
  })

  it("组 11 · 同名双落点（目录优先于根）：两侧选中同一路径", async () => {
    mocks.searchByEmbedding.mockResolvedValue([vr("dup")])
    filesExist({
      [`${PP}/wiki/entities/dup.md`]: "# 目录版",
      [`${PP}/wiki/dup.md`]: "# 根版",
      [`${PP}/wiki/concepts/dup.md`]: "# 概念版",
    })
    const { adapter, context } = await bothTwins("q", 1, embOn())
    expect(adapter[0].path).toBe(`${PP}/wiki/entities/dup.md`)
    expect(adapter).toEqual(context)
  })

  it("组 12 · 全部读取失败：两侧均 [] 且 probe 次数对称", async () => {
    mocks.searchByEmbedding.mockResolvedValue([vr("x"), vr("y")])
    mocks.readFile.mockRejectedValue(new Error("no fs"))
    const { adapter, context } = await bothTwins("q", 2, embOn())
    expect(adapter).toEqual([])
    expect(context).toEqual([])
    expect(mocks.readFile).toHaveBeenCalledTimes(28) // 2 vr × 7 候选 × 2 侧
  })

  it("组 13 · relevance 口径：adapter relevance 恒等 vr.score（共享 vr 引用）", async () => {
    mocks.searchByEmbedding.mockResolvedValue([vr("a", 0.77), vr("b", 0.51)])
    filesExist({
      [`${PP}/wiki/entities/a.md`]: "# A",
      [`${PP}/wiki/concepts/b.md`]: "# B",
    })
    const { adapter, context, adapterRelevance } = await bothTwins("q", 2, embOn())
    expect(adapterRelevance).toEqual([0.77, 0.51])
    expect(adapter).toEqual(context)
  })
})

describe("P1-IMP-14 向量孪生奇偶：唯一参数化差异面（IC-02 门控）不得外溢", () => {
  it("组 14 · 低于 0.45 的噪音：context 侧剔除、adapter 侧保留，保留项口径一致", async () => {
    mocks.searchByEmbedding.mockResolvedValue([vr("loud", 0.9), vr("quiet", 0.2), vr("loud2", 0.6)])
    filesExist({
      [`${PP}/wiki/entities/loud.md`]: "# 响 1",
      [`${PP}/wiki/entities/quiet.md`]: "# 静",
      [`${PP}/wiki/concepts/loud2.md`]: "# 响 2",
    })
    const { adapter, context } = await bothTwins("q", 3, embOn())
    // 差异只体现在候选集大小与被剔除项，不改变其余项的 path/title/snippet 与相对顺序。
    expect(adapter.map((h) => h.path)).toEqual([
      `${PP}/wiki/entities/loud.md`,
      `${PP}/wiki/entities/quiet.md`,
      `${PP}/wiki/concepts/loud2.md`,
    ])
    expect(context.map((h) => h.path)).toEqual([
      `${PP}/wiki/entities/loud.md`,
      `${PP}/wiki/concepts/loud2.md`,
    ])
    expect(context).toEqual(adapter.filter((h) => h.title !== "静"))
  })

  it("组 15 · matchedChunks 真实命中分参与门控：两侧共有项口径一致", async () => {
    mocks.searchByEmbedding.mockResolvedValue([
      { id: "chunky", score: 0.1, matchedChunks: [{ text: "t", headingPath: "h", score: 0.8 }] },
      { id: "flat", score: 0.3 },
    ])
    filesExist({
      [`${PP}/wiki/entities/chunky.md`]: "# Chunk",
      [`${PP}/wiki/entities/flat.md`]: "# Flat",
    })
    const { adapter, context } = await bothTwins("q", 2, embOn())
    expect(adapter).toHaveLength(2)
    expect(context).toEqual([{ path: `${PP}/wiki/entities/chunky.md`, title: "Chunk", snippet: "# Chunk" }])
    expect(context).toEqual(adapter.filter((h) => h.title === "Chunk"))
  })

  it("组 16 · 共享核心单一实现：两孪生对同一 id 集探测路径完全同构", async () => {
    mocks.searchByEmbedding.mockResolvedValue([vr("solo")])
    mocks.readFile.mockRejectedValue(new Error("nope"))
    await runVectorSearch(PP, "q", 1, embOn())
    const first = mocks.readFile.mock.calls.map((c) => String(c[0]))
    mocks.readFile.mockClear()
    await runVectorSearchForContext(PP, "q", 1, { embeddingConfig: embOn() })
    const second = mocks.readFile.mock.calls.map((c) => String(c[0]))
    expect(first).toEqual(second)
    expect(first).toEqual([
      `${PP}/wiki/entities/solo.md`,
      `${PP}/wiki/concepts/solo.md`,
      `${PP}/wiki/sources/solo.md`,
      `${PP}/wiki/synthesis/solo.md`,
      `${PP}/wiki/comparison/solo.md`,
      `${PP}/wiki/queries/solo.md`,
      `${PP}/wiki/solo.md`,
    ])
  })
})
