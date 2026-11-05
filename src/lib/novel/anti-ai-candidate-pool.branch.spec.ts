import { describe, expect, it, vi, afterEach } from "vitest"
import {
  AntiAiCandidatePool,
  quickAntiAiAnalysis,
} from "./anti-ai-candidate-pool"

afterEach(() => {
  vi.unstubAllGlobals()
  vi.doUnmock("./anti-ai-seeds.generated.json")
  vi.doUnmock("./anti-ai-corpus-fs")
})

/**
 * anti-ai-candidate-pool 分支覆盖补齐（Ralph 覆盖率战役）。
 * 只增补：覆盖既有 spec 未走到的条件分支另一侧，每例均断言可观察行为。
 */
describe("anti-ai-candidate-pool 分支补齐", () => {
  it("构造支持多批 + ai 层独立单字符串批次", () => {
    const pool = new AntiAiCandidatePool("/nonexistent-aa-branch-root", ["b1", "b2"], "ai-only")
    expect(pool.batchId).toBe("b1+b2")
    expect((pool as unknown as { _aiBatchIds: string[] })._aiBatchIds).toEqual(["ai-only"])
    const poolArr = new AntiAiCandidatePool("/nonexistent-aa-branch-root", ["b1"], ["ai1", "ai2"])
    expect((poolArr as unknown as { _aiBatchIds: string[] })._aiBatchIds).toEqual(["ai1", "ai2"])
  })

  it("显式 corpusRoot 指向空目录 → FS 扫描零语料降级（标点指纹零分母分支）", async () => {
    const pool = new AntiAiCandidatePool("/nonexistent-aa-branch-empty-root-xyz")
    const res = await pool.loadCorpus()
    expect(res.total).toBe(0)
    expect(pool.loaded).toBe(true)
    // loaded=true 即使空语料也走全量五因子检测
    const report = pool.analyze("这是测试文本。这是第二句。这是第三句。这是第四句。这是第五句。这是第六句。这是第七句。这是第八句。")
    expect(report.factors).toHaveLength(5)
    expect(report.calibrationSource).toBe("synthetic-degraded")
  })

  it("内嵌种子缺 samples 字段时回退空语料（samples ?? [] 右侧）", async () => {
    vi.resetModules()
    vi.doMock("./anti-ai-seeds.generated.json", () => ({ default: { batchIds: [] } }))
    vi.doMock("./anti-ai-corpus-fs", () => ({
      resolveDefaultCorpusRoot: () => null,
      loadCorpusLayer: () => [],
    }))
    try {
      const fresh = await import("./anti-ai-candidate-pool")
      const res = await new fresh.AntiAiCandidatePool().loadCorpus()
      expect(res.total).toBe(0)
      expect(res.human).toEqual([])
    } finally {
      vi.doUnmock("./anti-ai-seeds.generated.json")
      vi.doUnmock("./anti-ai-corpus-fs")
    }
  })

  it("句长单桶 → 归一化分母 log2(1)=0 → 熵值 0 且 warn", async () => {
    const pool = new AntiAiCandidatePool()
    await pool.loadCorpus()
    // 8 句等长 → 同一 5 字桶 → K=1 → maxEnt=0 → normalized=0（low 口径 0<0.7 触发 warn）
    const text = "这是测试句。".repeat(8)
    const report = pool.detectSentenceEntropy(text)
    expect(report.bucketCount).toBe(1)
    expect(report.value).toBe(0)
    expect(report.warn).toBe(true)
  })

  it("mutateTest 缺省变异类型走 addSummaryClause", async () => {
    const pool = new AntiAiCandidatePool()
    await pool.loadCorpus()
    const text = "他推开门走了进去。她点了点头，没有说话。"
    const r = pool.mutateTest(text)
    expect(r.mutationType).toBe("addSummaryClause")
    expect(r.mutatedText).toContain("显然")
    expect(r.mutatedText.length).toBeGreaterThan(text.length)
  })

  it("mutateTest 空文本 addSummaryClause 无句可改 → 文本不变且不区分", async () => {
    const pool = new AntiAiCandidatePool()
    await pool.loadCorpus()
    const r = pool.mutateTest("", "addSummaryClause")
    expect(r.mutatedText).toBe("")
    expect(r.discriminates).toBe(false)
  })

  it("mutateTest 未加载语料 addAI3Gram 无 AI 段落可注入 → 文本不变", () => {
    const pool = new AntiAiCandidatePool()
    const text = "雨停在傍晚七点，地铁口还在滴水。"
    const r = pool.mutateTest(text, "addAI3Gram")
    expect(r.mutatedText).toBe(text)
    expect(r.discriminates).toBe(false)
  })

  it("runAllMutationTests 空语料 → total/rate 均为 0", () => {
    const pool = new AntiAiCandidatePool()
    const out = pool.runAllMutationTests()
    expect(out.total).toBe(0)
    expect(out.discriminated).toBe(0)
    expect(out.rate).toBe(0)
  })

  it("quickAntiAiAnalysis 复用默认池（第二次走缓存分支）", () => {
    // 内嵌种子加载同步完成：两次调用均为已加载态全量五因子检测
    const first = quickAntiAiAnalysis("雨停在傍晚七点，地铁口还在滴水。")
    const second = quickAntiAiAnalysis("林晚把伞甩了两下，没甩干，索性夹在腋下。")
    expect(first.factors).toHaveLength(5)
    expect(second.factors).toHaveLength(5)
    expect(second.calibrationSource).toBe(first.calibrationSource)
    expect(second.summary).toMatch(/\[warn\]|\[clean\]/)
  })
})
