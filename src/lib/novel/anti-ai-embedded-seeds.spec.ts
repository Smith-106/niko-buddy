/**
 * anti-ai-embedded-seeds.spec.ts — 方案②内嵌种子契约测试
 *
 * 验证：
 *  1. 默认构造（生产主路径）从内嵌 JSON 加载：60 片（30 human + 30 ai）、索引非空
 *  2. 显式 corpusRoot（测试/工具路径）仍走 FS 扫描
 *  3. 内嵌 vs FS 奇偶校验：同文本 analyze 因子判定一致（仅当仓库语料树存在时）
 *
 * 生成物由 scripts/generate-anti-ai-corpus-bundle.mjs 产生并入库，
 * fresh clone 无仓库外语料树时第 3 项自动跳过。
 */
import { describe, expect, it } from "vitest"
import { existsSync } from "node:fs"
import { resolve } from "node:path"
import { AntiAiCandidatePool } from "./anti-ai-candidate-pool"

// QMAI/src/lib/novel → hub 根 docs/p0/corpus
const HUB_CORPUS_ROOT = resolve(__dirname, "../../../../docs/p0/corpus")
const HUB_TREE_EXISTS = existsSync(resolve(HUB_CORPUS_ROOT, "human", "batch-20260821-001"))

describe("AntiAiCandidatePool 内嵌种子（方案②）", () => {
  it("默认构造：内嵌加载 60 片，索引非空，零 fs 依赖", () => {
    const pool = new AntiAiCandidatePool()
    const result = pool.loadCorpus()
    expect(result.total).toBe(60)
    expect(result.human).toHaveLength(30)
    expect(result.ai).toHaveLength(30)
    expect(pool.loaded).toBe(true)
    // n-gram 索引与标点指纹已构建（四因子真值前提）
    expect((pool as unknown as { ai3GramTotal: number }).ai3GramTotal).toBeGreaterThan(0)
    const aiFp = (pool as unknown as { aiPunctuationFingerprint: Record<string, number> })
      .aiPunctuationFingerprint
    expect(Object.keys(aiFp).length).toBeGreaterThan(0)
    // hydrate 形状与 FS 加载对齐：file 为 basename、source/batchId 就位
    expect(result.ai[0].file).toMatch(/^[a-z]+-\d+\.txt$/)
    expect(result.ai[0].source).toBe("synthetic-degraded")
    expect(result.ai[0].batchId).toBe("20260821-001")
  })

  it("显式 corpusRoot：FS 扫描路径不受影响", () => {
    const pool = new AntiAiCandidatePool(HUB_TREE_EXISTS ? HUB_CORPUS_ROOT : undefined)
    if (!HUB_TREE_EXISTS) {
      // fresh clone：显式传 undefined 等价默认构造（内嵌），只验证不抛
      expect(() => pool.loadCorpus()).not.toThrow()
      return
    }
    const result = pool.loadCorpus()
    expect(result.total).toBeGreaterThan(0)
    expect(pool.loaded).toBe(true)
  })

  it.skipIf(!HUB_TREE_EXISTS)(
    "奇偶校验：内嵌 vs FS 同文本因子判定一致",
    () => {
      const emb = new AntiAiCandidatePool()
      emb.loadCorpus()
      const fsp = new AntiAiCandidatePool(HUB_CORPUS_ROOT)
      fsp.loadCorpus()

      // 索引级对拍
      const e = emb as unknown as { ai3GramTotal: number }
      const f = fsp as unknown as { ai3GramTotal: number }
      expect(e.ai3GramTotal).toBe(f.ai3GramTotal)

      // 判定级对拍：AI 腔样文（高模板化 3-gram）与中性人写风样文
      const samples = [
        "他的眼中闪过一丝不易察觉的笑意。她的心中涌起一股莫名的暖意。一时间，气氛变得微妙起来。",
        "锅热了下油，葱姜爆香，倒入鸡块翻炒至变色。加一勺料酒，焖十分钟。",
      ]
      for (const text of samples) {
        const a = emb.analyze(text)
        const b = fsp.analyze(text)
        const warnOf = (r: typeof a, name: string) =>
          r.factors.find((x) => x.factor === name)?.warn
        expect(warnOf(a, "nGramOverlap")).toBe(warnOf(b, "nGramOverlap"))
        expect(warnOf(a, "punctuationFingerprint")).toBe(
          warnOf(b, "punctuationFingerprint"),
        )
        expect(a.hasWarnings).toBe(b.hasWarnings)
      }
    },
  )
})
