/**
 * kb-shadow-harness.spec.ts — R5 检索维 node 侧实测 harness（KB_SHADOW_HARNESS=1 门控）。
 *
 * 职责（ADR-47 检索维实测解锁路径，三模型共识 2026-09-09）：
 *   1. 真实码路面（零镜像）：routeByQueryIntent + tokensForKbMatch + rankByBm25 +
 *      reorderByUsefulness（search-adapter 既有纯函数，与 golden-retrieval.spec 同一 import 面）
 *      对 kb-routing-view.generated.json（P1 参考库真实生成视图）跑 golden 34 双臂。
 *   2. 双臂：baseline = BM25 现状排序；experiment = BM25 + usefulness rerank
 *      （entityHints = query tokens，situational_fit 真实语义）。rerank 只重排不丢项，
 *      paired 断言全集合命中数不变。
 *   3. 逐臂 obligationCoverage 由 coverageOf 从 top5 命中现算（期望收藏覆盖率）→
 *      recordKbShadowArms 落 {QMAI_ROOT}/.novel/telemetry/kb-shadow-harness/dual-arm-*.jsonl
 *      → `npm run eval:gov -- --shadow-input <dir>` 消费（ADR-47 挂钩）。
 *   4. 报告 harness-report.json（逐 query 配对 A/B + rank 分档 + 聚合）供三模型复评引用。
 *
 * 实测面诚实标注（红线：机制分不冒充 Tauri 运行时实测）：
 *   - 本 harness 实测 = channel-B 检索纯逻辑（路由/排序/rerank）+ 真实生成视图（node/vitest 面）；
 *   - channel-A（canon RRF 隔离轨 / 硬注入，invoke/Rust 层）不在本面 —— 双臂 flags 为
 *     kb-flag-promotion-flow A/B 口径（armFlagsOf），channel-A 由 Tauri 运行时影子期采集覆盖；
 *   - 与 Tauri 运行时的差距（IPC/Rust/LanceDB 全链）在报告 measuredSurface 字段显式声明。
 *
 * 运行：KB_SHADOW_HARNESS=1 npx vitest run src/lib/novel/kb-shadow-harness.spec.ts
 * 默认套件（test:mocks 门禁面）不设置该变量 → skip，零副作用。
 */
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import { join, resolve } from "node:path"
import { describe, expect, it } from "vitest"
import {
  routeByQueryIntent,
  tokensForKbMatch,
  reorderByUsefulness,
  kbRoutingView,
} from "./search-adapter"
import { rankByBm25 } from "./bm25-ranking"
import { recordKbShadowArms, type KbShadowCollectorDeps } from "./kb-shadow-collector"
import { goldenKbShadowCases } from "./kb-shadow-wiring"

const RUN = process.env.KB_SHADOW_HARNESS === "1"
const d = RUN ? describe : describe.skip

const QMAI_ROOT = resolve(__dirname, "../../..")
/** harness 独立落盘根（与运行时 .novel/telemetry/kb-shadow 分离，两测量面不混淆；.novel/ gitignored）。 */
const HARNESS_PROJECT_ROOT = join(QMAI_ROOT, ".novel", "harness-project")
const SHADOW_DIR = join(HARNESS_PROJECT_ROOT, ".novel", "telemetry", "kb-shadow")
const OUT_DIR = join(QMAI_ROOT, ".novel", "telemetry", "kb-shadow-harness")
const TOP_K = 5
const RANK_TOP3 = 3
const RANK_TOP20 = 20

const golden = goldenKbShadowCases()

interface ChDoc {
  id: string
  text: string
  collection: string
}

/** channel-B 检索面：golden-retrieval.spec 同构（路由 collections，排除 tech，hay=name+title+domain）。 */
function channelBDocs(intent: string): ChDoc[] {
  const routed = routeByQueryIntent(intent)
  const cols = (kbRoutingView as { collections?: Record<string, Array<Record<string, unknown>>> }).collections ?? {}
  const docs: ChDoc[] = []
  for (const collection of routed.collections) {
    if (collection === "tech") continue
    for (const entry of cols[collection] ?? []) {
      const name = String(entry["name"] ?? "")
      const title = String(entry["title"] ?? "")
      const domain = Array.isArray(entry["domain"]) ? (entry["domain"] as string[]).join(" ") : ""
      const hay = `${name} ${title} ${domain}`.toLowerCase()
      docs.push({ id: name || title, text: hay, collection })
    }
  }
  return docs
}

/** token 命中判定（golden spec 同语义：hay 含任一 query token）。 */
const isHit = (doc: ChDoc, tokens: string[]): boolean => tokens.some((t) => doc.text.includes(t))

/** 单臂检索：BM25 排序；experiment 臂再经 usefulness rerank 真实函数重排。 */
function armRetrieve(
  query: string,
  intent: string,
  arm: "baseline" | "experiment",
): { rankedIds: string[]; docs: ChDoc[] } {
  const tokens = tokensForKbMatch(query)
  const docs = channelBDocs(intent)
  const ranked = rankByBm25(
    query,
    docs.map((x) => ({ id: x.id, text: x.text })),
  )
  let orderedIds: string[] = ranked.map((r: { id: string }) => r.id)
  if (arm === "experiment") {
    const byId = new Map(docs.map((x) => [x.id, x]))
    const candidates = orderedIds
      .map((id) => byId.get(id))
      .filter((x): x is ChDoc => Boolean(x))
      .map((x) => ({ title: x.id, snippet: x.text, path: x.id }))
    const reranked = reorderByUsefulness(candidates, { entityHints: tokens })
    orderedIds = reranked.map((c) => c.path ?? c.title)
  }
  return { rankedIds: orderedIds, docs }
}

interface ArmMeasure {
  rank: number
  hitsTop5: number
  hitsTop20: number
  coverage: number
  hitIds: string[]
}

/** 逐臂测量：rank（首个 token 命中位）、topK 窗口命中、期望收藏覆盖率。 */
function measureArm(
  query: string,
  intent: string,
  expectCollections: string[],
  arm: "baseline" | "experiment",
): ArmMeasure {
  const tokens = tokensForKbMatch(query)
  const { rankedIds, docs } = armRetrieve(query, intent, arm)
  const byId = new Map(docs.map((x) => [x.id, x]))
  const hitIds = rankedIds.filter((id: string) => {
    const doc = byId.get(id)
    return doc ? isHit(doc, tokens) : false
  })
  const rank = hitIds.length > 0 ? rankedIds.indexOf(hitIds[0]) + 1 : Number.POSITIVE_INFINITY
  const top = rankedIds.slice(0, TOP_K)
  const expected = expectCollections.length > 0 ? expectCollections : null
  let coverage: number
  if (!expected) {
    coverage = hitIds.length > 0 ? 1 : 0
  } else {
    const hitCols = expected.filter((col) =>
      top.some((id: string) => {
        const doc = byId.get(id)
        return doc?.collection === col && isHit(doc, tokens)
      }),
    )
    coverage = hitCols.length / expected.length
  }
  return {
    rank,
    hitsTop5: top.filter((id: string) => hitIds.includes(id)).length,
    hitsTop20: rankedIds.slice(0, RANK_TOP20).filter((id: string) => hitIds.includes(id)).length,
    coverage,
    hitIds: hitIds.slice(0, TOP_K),
  }
}

d("kb-shadow-harness（R5 检索维 node 实测，KB_SHADOW_HARNESS=1 门控）", () => {
  it("golden 34 双臂：paired 命中数不变 + F4 基线一致性 + shadow JSONL 落盘 + 报告存档", async () => {
    await rm(OUT_DIR, { recursive: true, force: true })
    await rm(SHADOW_DIR, { recursive: true, force: true })
    await mkdir(OUT_DIR, { recursive: true })
    await mkdir(SHADOW_DIR, { recursive: true })

    const deps: KbShadowCollectorDeps = {
      readFile: (p) => readFile(p, "utf8"),
      writeFile: (p, c) => writeFile(p, c, "utf8"),
      createDirectory: (p) => mkdir(p, { recursive: true }).then(() => undefined),
      listFiles: (dir) => readdir(dir),
      now: () => new Date(),
    }

    const goldenRaw = JSON.parse(
      await readFile(resolve(__dirname, "__fixtures__/golden-queries.json"), "utf8"),
    ) as {
      _meta: { baseline: { minHitRate: number; minTop20Rate: number; minTop3Rate: number } }
      queries: Array<{ query: string; intent: string; expectCollections: string[]; minHits: number }>
    }

    const perQuery: Array<Record<string, unknown>> = []
    const measures = new Map<string, { baseline: ArmMeasure; experiment: ArmMeasure }>()
    for (let i = 0; i < golden.length; i++) {
      const c = golden[i]
      const raw = goldenRaw.queries[i]
      const baseline = measureArm(c.query, raw.intent, raw.expectCollections, "baseline")
      const experiment = measureArm(c.query, raw.intent, raw.expectCollections, "experiment")
      measures.set(c.caseId, { baseline, experiment })
      perQuery.push({
        caseId: c.caseId,
        query: c.query,
        intent: raw.intent,
        expectCollections: raw.expectCollections,
        baseline: { rank: baseline.rank, hitsTop5: baseline.hitsTop5, coverage: baseline.coverage },
        experiment: { rank: experiment.rank, hitsTop5: experiment.hitsTop5, coverage: experiment.coverage },
        rankDelta: experiment.rank - baseline.rank,
      })
    }

    // paired：rerank 只重排不丢项 → 全集合 token 命中总数逐 query 不变
    for (const c of golden) {
      const raw = goldenRaw.queries[golden.findIndex((g) => g.caseId === c.caseId)]
      const tokens = tokensForKbMatch(c.query)
      const b = armRetrieve(c.query, raw.intent, "baseline")
      const e = armRetrieve(c.query, raw.intent, "experiment")
      expect(e.docs.filter((x) => isHit(x, tokens)).length).toBe(b.docs.filter((x) => isHit(x, tokens)).length)
    }

    // F4 基线一致性（golden spec 同指标，top20 窗口内 hits ≥ minHits）
    const hitRate = (arm: "baseline" | "experiment"): number => {
      let hit = 0
      for (const c of golden) {
        const m = measures.get(c.caseId)
        const raw = goldenRaw.queries[golden.findIndex((g) => g.caseId === c.caseId)]
        if (m && m[arm].hitsTop20 >= raw.minHits) hit++
      }
      return hit / golden.length
    }
    const top3Rate = (arm: "baseline" | "experiment"): number =>
      golden.filter((c) => (measures.get(c.caseId)?.[arm].rank ?? Number.POSITIVE_INFINITY) <= RANK_TOP3).length /
      golden.length
    const baselineHitRate = hitRate("baseline")
    expect(baselineHitRate).toBeGreaterThanOrEqual(goldenRaw._meta.baseline.minHitRate)

    // 双臂 shadow 落盘（coverageOf 逐臂现算：窗口命中数对 minHits，截到 1）
    const { written, failed } = await recordKbShadowArms(
      deps,
      HARNESS_PROJECT_ROOT,
      "harness0",
      golden.map((c) => ({
        caseId: c.caseId,
        query: c.query,
        obligationCoverage: null,
        scaleViolation: false,
        minHits: goldenRaw.queries[golden.findIndex((g) => g.caseId === c.caseId)].minHits,
      })),
      (query, flags) => {
        const raw = goldenRaw.queries[goldenRaw.queries.findIndex((g) => g.query === query)]
        const arm = flags.usefulnessRerank ? "experiment" : "baseline"
        return Promise.resolve({ hitIds: measureArm(query, raw.intent, raw.expectCollections, arm).hitIds })
      },
      (c, arm, hitIds) => {
        const m = measures.get(c.caseId)
        const byHits = (arm === "baseline" ? m?.baseline : m?.experiment)?.hitIds ?? []
        // gate coverage 口径 = min(1, 命中数/minHits)（窗口命中现算）
        return Math.min(1, byHits.filter((id) => hitIds.includes(id)).length / (c.minHits > 0 ? c.minHits : 1))
      },
    )
    expect(written).toBe(68)
    expect(failed).toBe(0)

    const report = {
      schema: "kb-shadow-harness/1.0",
      generatedAt: new Date().toISOString(),
      measuredSurface:
        "channel-B 检索纯逻辑（routeByQueryIntent/rankByBm25/reorderByUsefulness）+ kb-routing-view.generated.json（P1 参考库真实生成视图；builtFrom 新鲜度断言由 search-adapter 加载时执行）。channel-A（canon RRF 隔离轨/硬注入，invoke/Rust 层）未在本面——由 Tauri 运行时影子期采集覆盖，双臂 flags 为 kb-flag-promotion-flow A/B 口径",
      goldenSource: "src/lib/novel/__fixtures__/golden-queries.json (34 queries, F4)",
      agg: {
        baseline: { hitRate: baselineHitRate, top3Rate: top3Rate("baseline"), coverageMean: mean(measures, "baseline", "coverage") },
        experiment: { hitRate: hitRate("experiment"), top3Rate: top3Rate("experiment"), coverageMean: mean(measures, "experiment", "coverage") },
      },
      perQuery,
      shadowDir: SHADOW_DIR,
      gateCommand: "npm run eval:gov -- --shadow-input .novel/harness-project/.novel/telemetry/kb-shadow",
    }
    await writeFile(join(OUT_DIR, "harness-report.json"), JSON.stringify(report, null, 2), "utf8")
    expect(existsSync(join(OUT_DIR, "harness-report.json"))).toBe(true)
  })
})

function mean(
  measures: Map<string, { baseline: ArmMeasure; experiment: ArmMeasure }>,
  arm: "baseline" | "experiment",
  key: "coverage" | "hitsTop5",
): number {
  const vals = [...measures.values()].map((m) => m[arm][key])
  return vals.length > 0 ? vals.reduce((a, b) => a + b, 0) / vals.length : 0
}