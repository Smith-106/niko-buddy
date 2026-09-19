/**
 * ann/ann-recall-harness.spec.ts — B3-b ANN 接口一致性 + recall@k + 延迟基线（批准计划 r3 §T6）。
 *
 * 度量口径（**关键限制**）：
 *   - 本 harness 度量的是「精确参考实现 vs 独立参考路径」的 **接口一致性**，
 *     recall@k = 1.0 属构造性结果，**不构成 ANN（近似检索）可用性证据**；
 *   - 近似索引未实现（`ANN_PLAN.implemented=false`，谓词 `ann_no_implementation` 保持 locked）；
 *   - 延迟用**注入时钟**（零墙钟）：同一注入序列 → 同一 durationMs（可复现）；
 *   - 反假绿负向控制：故意降级的候选必须使 recall < 1（证明度量非恒真）。
 *
 * 写盘：`ANN_HARNESS=1` 门控 → docs/p0/ann-recall-latency-<YYYYMMDD>.md。
 *
 * @license MIT © Niko Buddy
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"
import { ANN_DESCRIPTOR_SCHEMA, AnnIndexError, recallAtK, withInjectedClock } from "./ann-index"
import { createExactAnnIndex } from "./brute-force-index"
import { ANN_PLAN_PLACEHOLDER } from "../retrieval-scale-placeholders"

const GATED = process.env["ANN_HARNESS"] === "1"
const REPO_ROOT = resolve(__dirname, "..", "..", "..", "..")
const P0_DIR = resolve(REPO_ROOT, "docs", "p0")

const DIM = 16
const N_VECTORS = 160
const N_QUERIES = 30
const K = 5

/** 确定性伪随机（LCG，无 Math.random；跨跑一致）。 */
function makeRng(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0
    return state / 0x100000000
  }
}

function makeVectors(n: number, dim: number, seed: number) {
  const rng = makeRng(seed)
  return Array.from({ length: n }, (_, i) => ({
    id: `v${String(i).padStart(4, "0")}`,
    values: Array.from({ length: dim }, () => Number((rng() * 2 - 1).toFixed(6))),
  }))
}

const VECTORS = makeVectors(N_VECTORS, DIM, 20260917)
const QUERIES = makeVectors(N_QUERIES, DIM, 987654321).map((q) => q.values)

/** 独立参考路径（spec 内直接算余弦，不复用被测实现）：top-k id 序列。 */
function referenceTopK(values: number[], k: number): string[] {
  const norm = (v: readonly number[]) => Math.sqrt(v.reduce((s, x) => s + x * x, 0))
  const qn = norm(values)
  return VECTORS.map((v) => {
    const vn = norm(v.values)
    const dot = v.values.reduce((s, x, i) => s + x * (values[i] ?? 0), 0)
    const score = qn === 0 || vn === 0 ? 0 : dot / (qn * vn)
    return { id: v.id, score }
  })
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
    .slice(0, k)
    .map((s) => s.id)
}

const index = createExactAnnIndex()
index.build(VECTORS)

const measured = QUERIES.map((values, i) => {
  const reference = referenceTopK(values, K)
  const hits = index.search({ values, k: K })
  const candidate = hits.map((h) => h.id)
  return { query: i, reference, candidate, recall: recallAtK(reference, candidate, K) }
})
const meanRecall = measured.reduce((s, m) => s + m.recall, 0) / measured.length

/** 延迟：注入时钟（每次测量消耗两个 tick；确定性）。 */
const clockTicks = Array.from({ length: (N_QUERIES + 2) * 2 }, (_, i) => 1000 + i * 0.5)
let cursor = 0
const injectedClock = () => clockTicks[cursor++] ?? 0
const latencies = QUERIES.map((values) =>
  withInjectedClock(injectedClock, () => index.search({ values, k: K })).durationMs,
)
const meanLatency = latencies.reduce((s, x) => s + x, 0) / latencies.length

/** 负向控制：截断候选（只返回前 k-1 条 + 一条错误补位）→ recall 必须 < 1。 */
const degradedRecall = measured.map((m) => recallAtK(m.reference, m.candidate.slice(0, K - 1), K))
const degradedMean = degradedRecall.reduce((s, x) => s + x, 0) / degradedRecall.length

const summary = [
  `ANN 接口一致性 harness：N=${N_VECTORS} dim=${DIM} queries=${N_QUERIES} k=${K}`,
  `recall@${K}（精确参考 vs 独立参考路径）= ${meanRecall.toFixed(4)}（构造性 1.0，≠ ANN 可用性证据）`,
  `延迟基线（注入时钟，确定性）= mean ${meanLatency.toFixed(4)} ms（每查询实测 ticks 差）`,
  `负向控制（候选截断 k-1）= recall@${K} = ${degradedMean.toFixed(4)}（< 1 → 度量非恒真）`,
  `近似索引状态：ANN_PLAN.implemented=${ANN_PLAN_PLACEHOLDER.implemented}（谓词 ann_no_implementation 保持 locked）`,
].join("\n")

describe("B3-b ANN 接口契约（ann/）", () => {
  it("描述子符合 schema 且自证边界（exact=true / note 非空）", () => {
    const descriptor = index.descriptor()
    expect(ANN_DESCRIPTOR_SCHEMA.safeParse(descriptor).success).toBe(true)
    expect(descriptor.kind).toBe("exact")
    expect(descriptor.exact).toBe(true)
    expect(descriptor.dimension).toBe(DIM)
    expect(descriptor.size).toBe(N_VECTORS)
    expect(descriptor.note).toContain("不构成 ANN 可用性证据")
    expect(index.size()).toBe(N_VECTORS)
  })

  it("接口一致性：精确参考与独立参考路径逐查询同序（recall@k = 1.0）", () => {
    expect(meanRecall).toBe(1)
    for (const m of measured) expect(m.candidate).toEqual(m.reference)
  })

  it("确定性全序：同分场景按 id 升序 tie-break（不依赖插入顺序）", () => {
    const a = createExactAnnIndex()
    const b = createExactAnnIndex()
    const tied = [
      { id: "zeta", values: [1, 0] },
      { id: "alpha", values: [1, 0] },
      { id: "mid", values: [1, 0] },
    ]
    a.build(tied)
    b.build([...tied].reverse())
    const q = { values: [1, 0], k: 3 }
    expect(a.search(q).map((h) => h.id)).toEqual(["alpha", "mid", "zeta"])
    expect(b.search(q).map((h) => h.id)).toEqual(a.search(q).map((h) => h.id))
    expect(a.search(q).map((h) => h.rank)).toEqual([1, 2, 3])
  })

  it("延迟基线走注入时钟（零墙钟）：同一注入序列 → 同一 durationMs", () => {
    const ticks = [10, 12.5, 20, 24]
    let i = 0
    const clock = () => ticks[i++] ?? 0
    const first = withInjectedClock(clock, () => index.search({ values: QUERIES[0]!, k: K }))
    const second = withInjectedClock(clock, () => index.search({ values: QUERIES[0]!, k: K }))
    expect(first.durationMs).toBe(2.5)
    expect(second.durationMs).toBe(4)
    expect(latencies.every((x) => x === 0.5)).toBe(true)
  })

  it("度量非恒真：候选截断后 recall@k < 1（反假绿负向控制）", () => {
    expect(degradedMean).toBeLessThan(1)
    expect(recallAtK(["a", "b"], ["a"], 2)).toBe(0.5)
    expect(recallAtK(["a"], ["a"], 1)).toBe(1)
    expect(() => recallAtK(["a"], ["a"], 0)).toThrow(AnnIndexError)
  })

  it("边界与校验：空索引 / 维度不一致 / id 重复 / 非法 k 均 fail-loud", () => {
    const empty = createExactAnnIndex()
    expect(empty.search({ values: [1, 0], k: 3 })).toEqual([])
    expect(empty.descriptor().size).toBe(0)
    const idx = createExactAnnIndex()
    idx.build([{ id: "a", values: [1, 0] }])
    expect(() => idx.search({ values: [1, 0, 0], k: 1 })).toThrow(AnnIndexError)
    expect(() => idx.build([{ id: "a", values: [1] }, { id: "a", values: [0] }])).toThrow(AnnIndexError)
    expect(() => idx.build([{ id: "x", values: [1] }, { id: "y", values: [1, 2] }])).toThrow(AnnIndexError)
    expect(() => idx.search({ values: [1, 0], k: 0 })).toThrow(AnnIndexError)
    // k > size：返回全部，不报错
    expect(idx.search({ values: [1, 0], k: 50 })).toHaveLength(1)
    // l2 口径：负欧氏距离（越大越优）
    const l2 = createExactAnnIndex({ metric: "l2" })
    l2.build([{ id: "near", values: [0, 0] }, { id: "far", values: [9, 9] }])
    expect(l2.search({ values: [0, 0], k: 2 }).map((h) => h.id)).toEqual(["near", "far"])
    expect(l2.descriptor().metric).toBe("l2")
  })

  it("近似索引未实现：ANN_PLAN.implemented 保持 false（谓词不解锁）", () => {
    expect(ANN_PLAN_PLACEHOLDER.implemented).toBe(false)
    expect(ANN_PLAN_PLACEHOLDER.kind).toBe("unspecified")
  })

  it("门控写盘（ANN_HARNESS=1）：docs/p0/ann-recall-latency-<date>.md；常态零副作用", () => {
    if (!GATED) {
      expect(existsSync(P0_DIR)).toBe(true)
      return
    }
    const stamp = new Date().toISOString().slice(0, 10)
    const out = resolve(P0_DIR, `ann-recall-latency-${stamp}.md`)
    const body = [
      `# ANN 接口一致性 + recall@k + 延迟基线（${stamp}）`,
      "",
      "## 限制声明（先读）",
      "",
      "- 本报告度量的是**精确暴力参考实现 vs 独立参考路径**的**接口一致性**；",
      "  `recall@k = 1.0` 是**构造性结果**，**不构成 ANN（近似检索）可用性证据**。",
      "- **近似索引未实现**：`ANN_PLAN.implemented=false`，R2 谓词 `ann_no_implementation` 保持 locked；",
      "  不得以本报告为据解除谓词或开启 ANN。",
      "- 本报告的价值：① 接口/schema/名次口径一致性靶子；② 延迟基线，作为未来近似实现的**回归地板**",
      "  （recall 只允许向上、延迟只允许向下）。",
      "- 延迟为**注入时钟**读数（零墙钟）：可复现，但不是真实机器延迟；真机延迟须在实现认领时另测。",
      "",
      "## 配置",
      "",
      `- 向量数 ${N_VECTORS} / 维度 ${DIM} / 查询数 ${N_QUERIES} / k=${K} / 度量 cosine（确定性 LCG 生成）`,
      `- 描述子：${JSON.stringify(index.descriptor())}`,
      "",
      "## 结果",
      "",
      "```",
      summary,
      "```",
      "",
      "## 接口契约（同源）",
      "",
      "- `src/lib/novel/ann/ann-index.ts`：`AnnIndex`（build/search/descriptor/size）+ strict schemas + `recallAtK` + `withInjectedClock`",
      "- `src/lib/novel/ann/brute-force-index.ts`：`createExactAnnIndex`（exact=true；score desc → id asc）",
      "- 实现方认领近似索引时必须：同 schema、同名次口径、过 `ANN_HARNESS` 地板，并同 commit 更新 ANN_PLAN 与谓词（ADR-48）。",
      "",
      "## status.json 同步位",
      "",
      "- 本报告为证据快照，未写入 `.novel/status.json`；flag/阈值默认值不变。",
      "",
    ].join("\n")
    mkdirSync(P0_DIR, { recursive: true })
    writeFileSync(out, body, "utf8")
    expect(existsSync(out)).toBe(true)
    expect(readFileSync(out, "utf8")).toContain("不构成 ANN（近似检索）可用性证据")
  })
})
