/**
 * same-scale-harness.spec — R0-a1 同尺迁移评测比较核测试。
 * 覆盖：Wilson 区间性质（包含点估计/边界 k=0 下界 0/k=n 上界 1/对称性/
 * 样本量增大区间收窄/非法输入 fail-loud）/ compareSameScale 判定
 * （下界≥阈值 triggered，否则未达裁决；掉档清单；W 面方法学声明；
 * 输入 schema 校验失败 fail-loud）/ WeknoraSnapshotSchema 严格性。
 *
 * @license MIT © Niko Buddy
 */
import { describe, expect, it } from "vitest"
import {
  SAME_SCALE_VERDICT_SCHEMA,
  SameScaleHarnessError,
  WEKNORA_SNAPSHOT_SCHEMA,
  compareSameScale,
  wilsonScoreInterval,
  type GoldenRank,
  type SameScaleInput,
  type WeknoraSnapshot,
} from "./same-scale-harness"

function snapshotFixture(): WeknoraSnapshot {
  return {
    schemaVersion: 1,
    source: "reference/WeKnora/dataset/samples（只读抽取，未迁移代码）",
    sourceCommit: "1ef38fdb",
    files: {
      "queries.parquet": { rows: 1, columns: ["id", "text"] },
      "corpus.parquet": { rows: 4, columns: ["id", "text"] },
      "qrels.parquet": { rows: 4, columns: ["qid", "pid", "score"] },
      "answers.parquet": { rows: 1, columns: ["id", "text"] },
      "qas.parquet": { rows: 1, columns: ["qid", "aid"] },
    },
    tables: {
      "queries.parquet": [{ id: "1", text: "q" }],
      "corpus.parquet": [
        { id: "1", text: "c1" },
        { id: "2", text: "c2" },
        { id: "3", text: "c3" },
        { id: "4", text: "c4" },
      ],
      "qrels.parquet": [
        { qid: "1", pid: "1", score: "1" },
        { qid: "1", pid: "2", score: "1" },
        { qid: "1", pid: "3", score: "1" },
        { qid: "1", pid: "4", score: "1" },
      ],
      "answers.parquet": [{ id: "1", text: "a" }],
      "qas.parquet": [{ qid: "1", aid: "1" }],
    },
  }
}

function ranksFixture(top3Flags: boolean[]): GoldenRank[] {
  return top3Flags.map((top3, i) => ({
    query: `q${i + 1}`,
    rank: top3 ? 1 : 25,
    top3,
    top20: top3 ? true : false,
  }))
}

describe("R0-a1 Wilson 得分区间", () => {
  it("区间包含点估计（k=24/n=34）", () => {
    const { lower, upper } = wilsonScoreInterval(24, 34)
    expect(lower).toBeLessThan(24 / 34)
    expect(upper).toBeGreaterThan(24 / 34)
  })

  it("k=24/n=34 下界约 0.538、上界约 0.832（手算对照）", () => {
    const { lower, upper } = wilsonScoreInterval(24, 34)
    expect(lower).toBeCloseTo(0.5384, 3)
    expect(upper).toBeCloseTo(0.8317, 3)
  })

  it("边界：k=0 下界为 0；k=n 上界为 1", () => {
    expect(wilsonScoreInterval(0, 34).lower).toBe(0)
    expect(wilsonScoreInterval(34, 34).upper).toBe(1)
  })

  it("对称性：lower(k,n) = 1 - upper(n-k,n)", () => {
    const a = wilsonScoreInterval(10, 34)
    const b = wilsonScoreInterval(24, 34)
    expect(a.lower).toBeCloseTo(1 - b.upper, 10)
    expect(a.upper).toBeCloseTo(1 - b.lower, 10)
  })

  it("样本量增大区间收窄（同比例 p=0.5，n=34 vs n=340）", () => {
    const small = wilsonScoreInterval(17, 34)
    const large = wilsonScoreInterval(170, 340)
    expect(large.upper - large.lower).toBeLessThan(small.upper - small.lower)
  })

  it("非法输入 fail-loud（k>n / n=0 / 非整数 / 负数）", () => {
    expect(() => wilsonScoreInterval(35, 34)).toThrow(SameScaleHarnessError)
    expect(() => wilsonScoreInterval(0, 0)).toThrow(SameScaleHarnessError)
    expect(() => wilsonScoreInterval(1.5, 34)).toThrow(SameScaleHarnessError)
    expect(() => wilsonScoreInterval(-1, 34)).toThrow(SameScaleHarnessError)
  })
})

describe("R0-a1 compareSameScale", () => {
  it("全中 34/34：下界≥0.7 即 triggered（k=34 下界约 0.899）", () => {
    const result = compareSameScale({
      ranks: ranksFixture(Array(34).fill(true)),
      snapshot: snapshotFixture(),
      top3Threshold: 0.7,
    })
    expect(result.p1.n).toBe(34)
    expect(result.p1.top3Hits).toBe(34)
    expect(result.p1.top3Rate).toBe(1)
    expect(result.p1.wilsonLower).toBeGreaterThanOrEqual(0.7)
    expect(result.p1.verdict).toBe("triggered")
    expect(result.p1.droppedQueries).toEqual([])
    expect(SAME_SCALE_VERDICT_SCHEMA.safeParse(result.p1.verdict).success).toBe(true)
  })

  it("点估计达标但下界未达即未达裁决（k=24/n=34：点估计 0.706≥0.7，下界 0.538<0.7）", () => {
    const flags = [...Array(24).fill(true), ...Array(10).fill(false)]
    const result = compareSameScale({
      ranks: ranksFixture(flags),
      snapshot: snapshotFixture(),
      top3Threshold: 0.7,
    })
    expect(result.p1.top3Rate).toBeCloseTo(24 / 34, 10)
    expect(result.p1.top3Rate).toBeGreaterThanOrEqual(0.7)
    expect(result.p1.wilsonLower).toBeLessThan(0.7)
    expect(result.p1.verdict).toBe("未达裁决")
    expect(result.p1.droppedQueries).toHaveLength(10)
    expect(result.p1.droppedQueries[0]).toBe("q25")
  })

  it("W 面：方法学对齐参照如实声明（gold 4/4 全标 + 同源回归口径注）", () => {
    const result = compareSameScale({
      ranks: ranksFixture(Array(34).fill(true)),
      snapshot: snapshotFixture(),
      top3Threshold: 0.7,
    })
    expect(result.w.sourceCommit).toBe("1ef38fdb")
    expect(result.w.corpusSize).toBe(4)
    expect(result.w.goldSize).toBe(4)
    expect(result.w.queryCount).toBe(1)
    expect(result.w.note).toContain("未做逐 query 跨系统对跑")
    expect(result.w.note).toContain("同源回归口径，不可作收敛结论")
  })

  it("阈值可配：top3Threshold 缺省 0.7", () => {
    const input = {
      ranks: ranksFixture(Array(34).fill(true)),
      snapshot: snapshotFixture(),
    } satisfies Omit<SameScaleInput, "top3Threshold"> as unknown as SameScaleInput
    const result = compareSameScale(input)
    expect(result.p1.threshold).toBe(0.7)
  })

  it("空 ranks 输入 schema 校验失败 fail-loud", () => {
    expect(() =>
      compareSameScale({ ranks: [], snapshot: snapshotFixture(), top3Threshold: 0.7 }),
    ).toThrow(SameScaleHarnessError)
  })

  it("WeknoraSnapshotSchema strict：未知字段视为契约违反", () => {
    const parsed = WEKNORA_SNAPSHOT_SCHEMA.safeParse({ ...snapshotFixture(), unknownField: 1 })
    expect(parsed.success).toBe(false)
  })

  it("WeknoraSnapshotSchema：schemaVersion 必须为字面量 1", () => {
    const parsed = WEKNORA_SNAPSHOT_SCHEMA.safeParse({ ...snapshotFixture(), schemaVersion: 2 })
    expect(parsed.success).toBe(false)
  })
})
