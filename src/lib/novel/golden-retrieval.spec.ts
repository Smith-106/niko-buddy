import { describe, expect, it } from "vitest"
import { readFileSync, writeFileSync } from "fs"
import { resolve } from "path"
import { routeByQueryIntent, tokensForKbMatch } from "./search-adapter"
import { rankByBm25 } from "./bm25-ranking"
import kbRoutingView from "./kb/kb-routing-view.generated.json"
import { collectRerankTriggerEvidence } from "./rerank-trigger-evidence"
import { wilsonScoreInterval } from "./same-scale-harness"

/**
 * F4（2026-09-07 三模型共识）：golden queries 检索质量回归基线。
 * 直调通道 B 纯逻辑（routeByQueryIntent + tokensForKbMatch + hay 命中），
 * 断言注入命中率 ≥ 基线（数据化于 __fixtures__/golden-queries.json）。
 * F5（2026-09-07）：加 rank 分档（≤3/4-20/>20）——rerank 触发从「事后察觉」
 * 变「可测阈值」（_meta.rerankTrigger：top20 守住而 top3 掉档即产出采纳证据）。
 * 指标劣化 → 测试红；基线调整须附理由（diff 可审）。
 */

const GOLDEN_PATH = resolve(__dirname, "__fixtures__/golden-queries.json")
const golden = JSON.parse(readFileSync(GOLDEN_PATH, "utf8")) as {
  _meta: {
    baseline: { minHitRate: number; minHitsPerQuery: number; minTop20Rate: number; minTop3Rate: number }
    rerankTrigger: { rule: string; status: string }
  }
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

/**
 * F5：正确项在 BM25 排序中的 rank 分档（≤3 / 4-20 / >20 / miss）。
 * 排序源 = rankByBm25 纯函数（bm25-ranking.ts，零依赖）；正确项 = hay 命中 query token 的条目。
 * 返回最佳位置（最小 rank）与分档布尔。
 */
function channelBRank(query: string, intent: string): { rank: number; top3: boolean; top20: boolean } {
  const routed = routeByQueryIntent(intent)
  const tokens = tokensForKbMatch(query)
  const cols = (kbRoutingView as { collections?: Record<string, Array<Record<string, unknown>>> }).collections ?? {}
  const docs: Array<{ id: string; text: string }> = []
  const hitIds = new Set<string>()
  for (const collection of routed.collections) {
    if (collection === "tech") continue
    for (const entry of cols[collection] ?? []) {
      const name = String(entry["name"] ?? "")
      const title = String(entry["title"] ?? "")
      const domain = Array.isArray(entry["domain"]) ? (entry["domain"] as string[]).join(" ") : ""
      const hay = `${name} ${title} ${domain}`.toLowerCase()
      docs.push({ id: name, text: hay })
      if (tokens.some((t) => hay.includes(t))) hitIds.add(name)
    }
  }
  if (hitIds.size === 0) return { rank: Number.POSITIVE_INFINITY, top3: false, top20: false }
  const ranked = rankByBm25(query, docs)
  const best = ranked.findIndex((r) => hitIds.has(r.id)) + 1 // 1-based rank
  return { rank: best, top3: best <= 3, top20: best <= 20 }
}

describe("F4 golden queries 检索质量基线（通道 B 纯逻辑）", () => {
  const results = golden.queries.map((q) => {
    const { total, byCollection } = channelBHitCount(q.query, q.intent)
    const covered = q.expectCollections.every((c) => (byCollection[c] ?? 0) > 0)
    return { ...q, total, byCollection, covered, pass: total >= q.minHits && covered }
  })

  // F5：rank 分档（正确项在 BM25 排序中的位置）
  const ranks = golden.queries.map((q) => ({ query: q.query, ...channelBRank(q.query, q.intent) }))
  const top3Rate = ranks.filter((r) => r.top3).length / ranks.length
  const top20Rate = ranks.filter((r) => r.top20).length / ranks.length
  const top3Below = ranks.filter((r) => !r.top3).map((r) => ({ q: r.query, rank: r.rank }))

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

  it(`F5 top20 命中率 ≥ 基线 ${golden._meta.baseline.minTop20Rate}（正确项在 BM25 排序 top20 内）`, () => {
    expect(top20Rate, `top20 掉档项: ${JSON.stringify(ranks.filter((r) => !r.top20))}`).toBeGreaterThanOrEqual(
      golden._meta.baseline.minTop20Rate,
    )
  })

  it(`F5 top3 命中率 ≥ 基线 ${golden._meta.baseline.minTop3Rate}（rerank 触发哨：top20 守住而 top3 掉档即产出采纳证据）`, () => {
    expect(top3Rate, `top3 掉档项: ${JSON.stringify(top3Below)}`).toBeGreaterThanOrEqual(golden._meta.baseline.minTop3Rate)
    // R0-b：rerank 触发哨判定改为采集器（rerank-trigger-evidence.ts）单一真源；
    // 与 golden _meta.rerankTrigger.status 做漂移自检（口径漂移即测试红）。
    const evidence = collectRerankTriggerEvidence({
      ranks,
      baseline: {
        minTop3Rate: golden._meta.baseline.minTop3Rate,
        minTop20Rate: golden._meta.baseline.minTop20Rate,
      },
    })
    expect(golden._meta.rerankTrigger.status).toBe(evidence.status)
    // R0-b 产物文件（R2-a 硬依赖：文件不存在则相关谓词直接 locked）。
    // 门控写盘：RERANK_TRIGGER_EVIDENCE=1（缺省零副作用）。
    if (process.env.RERANK_TRIGGER_EVIDENCE === "1") {
      const date = new Date().toISOString().slice(0, 10)
      const ci = wilsonScoreInterval(evidence.top3Hits, evidence.n)
      const md = [
        `# rerank 触发证据（${date}）`,
        "",
        "## 输入绑定",
        "",
        "- golden 集：`src/lib/novel/__fixtures__/golden-queries.json`（N=" + String(evidence.n) + "）",
        "- 基线阈值：minTop3Rate=" + String(evidence.minTop3Rate) + " / minTop20Rate=" + String(evidence.minTop20Rate),
        "- 判据：" + evidence.rule,
        "",
        "## 判定",
        "",
        `- status：**${evidence.status}**（golden _meta.rerankTrigger.status 同步位）`,
        `- top3：${evidence.top3Hits}/${evidence.n} = ${evidence.top3Rate.toFixed(4)}；top20：${evidence.top20Hits}/${evidence.n} = ${evidence.top20Rate.toFixed(4)}`,
        `- top3 Wilson 95% CI：[${ci.lower.toFixed(4)}, ${ci.upper.toFixed(4)}]`,
        `- top3 掉档候选（${evidence.droppedQueries.length}）：` + (evidence.droppedQueries.length ? "" : "（无）"),
        ...evidence.droppedQueries.map((q) => `  - ${q}`),
        `- top20 掉档（${evidence.top20DroppedQueries.length}，非触发判据）：` + (evidence.top20DroppedQueries.length ? "" : "（无）"),
        ...evidence.top20DroppedQueries.map((q) => `  - ${q}`),
        "",
        "## status.json 同步位",
        "",
        "- 本文件为证据快照，未写入 `.novel/status.json`（状态真源唯一，HARD-1）；开关默认值不变。",
        "- R2-a 提名谓词消费本文件存在性；R0-b 不开启 rerank 默认开关。",
        "",
      ].join("\n")
      writeFileSync(resolve(__dirname, "..", "..", "..", "docs", "p0", `rerank-trigger-evidence-${date}.md`), md, "utf8")
    }
  })
})
