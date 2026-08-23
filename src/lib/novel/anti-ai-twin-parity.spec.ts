import { describe, expect, it, beforeAll } from "vitest"
import { resolve } from "node:path"
import { AntiAiCandidatePool } from "./anti-ai-candidate-pool"
// PAT-G2 唯一实现（.mjs）—— 生产 TS 池的孪生对拍基准
import { buildCorpusIndexes, runDetection } from "../../../scripts/lib/anti-ai-factors.mjs"

const CORPUS_ROOT = resolve(__dirname, "../../../../docs/p0/corpus")

/**
 * 孪生奇偶校验 (twin parity): scripts/lib/anti-ai-factors.mjs ↔ src TS 池
 * 2026-08-23 P0 共识裁决引入。范围: paragraphLengthDist 判定
 * （熵因子语义差异——归一化 vs 原始比特——属已知待闭环项, 不在本测内）
 */

function makeParas(lengths: number[], fill = "字"): string {
  return lengths.map((n) => fill.repeat(n)).join("\n\n")
}

const FIXTURES: Record<string, string> = {
  // 均匀段落 → CV≈0 → 双侧都应 warn
  uniform8: makeParas(Array(8).fill(40)),
  // 强变化段落 → CV 高 → 双侧都不 warn
  varied6: makeParas([20, 200, 15, 180, 25, 220]),
  // 4 段带内文本 → 放宽带生效阈值 0.35（漂移杀手用例: 无带实现会漏报）
  band4: makeParas([60, 95, 55, 90]),
  // 3 段带内文本
  band3: makeParas([70, 40, 65]),
  // <3 段 → 双侧都不判
  short2: makeParas([50, 80]),
  // 对话密集型（短段为主但长度有变化）
  dialogue: [
    "「你来了。」他说，声音压得很低。",
    "她没有回答，只是把伞收了起来，雨水顺着伞骨滴落在门槛内侧，积成一小滩浅浅的水洼。",
    "「坐吧。」",
    "他在对面坐下，两个人隔着一桌子沉默。",
    "窗外的雨还在下。",
    "「东西带来了吗？」她终于开口，目光却始终没有离开那滩水洼。",
  ].join("\n\n"),
}

describe("anti-ai 孪生奇偶校验 (.mjs 权威实现 ↔ 生产 TS 池)", () => {
  let pool: AntiAiCandidatePool

  beforeAll(() => {
    pool = new AntiAiCandidatePool(CORPUS_ROOT)
    pool.loadCorpus()
  })

  it("PL 因子逐 fixture warn 判定一致", () => {
    const indexes = buildCorpusIndexes(
      [{ text: FIXTURES.varied6 }, { text: FIXTURES.dialogue }],
      [{ text: FIXTURES.uniform8 }],
    )
    for (const [name, text] of Object.entries(FIXTURES)) {
      const mjs = runDetection(text, indexes).warns.paragraphLengthDist
      const ts = pool.analyze(text).factors.find((f) => f.factor === "paragraphLengthDist")
      expect(ts, `fixture ${name}: TS 池应产出 PL 因子`).toBeDefined()
      expect(ts!.warn, `fixture ${name}: .mjs=${mjs} vs ts=${ts!.warn}`).toBe(mjs)
    }
  })

  it("放宽带在双侧同时生效 (3-4 段阈值 0.35 而非 0.30)", () => {
    for (const name of ["band4", "band3"]) {
      const ts = pool.analyze(FIXTURES[name]).factors.find((f) => f.factor === "paragraphLengthDist")!
      expect(ts.threshold, `${name}: TS 应携带 0.35 放宽带`).toBe(0.35)
      const indexes = buildCorpusIndexes([{ text: FIXTURES.band4 }], [{ text: FIXTURES.uniform8 }])
      expect(runDetection(FIXTURES[name], indexes).warns.paragraphLengthDist).toBe(ts.warn)
    }
  })

  it("均匀段落双侧一致 warn / 变化段落双侧一致不 warn", () => {
    const indexes = buildCorpusIndexes([{ text: FIXTURES.dialogue }], [{ text: FIXTURES.uniform8 }])
    expect(runDetection(FIXTURES.uniform8, indexes).warns.paragraphLengthDist).toBe(true)
    expect(pool.analyze(FIXTURES.uniform8).factors.find((f) => f.factor === "paragraphLengthDist")!.warn).toBe(true)
    expect(runDetection(FIXTURES.varied6, indexes).warns.paragraphLengthDist).toBe(false)
    expect(pool.analyze(FIXTURES.varied6).factors.find((f) => f.factor === "paragraphLengthDist")!.warn).toBe(false)
  })
})
