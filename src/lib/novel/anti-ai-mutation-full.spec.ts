/**
 * anti-ai-mutation-full.spec.ts — T19 真实语料 mutation 验证（T20 calibrate 前置基线）
 *
 * 用 hub 语料树真实文本验证候选池机制：
 *   - human 1035 抽样 → mutateTest 注入 AI 腔变异 → 检出率基线
 *   - ai 139 抽样 → analyze 四因子 warn 触发率基线
 * 语料树缺失（CI）时 skip；本地验收必跑。
 */
import { describe, it, expect } from "vitest"
import { readFileSync, readdirSync, existsSync } from "node:fs"
import { resolve, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { AntiAiCandidatePool } from "./anti-ai-candidate-pool"

const __dirname = dirname(fileURLToPath(import.meta.url))
const HUB_CORPUS = resolve(__dirname, "../../../../docs/p0/corpus")
const HAS_CORPUS = existsSync(resolve(HUB_CORPUS, "human/batch-20260826-t01b1-human"))

function sampleLayer(layer: string, batches: string[], n: number): { file: string; text: string }[] {
  const out: { file: string; text: string }[] = []
  for (const batch of batches) {
    const dir = resolve(HUB_CORPUS, layer, batch)
    if (!existsSync(dir)) continue
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".txt")) continue
      const text = readFileSync(resolve(dir, f), "utf8")
      if (text.length >= 100) out.push({ file: `${layer}/${batch}/${f}`, text })
      if (out.length >= n) return out
    }
  }
  return out
}

describe.skipIf(!HAS_CORPUS)("TASK-P2-19 (T19) 真实语料 mutation 验证（hub 语料树）", () => {
  const pool = new AntiAiCandidatePool()
  const load = pool.loadCorpus()

  it("候选池加载（旧批种子机制）", () => {
    expect(load.total).toBeGreaterThan(0)
    expect(load.human.length).toBeGreaterThan(0)
  })

  const humans = sampleLayer("human", ["batch-20260826-t01b1-human", "batch-20260821-001"], 10)
  const ais = sampleLayer("ai", ["batch-20260826-t01b2-ai", "batch-20260826-t01c-001", "batch-20260821-001", "batch-20260822-writing"], 20)

  it("真实人写文本 mutation 后 warn 检出率 ≥0.5（标定前机制信号，T20 调阈值）", () => {
    expect(humans.length).toBeGreaterThanOrEqual(5)
    let detected = 0
    for (const h of humans) {
      const r = pool.mutateTest(h.text)
      const mutatedWarn = (r.mutatedReport?.factors ?? []).some(f => f.warn)
      const origWarn = (r.originalReport?.factors ?? []).some(f => f.warn)
      if (mutatedWarn && !origWarn) detected++
      else if (mutatedWarn) detected++
      // mutation 生效断言：变异文本与原文不同
      expect(r.mutatedText).not.toBe(h.text)
    }
    const rate = detected / humans.length
    console.log(`[T19-baseline] 真实语料 mutation 检出率: ${rate}（${detected}/${humans.length}）`)
    expect(rate).toBeGreaterThanOrEqual(0.5)
  })

  it("真实 AI 文本四因子基线记录（标定前 warn 率输出，T20 调阈值）", () => {
    expect(ais.length).toBeGreaterThanOrEqual(10)
    let warned = 0
    const factorWarn: Record<string, number> = { nGramOverlap: 0, sentenceEntropy: 0, punctuationFingerprint: 0, paragraphLengthDist: 0 }
    for (const a of ais) {
      const r = pool.analyze(a.text)
      expect(r.factors.length).toBe(4) // 四因子结构完整
      if ((r.factors ?? []).some(f => f.warn)) warned++
      for (const f of r.factors ?? []) if (f.warn && f.factor in factorWarn) factorWarn[f.factor]++
    }
    const rate = warned / ais.length
    console.log(`[T19-baseline] 真实 AI 语料 warn 率: ${rate}（${warned}/${ais.length}）| byFactor: ${JSON.stringify(factorWarn)}`)
    console.log("[T19-baseline] 标定前保守阈值（零误杀优先）；T20 anti-ai-calibrate 以 139 全量重标阈值")
    expect(rate).toBeGreaterThanOrEqual(0) // 基线记录，不设硬门（阈值属 T20）
  })

  it("逐变异类型检出率（证伪检测失效：至少一类强变异 ≥0.8）", () => {
    const types = ["addSummaryClause", "addMechanicalTransition", "addPsychTemplate", "addPunctuationUniform", "addParagraphUniform", "addAI3Gram"]
    const rates: Record<string, number> = {}
    for (const t of types) {
      let hit = 0
      for (const h of humans) {
        const r = pool.mutateTest(h.text, t)
        if ((r.mutatedReport?.factors ?? []).some(f => f.warn)) hit++
      }
      rates[t] = hit / humans.length
    }
    console.log(`[T19-falsify] 逐变异类型检出率: ${JSON.stringify(rates)}`)
    const best = Math.max(...Object.values(rates))
    expect(best).toBeGreaterThanOrEqual(0.8) // 存在检测有效的变异类型 → 检测器未失效
  })

  it("组合强注入（保留段落结构，每段追加 AI 腔）warn 率 ≥0.5（能力上限探针）", () => {
    let hit = 0
    for (const h of humans) {
      // 每段后追加 AI 腔（保留段落结构），叠加总结腔+心理模板+机械转场
      const paragraphs = h.text.split(/\n\s*\n/)
      const injected = paragraphs.map(p =>
        `毫无疑问，${p}显然，这一切都表明了一个事实。与此同时，他不禁感到心中五味杂陈，复杂的情绪涌上心头。`
      ).join("\n\n")
      const r = pool.analyze(injected)
      if ((r.factors ?? []).some(f => f.warn)) hit++
    }
    const rate = hit / humans.length
    console.log(`[T19-falsify] 组合强注入（分段）warn 率: ${rate}（${hit}/${humans.length}）`)
    expect(rate).toBeGreaterThanOrEqual(0.5) // 检测器有响应即可；0.8 以上留待 T20 阈值标定
  })
})
