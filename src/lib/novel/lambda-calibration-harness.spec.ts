/**
 * lambda-calibration-harness.spec.ts — B2 λ 标定双臂测量 harness（批准计划 r3 §T4）。
 *
 * 目标：为 λ（ms_per_pp）产出**可复跑证据**，不翻位（calibrated 恒 false）。
 *
 * 双臂（配对点取自 T3 内部非同源集 N=336）：
 *   - baseline   = BM25 排序（现状）
 *   - experiment = BM25 + `reorderByUsefulness`（MMR/有用性重排真实函数，entityHints=query tokens）
 *   配对量：Δpp = (experiment top3 义务命中 − baseline top3 义务命中) × 100；Δms = experiment 臂
 *    **重排步骤**实测耗时（ms，性能增量的真实来源；`performance.now()` 仅在测量路径，纯函数层无时钟）。
 *
 * 统计：fitLambda 最小二乘（slope = λ 估计）+ R² + 门限判定。
 * 写盘：`LAMBDA_CALIBRATION=1` 门控 → docs/p0/lambda-calibration-<YYYYMMDD>.md（`new Date()` 仅用于文件名/表头）。
 *
 * 硬边界：不回写 λ 默认值、不翻 calibrated、不改 R2 阈值（1000/1e4/30/0pp）。
 *
 * @license MIT © QMAI
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"
import { rankByBm25 } from "./bm25-ranking"
import { reorderByUsefulness, routeByQueryIntent, tokensForKbMatch } from "./search-adapter"
import { RETRIEVAL_LAMBDA_INITIAL, LAMBDA_MS_PER_PP_INITIAL } from "./retrieval-budget"
import {
  LAMBDA_MIN_POINTS,
  LAMBDA_MIN_SIGNAL_RATIO,
  LAMBDA_R2_MIN,
  fitLambda,
  formatLambdaFit,
  type LambdaMeasurement,
} from "./lambda-calibration"
import internalEvalSet from "./kb/internal-eval-set.generated.json"
import kbRoutingView from "./kb/kb-routing-view.generated.json"

const GATED = process.env["LAMBDA_CALIBRATION"] === "1"
const REPO_ROOT = resolve(__dirname, "..", "..", "..")
const P0_DIR = resolve(REPO_ROOT, "docs", "p0")
const TOP_K = 3

type EvalQuery = { query: string; intent: string; gold: string; genre: string; derivation: string }
const SET = internalEvalSet as unknown as {
  builtFrom: string
  queries: EvalQuery[]
}
const VIEW = kbRoutingView as unknown as {
  collections?: Record<string, Array<Record<string, unknown>>>
}

function hay(entry: Record<string, unknown>): string {
  const name = String(entry["name"] ?? "")
  const title = String(entry["title"] ?? "")
  const domain = Array.isArray(entry["domain"]) ? (entry["domain"] as string[]).join(" ") : ""
  return `${name} ${title} ${domain}`.toLowerCase()
}

/** 单 query 双臂测量（返回配对量与顺序变化标记）。 */
function measure(query: EvalQuery) {
  const routed = routeByQueryIntent(query.intent).collections.filter((c) => c !== "tech")
  const docs = routed.flatMap((c) =>
    (VIEW.collections?.[c] ?? []).map((e) => ({ id: String(e["name"]), text: hay(e) })),
  )
  const tokens = tokensForKbMatch(query.query)
  const ranked = rankByBm25(query.query, docs)
  const baseIds = ranked.map((r) => r.id)
  const baseTopK = baseIds.slice(0, TOP_K).includes(query.gold)

  const textById = new Map(docs.map((d) => [d.id, d.text]))
  const candidates = baseIds.map((id) => ({
    title: id,
    snippet: textById.get(id) ?? "",
    path: id,
  }))
  const t0 = performance.now()
  const reranked = reorderByUsefulness(candidates, { entityHints: tokens })
  const t1 = performance.now()
  const expIds = reranked.map((c) => c.path ?? c.title)
  const expTopK = expIds.slice(0, TOP_K).includes(query.gold)

  return {
    measurement: {
      queryId: `${query.intent}:${query.gold}:${query.query}`,
      deltaPp: (expTopK ? 100 : 0) - (baseTopK ? 100 : 0),
      deltaMs: t1 - t0,
    } satisfies LambdaMeasurement,
    baseTopK,
    expTopK,
    orderChanged: baseIds.some((id, i) => expIds[i] !== id),
  }
}

const measured = SET.queries.map((q) => ({ ...measure(q), query: q }))
const measurements = measured.map((m) => m.measurement)
const fit = fitLambda({ measurements })
const orderChangedCount = measured.filter((m) => m.orderChanged).length
const topKChangedCount = measured.filter((m) => m.baseTopK !== m.expTopK).length
const gainCount = measured.filter((m) => m.measurement.deltaPp > 0).length
const lossCount = measured.filter((m) => m.measurement.deltaPp < 0).length
const meanDeltaMs = measurements.reduce((s, m) => s + m.deltaMs, 0) / measurements.length

const summary = [
  `λ 标定 harness（内部非同源集）N=${measurements.length} builtFrom=${SET.builtFrom}`,
  formatLambdaFit(fit),
  `臂差异证据：排序变化 ${orderChangedCount}/${measurements.length}；top3 成员变化 ${topKChangedCount}（增益 ${gainCount} / 损失 ${lossCount}）`,
  `增量成本：mean Δms=${meanDeltaMs.toFixed(4)} ms（实验臂重排步骤实测）`,
  `现役 λ 保持：${RETRIEVAL_LAMBDA_INITIAL.value} ${RETRIEVAL_LAMBDA_INITIAL.unit} calibrated=${RETRIEVAL_LAMBDA_INITIAL.calibrated}（未翻位）`,
].join("\n")

describe("B2 λ 标定双臂测量（证据面）", () => {
  it("配对点规模：全部 query 参与，n ≥ 30 硬门", () => {
    expect(measurements.length).toBe(SET.queries.length)
    expect(measurements.length).toBeGreaterThanOrEqual(LAMBDA_MIN_POINTS)
    expect(fit.n).toBe(measurements.length)
  })

  it("配对量数值面：Δpp ∈ {-100,0,100}、Δms 非负有限", () => {
    for (const m of measurements) {
      expect([-100, 0, 100]).toContain(m.deltaPp)
      expect(Number.isFinite(m.deltaMs)).toBe(true)
      expect(m.deltaMs).toBeGreaterThanOrEqual(0)
    }
  })

  it("实验臂非空转：重排真实改变排序（否则 Δpp 恒 0 无意义）", () => {
    expect(orderChangedCount).toBeGreaterThan(0)
    const sample = measured[0]!
    expect(sample.measurement.queryId).toContain(sample.query.intent)
  })

  it("拟合输出可观测（不因未达标而抛错）：slope/R²/reason 齐备", () => {
    console.log(summary)
    expect(Number.isFinite(fit.slope)).toBe(true)
    expect(fit.r2).toBeGreaterThanOrEqual(0)
    expect(fit.r2).toBeLessThanOrEqual(1)
    expect(["ok", "x_zero_variance", "r2_below_threshold"]).toContain(fit.reason)
    expect(fit.pass).toBe(fit.r2 >= LAMBDA_R2_MIN && fit.reason === "ok")
  })

  it("不翻位：λ 初值未被 harness 改写（value=25 / calibrated=false）", () => {
    expect(RETRIEVAL_LAMBDA_INITIAL.value).toBe(25)
    expect(RETRIEVAL_LAMBDA_INITIAL.value).toBe(LAMBDA_MS_PER_PP_INITIAL)
    expect(RETRIEVAL_LAMBDA_INITIAL.calibrated).toBe(false)
    expect(fit.pass && RETRIEVAL_LAMBDA_INITIAL.calibrated).toBe(false)
  })

  it("门控写盘（LAMBDA_CALIBRATION=1）：docs/p0/lambda-calibration-<date>.md；常态零副作用", () => {
    if (!GATED) {
      expect(existsSync(P0_DIR)).toBe(true) // 常态下不新增文件
      return
    }
    const stamp = new Date().toISOString().slice(0, 10)
    const out = resolve(P0_DIR, `lambda-calibration-${stamp}.md`)
    const body = [
      `# λ 标定证据报告（${stamp}）`,
      "",
      "## 口径声明（先读）",
      "",
      "- 本报告为**证据**，**未翻位**：λ 默认值仍为 25 ms_per_pp、`calibrated=false`，",
      "  R2 阈值（1000 语料 / 1e4 chunk / 30 簇 / 0pp 净增益）**一字未改**。",
      "- 口径 = 内部非同源一致性（配对点取自 `internal-eval-set.generated.json`，N=" + measurements.length + "）；",
      "  **不构成第三方裁决 / 不构成跨系统裁决**；W 面（WeKnora）维持「未达裁决」。",
      "- 配对量定义：Δpp = (experiment top3 义务命中 − baseline top3 义务命中) × 100；",
      "  Δms = experiment 臂 `reorderByUsefulness` 重排步骤实测耗时（性能增量来源）。",
      "- λ 语义：净增益(pp) = Δpp − Δms / λ → 无差异点 Δms = λ·Δpp，故 slope(Δms~Δpp) = λ 估计（ms_per_pp）。",
      "",
      "## 判定结果",
      "",
      "```",
      summary,
      "```",
      "",
      "## 拟合输入摘要",
      "",
      `- 点数 n=${measurements.length}；非零 Δpp 信号点=${fit.signalPoints}/${fit.n}`,
      `- slope=${fit.slope.toFixed(6)} ms_per_pp；intercept=${fit.intercept.toFixed(6)} ms；R²=${fit.r2.toFixed(6)}`,
      `- 门限：R² ≥ ${LAMBDA_R2_MIN}、n ≥ ${LAMBDA_MIN_POINTS} → verdict=${fit.pass ? "达门限" : `未达标（${fit.reason}）`}`,
      `- 臂差异：排序变化 ${orderChangedCount}/${measurements.length}、top3 成员变化 ${topKChangedCount}（增益 ${gainCount} / 损失 ${lossCount}）`,
      "",
      "## 配对点（前 30 行，全量见测试输出）",
      "",
      "| queryId | Δpp | Δms |",
      "|---|---|---|",
      ...measurements
        .slice(0, 30)
        .map((m) => `| ${m.queryId.replace(/\|/g, "/")} | ${m.deltaPp} | ${m.deltaMs.toFixed(4)} |`),
      "",
      "## 结论与边界",
      "",
    ]
      .concat(
        fit.reason === "x_zero_variance"
          ? [
              "- **无判别信号**：Δpp 全零（rerank 只改顺序、不改 top3 成员）→ 无法求解斜率，",
              "  λ 不可标定。这与 R2 谓词 `mmr_corpus_below_threshold`（规模未达）**互为交叉印证**，",
              "  不得据此放宽门限或开启 MMR。",
            ]
          : fit.pass
            ? [
                "- 拟合达门限，但**仅记录证据**：翻位需 gate PASS 判据包（ADR-48），本任务不翻位。",
              ]
            : [
                "- **未达标**：R² 低于门限 → λ 不可标定（不得放宽门限，不得据此翻位）。",
              ],
      )
      .concat(
        fit.signalPoints / fit.n < LAMBDA_MIN_SIGNAL_RATIO
          ? [
              `- **近零信号**：非零 Δpp 仅 ${fit.signalPoints}/${fit.n} 点（增益 ${gainCount} / 损失 ${lossCount}）——`,
              "  有用性重排在本规模**不产生 top3 义务增益**（排序变化 " +
                orderChangedCount +
                " 条但 top3 成员变化仅 " +
                topKChangedCount +
                "），",
              `  故上表 slope 不可采信；λ 无标定基础（与 R2 MMR 谓词 locked 互为交叉印证）。`,
              `- 成本面：实验臂增量 ~${meanDeltaMs.toFixed(4)} ms/query（实测），即若开启重排需付此代价而未见增益。`,
            ]
          : [],
      )
      .concat([
        "- 计时为单次实测（Node 同进程），存在噪声；本报告不主张跨机可复现的绝对延迟。",
        "- 报告时间为写盘路径 `new Date()`（门控产物，docs/ 被 gitignore，靠本 spec 重生成）。",
        "",
        "## status.json 同步位",
        "",
        "- 本报告为证据快照，未写入 `.novel/status.json`；flag/阈值默认值不变。",
        "",
      ])
      .join("\n")
    mkdirSync(P0_DIR, { recursive: true })
    writeFileSync(out, body, "utf8")
    expect(existsSync(out)).toBe(true)
    // 报告内容自检：必须含未翻位声明
    expect(readFileSync(out, "utf8")).toContain("未翻位")
  })
})
