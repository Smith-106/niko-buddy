import { beforeEach, describe, expect, it, vi } from "vitest"
import { existsSync, readFileSync } from "node:fs"
import { resolve } from "node:path"

/**
 * P1-IMP-08 — KB-VIEW 消费面（generated JSON + 同步脚本）验收。
 *
 * 覆盖 findings 判据：
 *   1. 缺 routing.agent → 抛既有错（E-01 文案不变）
 *   2. 缺 builtFrom → 抛新明确错（新鲜度断言，不静默按旧视图路由）
 *   3. craft=13 下 draft 的部分阻断语义（collectionCounts 口径，V7/N-b）
 *   4. 同步脚本：最小消费面抽取 + builtFrom 一致性 + trust 投影守恒
 *      （第 4 项的源侧比对需 hub reference/ 在场，单仓 checkout 自动跳过）
 *
 * 未新增/未改动 search-adapter.spec.ts：本 spec 以 vi.mock 替换 generated JSON
 * 的 default 导出，配合 vi.resetModules() 逐例重建 search-adapter 模块图。
 */

const VIEW_PATH = "./kb/kb-routing-view.generated.json"

const VALID_VIEW = {
  schemaVersion: 2,
  builtFrom: "sha256:test-fingerprint",
  routing: { agent: { draft: ["craft", "corpus", "lexicon", "world_ref"], lookup: ["world_ref"] } },
  collectionCounts: { craft: 13, corpus: 0, lexicon: 0, world_ref: 0, tech: 71 },
  byQueryIntent: { draft: [{ collection: "craft", name: "ink", title: "ink", trust: "reference_only" }] },
  collections: { craft: [{ collection: "craft", name: "ink", trust: "reference_only" }], tech: [] },
}

/** 装载一份被替换过的视图，返回新的 search-adapter 模块面。 */
async function loadAdapterWith(view: unknown) {
  vi.doMock(VIEW_PATH, () => ({ default: view }))
  vi.resetModules()
  return import("./search-adapter")
}

beforeEach(() => {
  vi.doUnmock(VIEW_PATH)
  vi.resetModules()
})

describe("P1-IMP-08 routeByQueryIntent 消费面断言", () => {
  it("缺 routing.agent → 抛既有错（E-01 文案零改动）", async () => {
    const mod = await loadAdapterWith({ ...VALID_VIEW, routing: {} })
    expect(() => mod.loadKbRoutingMatrix()).toThrow(/缺少 routing\.agent/)
    expect(() => mod.routeByQueryIntent("draft")).toThrow(/REFERENCE-KB-VIEW\.json 缺少 routing\.agent/)
  })

  it("缺 builtFrom → 抛新明确错（P1-IMP-08 新鲜度断言，指向重跑同步脚本）", async () => {
    const noBuiltFrom = { ...VALID_VIEW }
    delete (noBuiltFrom as { builtFrom?: string }).builtFrom
    const mod = await loadAdapterWith(noBuiltFrom)
    // routing.agent 在位 —— 失败点必须是 builtFrom，不得被旧断言吞掉。
    expect(() => mod.loadKbRoutingMatrix()).not.toThrow()
    expect(() => mod.loadKbRoutingViewBuiltFrom()).toThrow(/缺少 builtFrom/)
    expect(() => mod.routeByQueryIntent("draft")).toThrow(/sync-kb-view-to-qmai\.mjs/)
  })

  it("builtFrom 为空串同样视为缺失（不接受空指纹）", async () => {
    const mod = await loadAdapterWith({ ...VALID_VIEW, builtFrom: "" })
    expect(() => mod.routeByQueryIntent("draft")).toThrow(/缺少 builtFrom/)
  })

  it("缺 collectionCounts → 明确报错（不得回退数组长度而误阻断全部路由）", async () => {
    const noCounts = { ...VALID_VIEW }
    delete (noCounts as { collectionCounts?: unknown }).collectionCounts
    const mod = await loadAdapterWith(noCounts)
    expect(() => mod.routeByQueryIntent("draft")).toThrow(/缺少 collectionCounts/)
  })

  it("craft=13 下 draft 部分阻断：craft 放行，三个空收藏各自报缺", async () => {
    const mod = await loadAdapterWith(VALID_VIEW)
    const res = mod.routeByQueryIntent("draft")
    expect(res.collections).toEqual(["craft"])
    expect(res.blocked).toEqual(["corpus", "lexicon", "world_ref"])
    expect(res.gaps).toHaveLength(3)
    expect(res.gaps.map((g: { collection: string }) => g.collection)).toEqual([
      "corpus",
      "lexicon",
      "world_ref",
    ])
    expect(res.gaps[0].message).toContain("禁止用 tech 工具仓冒充")
    expect(res.gaps[0].impactedIntents).toEqual(["draft"])
  })

  it("空收藏判定读 collectionCounts 而非数组长度（collections 空数组但计数 >0 → 放行）", async () => {
    const mod = await loadAdapterWith({
      ...VALID_VIEW,
      collectionCounts: { ...VALID_VIEW.collectionCounts, corpus: 7 },
      collections: { ...VALID_VIEW.collections, corpus: [] },
    })
    const res = mod.routeByQueryIntent("draft")
    expect(res.collections).toEqual(["craft", "corpus"])
    expect(res.blocked).toEqual(["lexicon", "world_ref"])
  })

  it("未知 intent → 三面皆空（allowlist 缺省空数组语义不变）", async () => {
    const mod = await loadAdapterWith(VALID_VIEW)
    expect(mod.routeByQueryIntent("nope")).toEqual({ collections: [], gaps: [], blocked: [] })
  })
})

describe("P1-IMP-08 仓内 generated 产物（真实文件，非 mock）", () => {
  const generatedPath = resolve(__dirname, "kb/kb-routing-view.generated.json")

  it("产物存在且自带 builtFrom / schemaVersion / routing.agent / collectionCounts", () => {
    const view = JSON.parse(readFileSync(generatedPath, "utf8"))
    expect(typeof view.builtFrom).toBe("string")
    expect(view.builtFrom.startsWith("sha256:")).toBe(true)
    expect(typeof view.schemaVersion).toBe("number")
    expect(Object.keys(view.routing.agent).sort()).toEqual([
      "draft",
      "lookup",
      "plan",
      "revise",
      "style",
    ])
    expect(view.collectionCounts.craft).toBeGreaterThan(0)
  })

  it("真实产物下 draft 路由：craft + corpus + lexicon + world_ref 放行（F3 补料后非空）", async () => {
    vi.resetModules()
    const mod = await import("./search-adapter")
    const res = mod.routeByQueryIntent("draft")
    // P1-IMP-09: corpus 采源后 corpus 也被放行（0→6 条目）
    // F3（2026-09-07）：lexicon 38 / world_ref 8 补料后不再被空收藏阻断
    expect(res.collections).toEqual(["craft", "corpus", "lexicon", "world_ref"])
    expect(res.blocked).toEqual([])
  })

  it("K-11 不变量：消费面 routing.agent 与 byQueryIntent 均无 tech 面", () => {
    const view = JSON.parse(readFileSync(generatedPath, "utf8"))
    for (const [intent, cols] of Object.entries(view.routing.agent as Record<string, string[]>)) {
      expect(cols, `routing.agent.${intent}`).not.toContain("tech")
    }
    type IntentEntry = { collection: string }
    const byIntent = view.byQueryIntent as Record<string, IntentEntry[]>
    const intentCollections = new Set(Object.values(byIntent).flat().map((e) => e.collection))
    expect(intentCollections.has("tech")).toBe(false)
  })

  it("content 类大字段不入包（最小消费面守恒）", () => {
    const view = JSON.parse(readFileSync(generatedPath, "utf8"))
    expect(Object.keys(view).sort()).toEqual([
      "_generated",
      "builtFrom",
      "byQueryIntent",
      "collectionCounts",
      "collections",
      "routing",
      "schemaVersion",
    ])
    type CollectionMap = Record<string, Record<string, unknown>[]>
    const entries = Object.values(view.collections as CollectionMap).flat()
    expect(entries.length).toBeGreaterThan(0)
    for (const e of entries) {
      // F4（2026-09-07）：collections 面补 title/domain/query_intent —— 通道 B
      // hay=name+title+domain 中文匹配依赖（F1 分词后无 hay 即零命中）；
      // content 类大字段（purpose/content/text/body）仍永不入包。
      expect(Object.keys(e).sort()).toEqual(["collection", "domain", "name", "query_intent", "title", "trust"])
      expect(e).not.toHaveProperty("content")
      expect(e).not.toHaveProperty("text")
      expect(e).not.toHaveProperty("body")
      expect(e).not.toHaveProperty("purpose")
    }
    expect(JSON.stringify(view).length).toBeLessThan(40_000)
  })
})

describe("P1-IMP-08 scripts/sync-kb-view-to-qmai.mjs 抽取逻辑", () => {
  const HUB_SOURCE = resolve(__dirname, "../../../../reference/REFERENCE-KB-VIEW.json")

  it("源缺 builtFrom → 拒绝同步（不产出无指纹消费面）", async () => {
    const { extractConsumerSurface } = await import("../../../scripts/sync-kb-view-to-qmai.mjs")
    expect(() =>
      extractConsumerSurface({
        schemaVersion: 2,
        routing: { agent: { draft: ["craft"] } },
        collections: { craft: [] },
      }),
    ).toThrow(/缺少 builtFrom/)
  })

  it("counts 与 collections.length 漂移 → 拒绝同步", async () => {
    const { extractConsumerSurface } = await import("../../../scripts/sync-kb-view-to-qmai.mjs")
    expect(() =>
      extractConsumerSurface({
        schemaVersion: 2,
        builtFrom: "sha256:x",
        routing: { agent: {} },
        collections: { craft: [{ name: "a", trust: "full" }] },
        counts: { craft: 99 },
      }),
    ).toThrow(/不一致/)
  })

  it("collectionCounts 由数组长度派生，治理桶（blocked/quarantine）计数一并保留", async () => {
    const { extractConsumerSurface } = await import("../../../scripts/sync-kb-view-to-qmai.mjs")
    const view = extractConsumerSurface({
      schemaVersion: 2,
      builtFrom: "sha256:y",
      routing: { agent: { draft: ["craft"] } },
      collections: { craft: [{ name: "a", trust: "full", content: "巨大正文" }] },
      counts: { craft: 1, blocked: 6 },
    })
    expect(view.collectionCounts).toEqual({ craft: 1, blocked: 6 })
    expect(view.collections.craft[0]).not.toHaveProperty("content")
  })

  // 源侧守恒比对：仅 hub 工作区在场时执行（QMAI 单仓 checkout 无 reference/ → 跳过）。
  const hubPresent = existsSync(HUB_SOURCE)
  describe.skipIf(!hubPresent)("hub 源视图 ↔ 仓内产物守恒", () => {
    it("产物与源 builtFrom 一致，且重新抽取结果与产物逐字节相同（--check 语义）", async () => {
      const { extractConsumerSurface, serialize } = await import("../../../scripts/sync-kb-view-to-qmai.mjs")
      const source = JSON.parse(readFileSync(HUB_SOURCE, "utf8"))
      const committed = readFileSync(resolve(__dirname, "kb/kb-routing-view.generated.json"), "utf8")
      expect(serialize(extractConsumerSurface(source))).toBe(committed)
    })

    it("P1-IMP-06 守恒：由产物构建的 trust 映射与由源视图构建者逐键一致", async () => {
      const { buildTrustGradeMap } = await import("./trust-grader")
      const source = JSON.parse(readFileSync(HUB_SOURCE, "utf8"))
      const generated = JSON.parse(
        readFileSync(resolve(__dirname, "kb/kb-routing-view.generated.json"), "utf8"),
      )
      const fromSource = buildTrustGradeMap(source as Parameters<typeof buildTrustGradeMap>[0])
      const fromGenerated = buildTrustGradeMap(generated as Parameters<typeof buildTrustGradeMap>[0])
      expect(Object.keys(fromGenerated).length).toBeGreaterThan(0)
      expect(fromGenerated).toEqual(fromSource)
    })
  })
})
