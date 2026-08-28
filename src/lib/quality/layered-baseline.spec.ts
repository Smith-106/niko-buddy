/**
 * layered-baseline.spec.ts — v2.6.9 D1 验收
 *
 * 覆盖：N≥200/层 / 漂移探针 / 不回溯重判
 */
import { describe, expect, it } from "vitest"
import {
  DRIFT_THRESHOLD,
  buildLayeredBaseline,
  probeBaselineDrift,
  verifyNoRetroactive,
} from "./layered-baseline"

const mkSamples = (n: number, base: number) => Array.from({ length: n }, (_, i) => base + (i % 5) * 0.1)

describe("D1 分层基线 — N≥200/层（不可退化为合并）", () => {
  it("每层 N≥200 构建成功", () => {
    const b = buildLayeredBaseline({
      perplexity: mkSamples(200, 1.0),
      burstiness: mkSamples(200, 0.5),
      sentence_length: mkSamples(200, 20),
    })
    expect(b.anchors.perplexity).toBeGreaterThan(0)
  })

  it("任一层 N<200 拒绝（不可退化为合并）", () => {
    expect(() =>
      buildLayeredBaseline({
        perplexity: mkSamples(199, 1.0),
        burstiness: mkSamples(200, 0.5),
        sentence_length: mkSamples(200, 20),
      }),
    ).toThrow("样本不足")
  })
})

describe("D1 分层基线 — 漂移探针（阈值锁定）", () => {
  it("无漂移：通过", () => {
    const b = buildLayeredBaseline({
      perplexity: mkSamples(200, 1.0),
      burstiness: mkSamples(200, 0.5),
      sentence_length: mkSamples(200, 20),
    })
    const r = probeBaselineDrift(b, {
      perplexity: mkSamples(200, 1.0),
      burstiness: mkSamples(200, 0.5),
      sentence_length: mkSamples(200, 20),
    })
    expect(r.drifted).toBe(false)
  })

  it("漂移超阈：fail（阈值锁定）", () => {
    const b = buildLayeredBaseline({
      perplexity: mkSamples(200, 1.0),
      burstiness: mkSamples(200, 0.5),
      sentence_length: mkSamples(200, 20),
    })
    const r = probeBaselineDrift(b, {
      perplexity: mkSamples(200, 1.0 + DRIFT_THRESHOLD * 2),
      burstiness: mkSamples(200, 0.5),
      sentence_length: mkSamples(200, 20),
    })
    expect(r.drifted).toBe(true)
  })
})

describe("D1 分层基线 — 不回溯重判既有章节", () => {
  it("已 commit 章节不重判", () => {
    expect(verifyNoRetroactive(["ch1", "ch2"], "ch1")).toBe(false)
    expect(verifyNoRetroactive(["ch1", "ch2"], "ch3")).toBe(true)
  })
})
