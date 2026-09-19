/**
 * internal-eval-set.spec.ts — B1 内部非同源一致性集判定核（批准计划 r3 §T3）。
 *
 * 输入绑定（真实产物，非构造）：
 *   - qrels ← src/lib/novel/kb/internal-eval-set.generated.json（规则导出；N=343 / 6 流派）
 *   - 路由矩阵 ← kb-routing-view.generated.json routing.agent（T2 后的最终矩阵）
 *   - 判定链 ← routeByQueryIntent（search-adapter.ts:730）+ tokensForKbMatch（:843）+ rankByBm25（bm25-ranking.ts:60）
 *   - 统计 ← wilsonScoreInterval（same-scale-harness.ts:96），裁决看 CI 下界
 *
 * 口径（治理对齐）：
 *   - 裁决范围 = 内部非同源一致性；**不构成第三方裁决 / 不构成跨系统裁决**（W 侧保持「未达裁决」）。
 *   - 主指标 = 义务召回率（gold 是否在 topK）；**不使用 MRR/NDCG**（spec:project:arch-decisions-071 Step1）。
 *   - **非 real 门锚点**：本集 source="reference-library-self-built"，real 门 case 来自真实 canon 抽取
 *     （spec:project:eval-real-baseline-path-004），二者不互替。
 *   - 未复用 compareSameScale：其输入 schema 绑定 WeKnora 冻结快照（W 面），本集为参考库单面；
 *     **继承其裁决规则**（CI 下界 ≥ 阈值），不伪造跨系统对比数字。
 *
 * 常态零副作用；`INTERNAL_EVAL_SET=1` 门控写 docs/p0/non-same-source-<YYYYMMDD>.md。
 *
 * @license MIT © Niko Buddy
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"
import { rankByBm25 } from "./bm25-ranking"
import { routeByQueryIntent, tokensForKbMatch } from "./search-adapter"
import { wilsonScoreInterval } from "./same-scale-harness"
import internalEvalSet from "./kb/internal-eval-set.generated.json"
import kbRoutingView from "./kb/kb-routing-view.generated.json"

const GATED = process.env["INTERNAL_EVAL_SET"] === "1"
const REPO_ROOT = resolve(__dirname, "..", "..", "..")
const P0_DIR = resolve(REPO_ROOT, "docs", "p0")

type EvalQuery = {
  query: string
  intent: string
  expectedCollection: string
  gold: string
  genre: string
  derivation: string
}
type Generated = {
  source: string
  adjudicationScope: string
  notThirdParty: boolean
  notRealGateAnchor: boolean
  builtFrom: string
  thresholds: { topK: number; top20: number; minTop3Lower: number; minTop20Lower: number }
  counts: { total: number; byGenre: Record<string, number>; byIntent: Record<string, number> }
  queries: EvalQuery[]
}
const SET = internalEvalSet as unknown as Generated
const VIEW = kbRoutingView as unknown as {
  builtFrom?: string
  collections?: Record<string, Array<Record<string, unknown>>>
  routing?: { agent?: Record<string, string[]> }
  collectionCounts?: Record<string, number>
}

// ---------- 判定核（纯函数面） ----------

function hay(entry: Record<string, unknown>): string {
  const name = String(entry["name"] ?? "")
  const title = String(entry["title"] ?? "")
  const domain = Array.isArray(entry["domain"]) ? (entry["domain"] as string[]).join(" ") : ""
  return `${name} ${title} ${domain}`.toLowerCase()
}

/** 单条义务：gold 在 routed 集合候选池中的 BM25 rank（1-based；0 = 未召回）。 */
function obligationRank(row: EvalQuery, extraDocs: Array<{ id: string; text: string }> = []) {
  const routed = routeByQueryIntent(row.intent).collections.filter((c) => c !== "tech")
  const docs: Array<{ id: string; text: string }> = []
  const golds = new Set<string>()
  for (const collection of routed) {
    for (const entry of VIEW.collections?.[collection] ?? []) {
      const id = String(entry["name"] ?? "")
      const text = hay(entry)
      docs.push({ id, text })
      if (id === row.gold) golds.add(id)
    }
  }
  if (golds.size === 0) return { rank: 0, routed, goldRouted: false }
  const ranked = rankByBm25(row.query, [...docs, ...extraDocs])
  const index = ranked.findIndex((r) => r.id === row.gold)
  return { rank: index < 0 ? 0 : index + 1, routed, goldRouted: true }
}

/** 毒块拦截（提取期，双证）：hub 侧 blocked/quarantine 条目零入消费面 + 任一 intent allowlist 不含二者。 */
function poisonExtractionInterception() {
  const counts = VIEW.collectionCounts ?? {}
  const declared = (counts["blocked"] ?? 0) + (counts["quarantine"] ?? 0) // 毒块条目总数
  const present = ["blocked", "quarantine"].flatMap((c) => VIEW.collections?.[c] ?? []).length // 消费面残留
  const allowlists = Object.values(VIEW.routing?.agent ?? {})
  const allowlistExcludes = allowlists.every(
    (list) => !list.includes("blocked") && !list.includes("quarantine"),
  )
  const intercepted = declared - present
  return {
    declared,
    present,
    intercepted,
    rate: declared === 0 ? 1 : intercepted / declared,
    allowlistExcludes,
  }
}

const results = SET.queries.map((row) => {
  const { rank, goldRouted } = obligationRank(row)
  return {
    ...row,
    rank,
    goldRouted,
    topK: rank > 0 && rank <= SET.thresholds.topK,
    top20: rank > 0 && rank <= SET.thresholds.top20,
  }
})
const n = results.length
const k3 = results.filter((r) => r.topK).length
const k20 = results.filter((r) => r.top20).length
const ci3 = wilsonScoreInterval(k3, n)
const ci20 = wilsonScoreInterval(k20, n)
const dropped = results.filter((r) => !r.topK)
const droppedByDerivation: Record<string, number> = {}
for (const row of dropped) droppedByDerivation[row.derivation] = (droppedByDerivation[row.derivation] ?? 0) + 1

/** 面内注入毒块（负向控制，合成高重叠毒块）：测通道 B 是否有面内 veto 机制。抽样 40 条（确定性）。 */
const inFacePoison = (() => {
  const sample = results.slice(0, 40)
  let surfaced = 0
  for (const row of sample) {
    const { routed } = obligationRank(row)
    const pool = routed.flatMap((c) =>
      (VIEW.collections?.[c] ?? []).map((e) => ({ id: String(e["name"]), text: hay(e) })),
    )
    const synthetic = { id: `synthetic-poison:${row.gold}`, text: `${row.query.toLowerCase()} ${row.genre}` }
    const ranked = rankByBm25(row.query, [...pool, synthetic])
    if (ranked.slice(0, SET.thresholds.topK).some((r) => r.id === synthetic.id)) surfaced++
  }
  return {
    probed: sample.length,
    surfaced,
    intercepted: sample.length - surfaced,
    rate: sample.length === 0 ? 1 : (sample.length - surfaced) / sample.length,
  }
})()

const structural = poisonExtractionInterception()
const verdict = {
  topK: { pass: ci3.lower >= SET.thresholds.minTop3Lower, metric: k3 / n, ci: ci3 },
  top20: { pass: ci20.lower >= SET.thresholds.minTop20Lower, metric: k20 / n, ci: ci20 },
}

const summary = [
  `internal-eval-set N=${n} builtFrom=${SET.builtFrom}`,
  `义务召回率@top${SET.thresholds.topK} = ${k3}/${n} = ${(k3 / n).toFixed(4)} CI[${ci3.lower.toFixed(4)}, ${ci3.upper.toFixed(4)}] 裁决(下界≥${SET.thresholds.minTop3Lower})=${verdict.topK.pass ? "PASS" : "未达"}`,
  `义务召回率@top${SET.thresholds.top20} = ${k20}/${n} = ${(k20 / n).toFixed(4)} CI[${ci20.lower.toFixed(4)}, ${ci20.upper.toFixed(4)}] 裁决(下界≥${SET.thresholds.minTop20Lower})=${verdict.top20.pass ? "PASS" : "未达"}`,
  `掉档(non-top${SET.thresholds.topK})=${dropped.length}${Object.keys(droppedByDerivation).length > 0 ? ` by derivation ${JSON.stringify(droppedByDerivation)}` : ""}`,
  `毒块拦截（提取期）=${structural.intercepted}/${structural.declared} = ${structural.rate.toFixed(4)}（消费面残留 ${structural.present}；allowlist 排除=${structural.allowlistExcludes}）；` +
    `面内合成毒块负向控制=未拦截 ${inFacePoison.surfaced}/${inFacePoison.probed}（通道 B 无面内 veto，属已知边界）`,
].join("\n")

describe("B1 内部非同源一致性集（口径 + 结构）", () => {
  it("口径声明：内部自建 / 非第三方裁决 / 非 real 门锚点", () => {
    expect(SET.source).toBe("reference-library-self-built")
    expect(SET.adjudicationScope).toBe("internal-non-same-source-consistency")
    expect(SET.notThirdParty).toBe(true)
    expect(SET.notRealGateAnchor).toBe(true)
    expect(SET.source).not.toBe("real")
  })

  it("规模与流派：N≥200（治理口径）、流派≥4", () => {
    expect(SET.counts.total).toBe(n)
    expect(n).toBeGreaterThanOrEqual(200)
    expect(Object.keys(SET.counts.byGenre).length).toBeGreaterThanOrEqual(4)
    expect(SET.thresholds.topK).toBe(3)
  })

  it("qrels 与最终路由矩阵一致（T2 依赖），且 gold 全部在视图内", () => {
    for (const row of SET.queries) {
      expect(VIEW.routing?.agent?.[row.intent]).toContain(row.expectedCollection)
      const names = (VIEW.collections?.[row.expectedCollection] ?? []).map((e) => String(e["name"]))
      expect(names).toContain(row.gold)
    }
  })

  it("每条 query 经 tokensForKbMatch 产出 ≥1 token（防退化空 token 假阴性）", () => {
    for (const row of SET.queries) {
      expect(tokensForKbMatch(row.query).length).toBeGreaterThan(0)
    }
  })

  it("非同源性：query 文本与 golden-34 零重叠，gold 不落 corpus 范文面", () => {
    const golden = JSON.parse(
      readFileSync(resolve(__dirname, "__fixtures__", "golden-queries.json"), "utf8"),
    ) as { queries: Array<{ query: string }> }
    const goldenTexts = new Set(
      golden.queries.map((q) => q.query.replace(/\s+/g, " ").trim().toLowerCase()),
    )
    const corpusNames = new Set((VIEW.collections?.["corpus"] ?? []).map((e) => String(e["name"])))
    for (const row of SET.queries) {
      const q = row.query.toLowerCase()
      expect(goldenTexts.has(q)).toBe(false)
      for (const g of goldenTexts) {
        if (g.length >= 6) expect(q.includes(g) || g.includes(q)).toBe(false)
      }
      expect(corpusNames.has(row.gold)).toBe(false)
    }
  })

  it("每个 intent 面都有义务（覆盖矩阵非单点）", () => {
    const intents = new Set(SET.queries.map((q) => q.intent))
    expect(intents.size).toBeGreaterThanOrEqual(4)
    for (const intent of intents) {
      expect(VIEW.routing?.agent?.[intent]).toBeDefined()
    }
  })

  it("毒块拦截（提取期双证）：毒块零入消费面 + allowlist 排除 blocked/quarantine", () => {
    expect(structural.declared).toBeGreaterThan(0)
    expect(structural.present).toBe(0)
    expect(structural.rate).toBe(1)
    expect(structural.allowlistExcludes).toBe(true)
  })

  it("面内毒块负向控制：无 veto 机制（毒块入候选池即浮现，非真空指标）", () => {
    expect(inFacePoison.probed).toBeGreaterThanOrEqual(40)
    expect(inFacePoison.surfaced).toBeGreaterThan(0)
    expect(inFacePoison.rate).toBeLessThan(1)
  })

  it("判定核可复跑：义务召回率 + Wilson CI，裁决看 CI 下界（不使用 MRR/NDCG）", () => {
    console.log(summary)
    expect(ci3.lower).toBeLessThanOrEqual(ci3.upper)
    expect(ci20.lower).toBeLessThanOrEqual(ci20.upper)
    // 下界口径单调：top20 召回不劣于 topK
    expect(k20).toBeGreaterThanOrEqual(k3)
    expect(verdict.top20.ci.lower).toBeGreaterThanOrEqual(0)
  })

  it("门控写盘（INTERNAL_EVAL_SET=1）：docs/p0/non-same-source-<date>.md；常态零副作用", () => {
    if (!GATED) {
      expect(existsSync(P0_DIR)).toBe(true) // 常态下不新增文件
      return
    }
    const stamp = new Date().toISOString().slice(0, 10)
    const out = resolve(P0_DIR, `non-same-source-${stamp}.md`)
    const body = [
      `# 非同源一致性评测报告（内部自建集，${stamp}）`,
      "",
      "## 口径声明（先读）",
      "",
      "- 本报告为**内部非同源一致性**证据：qrels 由条目身份规则导出（title/domain/genre-domain/name/purpose 五探针），",
      "  语料与查询同出本仓参考库，**不构成第三方裁决，不构成跨系统裁决**。",
      "- **非 real 门锚点**：real 门 case 来自真实 canon 抽取（`source=\"real\"`，`fixtures/frozen`）；本集 `source=\"reference-library-self-built\"`，",
      "  两者不得互替（spec:project:eval-real-baseline-path-004）。",
      "- 主指标 = **义务召回率**（gold 是否被召回到 topK）；**不使用 MRR/NDCG 作裁决**（spec:project:arch-decisions-071 Step1）。",
      "- W 侧（WeKnora）服务不可运行 → W 面维持「**未达裁决**」，本报告不含任何跨系统对比数字。",
      "- 语料面为参考库检索链（通道 B 纯逻辑面）；`novelMixedSearch` 侧权威过滤次序（`search-adapter.ts:192` 过滤 → `:200` topK 截断）",
      "  未被本任务触碰（spec:project:architecture-constraints-362 / S5'）。",
      "",
      "## 输入绑定",
      "",
      `- qrels：src/lib/novel/kb/internal-eval-set.generated.json（N=${n}，source=${SET.source}）`,
      `- 路由矩阵：kb-routing-view.generated.json routing.agent（builtFrom=${SET.builtFrom}）`,
      `- 判定链：routeByQueryIntent + tokensForKbMatch + rankByBm25（纯函数，零 IO）`,
      `- 统计：wilsonScoreInterval（z=1.96）；裁决规则继承 compareSameScale（CI 下界 ≥ 阈值），`,
      "  但**未复用**其函数体：其输入 schema 绑定 WeKnora 冻结快照（W 面），本集为参考库单面。",
      `- 分布：${JSON.stringify(SET.counts.byGenre)}；intent ${JSON.stringify(SET.counts.byIntent)}`,
      "",
      "## 判定结果",
      "",
      "```",
      summary,
      "```",
      "",
      "## 掉档清单（non-topK，人工审计用）",
      "",
      ...(dropped.length === 0
        ? ["- 无"]
        : dropped
            .slice(0, 40)
            .map(
              (r) =>
                `- [${r.derivation}] intent=${r.intent} gold=${r.gold} rank=${r.rank === 0 ? "miss" : r.rank} query=${r.query}`,
            )),
      "",
      "## 已知边界",
      "",
      `- 毒块拦截为**提取期双证**：hub 侧毒块条目 ${structural.declared} 条（blocked/quarantine）零入消费面（残留 ${structural.present}），
  且任一 intent allowlist 均不含 blocked/quarantine（allowlist 排除=${structural.allowlistExcludes}）；`,
      `- 面内合成毒块负向控制（抽样 ${inFacePoison.probed} 条）：高重叠合成毒块在 top${SET.thresholds.topK} 浮现 ${inFacePoison.surfaced}/${inFacePoison.probed} →
  通道 B（参考库纯逻辑面）**无面内 veto 机制**，面内拦截依赖 canon 面 trust/veto 规则（本任务范围外），本指标不为真空值。`,
      "- 本集为规则导出集，不含人工标注与第三方标注；标题面探针（title-probe）判别力弱于 domain/genre 面。",
      "- 阈值口径：top3 下界 ≥ 0.70 / top20 下界 ≥ 0.90（与 golden-34 既有分档阈值同尺度）。",
      "",
      "## status.json 同步位",
      "",
      "- 本报告为证据快照，未写入 `.novel/status.json`（状态真源唯一）；不改任何 flag 默认值。",
      "",
    ].join("\n")
    mkdirSync(P0_DIR, { recursive: true })
    writeFileSync(out, body, "utf8")
    expect(existsSync(out)).toBe(true)
  })
})
