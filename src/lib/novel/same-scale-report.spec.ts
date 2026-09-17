/**
 * same-scale-report.spec — R0-a1 同尺迁移评测报告 spec。
 * 真实面：golden-34（__fixtures__/golden-queries.json）经通道 B 纯逻辑
 * （routeByQueryIntent + tokensForKbMatch + rankByBm25，与 golden-retrieval.spec.ts
 * 的 channelBRank 同构）得 rank 分档 → compareSameScale（Wilson 95% CI，下界裁决）
 * + WeKnora 快照（weknora-snapshot.1ef38fdb.json，commit 1ef38fdb）方法学对齐。
 * 常态（test:mocks）：只断言报告字段完整，零副作用。
 * 报告写盘门控：SAME_SCALE_REPORT=1 时写 docs/p0/same-scale-<YYYYMMDD>.md
 * （§5 模板四要素：输入绑定 / 口径声明 / CI 下界判定 / status.json 同步位）。
 *
 * 口径诚实声明：W 面服务不可运行，未做逐 query 跨系统对跑；"同尺"指评测方法
 * 同尺（rank 分档 + topK 命中率 + Wilson CI），非同实例对跑。
 * 同源回归口径，不可作收敛结论。
 *
 * @license MIT © QMAI
 */
import { describe, expect, it } from "vitest"
import { readFileSync, writeFileSync } from "fs"
import { resolve } from "path"
import { routeByQueryIntent, tokensForKbMatch } from "./search-adapter"
import { rankByBm25 } from "./bm25-ranking"
import kbRoutingView from "./kb/kb-routing-view.generated.json"
import weknoraSnapshot from "./__fixtures__/weknora-snapshot.1ef38fdb.json"
import {
  WEKNORA_SNAPSHOT_SCHEMA,
  compareSameScale,
  type GoldenRank,
} from "./same-scale-harness"

const GOLDEN_PATH = resolve(__dirname, "__fixtures__/golden-queries.json")
const golden = JSON.parse(readFileSync(GOLDEN_PATH, "utf8")) as {
  _meta: {
    baseline: { minHitRate: number; minHitsPerQuery: number; minTop20Rate: number; minTop3Rate: number }
    rerankTrigger: { rule: string; status: string }
  }
  queries: Array<{ query: string; intent: string; expectCollections: string[]; minHits: number }>
}

/** 与 golden-retrieval.spec.ts channelBRank 同构（路由 collections 排除 tech，hay=name+title+domain）。 */
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

const ranks: GoldenRank[] = golden.queries.map((q) => {
  const { rank, top3, top20 } = channelBRank(q.query, q.intent)
  return { query: q.query, rank: Number.isFinite(rank) ? rank : 9999, top3, top20 }
})
const snapshot = WEKNORA_SNAPSHOT_SCHEMA.parse(weknoraSnapshot)
const result = compareSameScale({
  ranks,
  snapshot,
  top3Threshold: golden._meta.baseline.minTop3Rate,
})

function buildReport(date: string): string {
  const lines = [
    `# 同尺迁移评测报告（${date}）`,
    "",
    "> 口径声明：W 面（reference/WeKnora dataset/samples）服务不可运行，未做逐 query",
    "> 跨系统对跑；\"同尺\"指评测方法同尺（rank 分档 + topK 命中率 + Wilson 95% CI），",
    "> 非同实例对跑。**同源回归口径，不可作收敛结论**（反目标 AG3 豁免标记）。",
    "> W demo 快照 qrels 全标（gold 4/4）导致 topK 恒 1.0，无判别力，仅作方法学对齐参照。",
    "",
    "## 一、输入绑定",
    "",
    `- P1 面：golden-34（\`src/lib/novel/__fixtures__/golden-queries.json\`，N=${result.p1.n}）`,
    `- kb 视图：collectionCounts=${JSON.stringify(
      (kbRoutingView as { collectionCounts?: unknown }).collectionCounts ?? {},
    )}`,
    `- W 面快照：\`src/lib/novel/__fixtures__/weknora-snapshot.${result.w.sourceCommit}.json\``,
    `  （sourceCommit=${result.w.sourceCommit}，queries=${result.w.queryCount} / corpus=${result.w.corpusSize} / gold=${result.w.goldSize}）`,
    `- 基线阈值：minTop3Rate=${result.p1.threshold}（golden _meta.baseline）`,
    "",
    "## 二、P1 臂判定（含 Wilson 95% CI 下界）",
    "",
    `- top3 点估计：${result.p1.top3Hits}/${result.p1.n} = ${result.p1.top3Rate.toFixed(4)}`,
    `- Wilson 95% CI：[${result.p1.wilsonLower.toFixed(4)}, ${result.p1.wilsonUpper.toFixed(4)}]`,
    `- 判定（看 CI 下界）：**${result.p1.verdict}**（阈值 ${result.p1.threshold}）`,
    `- 掉档 query（${result.p1.droppedQueries.length}）：`,
    ...result.p1.droppedQueries.map((q) => `  - ${q}`),
    "",
    "## 三、W 面方法学对齐",
    "",
    `- ${result.w.note}`,
    "",
    "## 四、status.json 同步位",
    "",
    "- 本报告为证据快照，未写入 `.novel/status.json`（状态真源唯一，HARD-1）。",
    "- R2-a 扇出/MMR 提名谓词消费本报告存在性（文件存在性硬检查）；非同源矩阵缺失期间强制 locked。",
    "",
  ]
  return lines.join("\n")
}

describe("R0-a1 同尺迁移评测报告", () => {
  it("P1 臂字段完整（n=34 + Wilson CI + 判定枚举 + 掉档清单一致）", () => {
    expect(result.p1.n).toBe(34)
    expect(result.p1.top3Hits).toBe(ranks.filter((r) => r.top3).length)
    expect(result.p1.wilsonLower).toBeLessThanOrEqual(result.p1.top3Rate)
    expect(result.p1.wilsonUpper).toBeGreaterThanOrEqual(result.p1.top3Rate)
    expect(["triggered", "未达裁决"]).toContain(result.p1.verdict)
    expect(result.p1.droppedQueries).toEqual(ranks.filter((r) => !r.top3).map((r) => r.query))
  })

  it("W 面快照绑定正确（commit + 规模 + 方法学声明）", () => {
    expect(result.w.sourceCommit).toBe("1ef38fdb")
    expect(result.w.corpusSize).toBe(4)
    expect(result.w.goldSize).toBe(4)
    expect(result.w.queryCount).toBe(1)
    expect(result.w.note).toContain("同源回归口径，不可作收敛结论")
  })

  it("SAME_SCALE_REPORT=1 门控写盘（§5 模板四要素；缺省零副作用）", () => {
    if (process.env.SAME_SCALE_REPORT !== "1") {
      expect(process.env.SAME_SCALE_REPORT ?? "").not.toBe("1")
      return
    }
    const date = new Date().toISOString().slice(0, 10)
    const path = resolve(__dirname, "..", "..", "..", "docs", "p0", `same-scale-${date}.md`)
    writeFileSync(path, buildReport(date), "utf8")
    expect(readFileSync(path, "utf8")).toContain("## 四、status.json 同步位")
  })
})
