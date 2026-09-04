import { describe, expect, it, beforeAll } from "vitest"
import { resolve } from "node:path"
import { AntiAiCandidatePool } from "./anti-ai-candidate-pool"
// PAT-G2 唯一实现（.mjs）—— 生产 TS 池的孪生对拍基准
import { buildCorpusIndexes, runDetection } from "../../../scripts/lib/anti-ai-factors.mjs"

const CORPUS_ROOT = resolve(__dirname, "../../../../docs/p0/corpus")

/**
 * 孪生奇偶校验 (twin parity): scripts/lib/anti-ai-factors.mjs ↔ 生产 TS 池
 * 2026-08-23 P0 共识裁决引入。
 * 范围: paragraphLengthDist + sentenceEntropy 判定 (裁决 A 后已全部闭环)
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

  beforeAll(async () => {
    pool = new AntiAiCandidatePool(CORPUS_ROOT)
    await pool.loadCorpus()
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

  it("short/long 阈值参数化生效 (T20 标定: 0.2/0.2, 双侧一致)", () => {
    for (const name of ["band4", "band3"]) {
      const ts = pool.analyze(FIXTURES[name]).factors.find((f) => f.factor === "paragraphLengthDist")!
      expect(ts.threshold, `${name}: TS 应携带 T20 标定 short 阈值 0.2`).toBe(0.2)
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

// ─── 熵因子孪生奇偶 (2026-08-23 裁决 A: TS 已切归一化 <0.7, 本组钉死奇偶) ───
// 数学基准: normalized = H/log2(K观测桶数); K≤10 桶时旧 raw<3.5 线恒真误报 → 已废弃
function makeSents(lengths: number[], fill = "字"): string {
  return lengths.map((n) => fill.repeat(n)).join("。")
}

// 句长落在桶中央避免边界抖动: len2→桶0-4, len7→5-9, len12→10-14, len17→15-19
const SENT_FIXTURES: Record<string, { text: string; expectWarn: boolean; why: string }> = {
  // F1 门位置: 7 句双侧不判
  gate7: { text: makeSents(Array(7).fill(10)), expectWarn: false, why: "7句<8 不入判" },
  // F2 门恰在 8 + K=1 除零 guard 分支 (全同句长→H=0,norm=0→warn)
  gate8minWarn: { text: makeSents(Array(8).fill(10)), expectWarn: true, why: "8句同长 K=1 norm=0" },
  // F3 均匀分布永不该 warn (norm=1.0); 旧 raw 规则因 2.0<3.5 误报 —— 切换检测器①
  uniformK4: { text: makeSents([2, 7, 12, 17, 2, 7, 12, 17, 2, 7, 12, 17, 2, 7, 12, 17]), expectWarn: false, why: "K=4 均匀 H=2.0 norm=1.0; 旧TS误报" },
  // F4 K=2 线上方 (p=[.75,.25] H≈0.811 ≥0.7)
  k2aboveLine: { text: makeSents([...Array(9).fill(2), ...Array(3).fill(7)]), expectWarn: false, why: "K=2 H≈0.811 在线上方; 旧TS误报" },
  // F5a K=4 线下方钉住 (counts[14,2,2,2] H≈1.357 norm≈0.678<0.7) — 防过修
  k4belowLine: { text: makeSents([...Array(14).fill(2), ...Array(2).fill(7), ...Array(2).fill(12), ...Array(2).fill(17)]), expectWarn: true, why: "norm≈0.678<0.7 应 warn" },
  // F5b K=4 线上方 (counts[13,3,2,2] H≈1.479 norm≈0.740) — 切换检测器②
  k4aboveLine: { text: makeSents([...Array(13).fill(2), ...Array(3).fill(7), ...Array(2).fill(12), ...Array(2).fill(17)]), expectWarn: false, why: "norm≈0.740≥0.7; 旧TS误报" },
  // F6 高熵锚点 K=12 每桶2句 H=log2(12)=3.585 norm=1.0 — 双侧历来一致
  highAnchorK12: { text: makeSents([2, 7, 12, 17, 22, 27, 32, 37, 42, 47, 52, 57, 2, 7, 12, 17, 22, 27, 32, 37, 42, 47, 52, 57]), expectWarn: false, why: "K=12 满熵 norm=1.0" },
  // F7 杀 docstring 迷思 (<15句校正规则不存在于代码): 15句均匀3桶 norm=1.0
  count15uniform: { text: makeSents([...Array(5).fill(2), ...Array(5).fill(7), ...Array(5).fill(12)]), expectWarn: false, why: "K=3 满熵 norm=1.0; 旧TS误报" },
  // F9 标点密集塌缩单桶: AI 对话腔最典型触发形态
  punctDenseK1: { text: ["走！", "不。", "为什么？", "好。", "行。", "滚。", "来。", "去。", "说。", "看。", "听。", "等。", "坐。", "站。", "停。", "完。"].join(""), expectWarn: true, why: "16短句全塌 K=1 H=0" },
  // F10 门下缘完备性
  tooFew: { text: "只有一句。", expectWarn: false, why: "1句<8" },
}

// F8 漂移金丝雀: 中英混排/小数点/省略号/叠标点 —— 期望值由 node 实跑冻结 (勿手改)
const MIXED_CANARY = [
  "He paused for a moment before answering.",
  "他给了自己 3.5 秒钟犹豫。",
  "「你到底想说什么……」她问。",
  "The answer was obvious!!",
  "风从窗缝里钻进来，吹得灯焰摇晃不定。",
  "「没什么。」他说完就转身走了。",
  "Silence settled over the room like dust.",
  "她盯着他的背影看了很久，直到楼道的声控灯灭了。",
  "「等等——」",
  "雨又下起来了。",
].join("")
const MIXED_FROZEN = { entropy: 2.4182958340544896, normalized: 0.9355245321275765 }

describe("anti-ai 孪生奇偶: 熵因子 (裁决A 归一化<0.7)", () => {
  let pool: AntiAiCandidatePool
  let indexes: ReturnType<typeof buildCorpusIndexes>

  beforeAll(async () => {
    pool = new AntiAiCandidatePool(CORPUS_ROOT)
    await pool.loadCorpus()
    indexes = buildCorpusIndexes([{ text: FIXTURES.dialogue }], [{ text: FIXTURES.uniform8 }])
  })

  function tsSE(text: string) {
    const factors = pool.analyze(text).factors
    expect(factors.length, "池应产出全部5因子 (语料未加载会假绿)").toBe(5)
    return factors.find((f) => f.factor === "sentenceEntropy")!
  }

  for (const [name, fx] of Object.entries(SENT_FIXTURES)) {
    it(`${name}: ${fx.why}`, () => {
      const mjs = runDetection(fx.text, indexes)
      const ts = tsSE(fx.text)
      // 层1 绝对钉死 (防双侧同向漂移)
      expect(ts.warn, `golden 期望 ${fx.expectWarn}`).toBe(fx.expectWarn)
      // 层2 奇偶
      expect(ts.warn).toBe(mjs.warns.sentenceEntropy)
      // 层3 公式级 (值漂移即使 warn 巧合一致也能抓)
      expect(ts.value).toBeCloseTo(mjs.sentenceEntropy.normalized, 6)
      expect(ts.rawValue).toBeCloseTo(mjs.sentenceEntropy.entropy, 6)
    })
  }

  it("F8 mixed-canary: 冻结期望值 + 正则/分桶漂移检测", () => {
    const mjs = runDetection(MIXED_CANARY, indexes)
    expect(mjs.sentenceEntropy.entropy).toBeCloseTo(MIXED_FROZEN.entropy, 6)
    expect(mjs.sentenceEntropy.normalized).toBeCloseTo(MIXED_FROZEN.normalized, 6)
    const ts = tsSE(MIXED_CANARY)
    expect(ts.rawValue).toBeCloseTo(MIXED_FROZEN.entropy, 6)
    expect(ts.value).toBeCloseTo(MIXED_FROZEN.normalized, 6)
    expect(ts.warn).toBe(mjs.warns.sentenceEntropy)
  })

  it("阈值面元数据: threshold=0.7, unit=normalized", () => {
    const ts = tsSE(SENT_FIXTURES.k4belowLine.text)
    expect(ts.threshold).toBe(0.7)
    expect(ts.unit).toBe("normalized")
    expect(typeof ts.bucketCount).toBe("number")
  })
})
