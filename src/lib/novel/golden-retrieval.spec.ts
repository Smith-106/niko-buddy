import { describe, expect, it } from "vitest"
import { readFileSync } from "fs"
import { resolve } from "path"
import { routeByQueryIntent, tokensForKbMatch } from "./search-adapter"
import kbRoutingView from "./kb/kb-routing-view.generated.json"

/**
 * F4（2026-09-07 三模型共识）：golden queries 检索质量回归基线。
 * 直调通道 B 纯逻辑（routeByQueryIntent + tokensForKbMatch + hay 命中），
 * 断言注入命中率 ≥ 基线（数据化于 __fixtures__/golden-queries.json）。
 * 指标劣化 → 测试红；基线调整须附理由（diff 可审）。
 */

const GOLDEN_PATH = resolve(__dirname, "__fixtures__/golden-queries.json")
const golden = JSON.parse(readFileSync(GOLDEN_PATH, "utf8")) as {
  _meta: { baseline: { minHitRate: number; minHitsPerQuery: number } }
  queries: Array<{
    query: string
    intent: string
    expectCollections: string[]
    minHits: number
  }>
}

function channelBHitCount(query: string, intent: string): { total: number; byCollection: Record<string, number> } {
  const routed = routeByQueryIntent(intent)
  const tokens = tokensForKbMatch(query)
  const byCollection: Record<string, number> = {}
  let total = 0
  const cols = (kbRoutingView as { collections?: Record<string, Array<Record<string, unknown>>> }).collections ?? {}
  for (const collection of routed.collections) {
    if (collection === "tech") continue
    const entries = cols[collection] ?? []
    let hits = 0
    for (const entry of entries) {
      const name = String(entry["name"] ?? "")
      const title = String(entry["title"] ?? "")
      const domain = Array.isArray(entry["domain"]) ? (entry["domain"] as string[]).join(" ") : ""
      const hay = `${name} ${title} ${domain}`.toLowerCase()
      if (tokens.some((t) => hay.includes(t))) hits++
    }
    byCollection[collection] = hits
    total += hits
  }
  return { total, byCollection }
}

describe("F4 golden queries 检索质量基线（通道 B 纯逻辑）", () => {
  const results = golden.queries.map((q) => {
    const { total, byCollection } = channelBHitCount(q.query, q.intent)
    const covered = q.expectCollections.every((c) => (byCollection[c] ?? 0) > 0)
    return { ...q, total, byCollection, covered, pass: total >= q.minHits && covered }
  })

  it(`命中率 ≥ 基线 ${golden._meta.baseline.minHitRate}（${golden.queries.length} 条 golden queries）`, () => {
    const hitRate = results.filter((r) => r.pass).length / results.length
    const failed = results.filter((r) => !r.pass)
    expect(hitRate, `失败项: ${JSON.stringify(failed.map((f) => ({ q: f.query, total: f.total, by: f.byCollection })))}`).toBeGreaterThanOrEqual(
      golden._meta.baseline.minHitRate,
    )
  })

  it("中文复合 query 命中 lexicon/world_ref（F1 分词 + F3 补料协同）", () => {
    const zh = results.filter((r) => /[\u4e00-\u9fff]/.test(r.query) && r.expectCollections.some((c) => c === "lexicon" || c === "world_ref"))
    expect(zh.length).toBeGreaterThanOrEqual(20)
    const zhPass = zh.filter((r) => r.pass).length / zh.length
    expect(zhPass).toBeGreaterThanOrEqual(0.9)
  })

  it("英文/ASCII query 不回归（craft/corpus 命中保持）", () => {
    const en = results.filter((r) => !/[\u4e00-\u9fff]/.test(r.query))
    expect(en.length).toBeGreaterThanOrEqual(2)
    for (const r of en) {
      expect(r.pass, `${r.query} 命中 ${r.total}（期望 ≥${r.minHits}）`).toBe(true)
    }
  })

  it("5 intent 全覆盖（plan/draft/revise/lookup/style 各有 golden query）", () => {
    const intents = new Set(results.map((r) => r.intent))
    expect([...intents].sort()).toEqual(["draft", "lookup", "plan", "revise", "style"])
  })
})
