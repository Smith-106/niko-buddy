/**
 * shared-text-features.spec.ts — T24 共享特征预计算 + 核心四包组合入口单测
 *
 * 蓝图 §6 T24 (TASK-P3-24) 要求 5 收敛面:
 *   - precomputeTextFeatures: 一次扫描产出句式/段落/n-gram/标点统计（数值正确性）;
 *   - composeCoreRulePacks: 四包稳定产出 / 共享同一 features 实例 /
 *     combinePacks 冻结组合后 runRuleStack 可运行;
 *   - 空文本安全。
 *
 * 执行纪律: ADR-19 机械层零模型调用（纯算术 + DI stub）。
 */
import { describe, expect, it } from "vitest"
import {
  composeCoreRulePacks,
  precomputeTextFeatures,
  SHARED_PUNCTUATION_CHARS,
} from "./shared-text-features"
import { combinePacks, runRuleStack } from "../rule-stack"

const SAMPLE = [
  "他推开门，屋内一片漆黑。",
  "空气里浮着旧木头的味道，混着一点铁锈腥气。",
  "",
  "「谁？」他压低声音问了一句，没有人回答。",
].join("\n")

describe("precomputeTextFeatures 统计正确性", () => {
  it("句式/段落/token/n-gram/标点统计与手算一致", () => {
    const f = precomputeTextFeatures(SAMPLE)
    // 句子：按 。？！ 分句 → 4 句
    expect(f.sentenceLengths).toHaveLength(4)
    expect(f.sentenceLengths[0]).toBe("他推开门，屋内一片漆黑".length)
    // 段落：按换行分段，空段过滤 → 3 段
    expect(f.paragraphLengths).toHaveLength(3)
    // CV 手算一致性（0 < CV，且与均值/标准差定义吻合）
    const mean = f.sentenceLengths.reduce((a, b) => a + b, 0) / f.sentenceLengths.length
    const sd = Math.sqrt(
      f.sentenceLengths.reduce((s, l) => s + (l - mean) ** 2, 0) / f.sentenceLengths.length,
    )
    expect(f.sentenceLengthCV).toBeCloseTo(sd / mean, 10)
    // n-gram：token 化后 3-gram 总数 = tokens.length - 2（单段内跨标点拼接）
    expect(f.trigramTotal).toBe(Math.max(0, f.tokenCount - 2))
    expect(f.trigramUnique).toBeLessThanOrEqual(f.trigramTotal)
    // 标点计数
    let punct = 0
    for (const ch of SAMPLE) {
      if (SHARED_PUNCTUATION_CHARS.includes(ch)) punct++
    }
    expect(f.punctuationTotal).toBe(punct)
    expect(Object.values(f.punctuationCounts).reduce((a, b) => a + b, 0)).toBe(punct)
    // rawLength 保真
    expect(f.rawLength).toBe(SAMPLE.length)
  })

  it("空文本安全：全零统计不抛错", () => {
    const f = precomputeTextFeatures("")
    expect(f.sentenceLengths).toEqual([])
    expect(f.paragraphLengths).toEqual([])
    expect(f.sentenceLengthCV).toBe(0)
    expect(f.trigramTotal).toBe(0)
    expect(f.punctuationTotal).toBe(0)
  })

  it("防绕过预处理透传：零宽字符被剥离并计入 bypassCount", () => {
    const f = precomputeTextFeatures("他\u200b走了。")
    expect(f.normalizedText).not.toContain("\u200b")
    expect(f.bypassCount).toBeGreaterThan(0)
  })
})

describe("composeCoreRulePacks 核心四包组合", () => {
  it("恒产四包且 packIds 稳定（缺省域为空规则包）", () => {
    const packs = composeCoreRulePacks({})
    expect(packs.map((p) => p.id)).toEqual([
      "pack.continuity",
      "pack.anti-ai-mech",
      "pack.anti-ai-llm",
      "pack.quality-six-dim",
    ])
    for (const p of packs) {
      expect(Array.isArray(p.rules)).toBe(true)
    }
  })

  it("combinePacks 冻结组合 + runRuleStack 全链可运行（run 前冻结语义）", () => {
    const packs = composeCoreRulePacks({
      chapterContent: SAMPLE,
      continuity: { foreshadowing: [], subplots: [], characters: [], snapshots: [], currentChapter: 5 },
      llmFindings: [{ severity: "info", type: "translationese", message: "轻微欧化" }],
      sixDimResults: {},
    })
    const stack = combinePacks(packs)
    expect(stack.packIds).toEqual(["pack.anti-ai-llm", "pack.anti-ai-mech", "pack.continuity", "pack.quality-six-dim"])
    expect(Object.isFrozen(stack)).toBe(true)
    const result = runRuleStack(stack, { isFinale: false })
    // 结构统计 info 规则消费共享 features；LLM 投影 finding 入 anti_ai 门
    expect(result.allFindings.some((f) => f.ruleId === "six-dim.structure-stats")).toBe(true)
    expect(result.allFindings.some((f) => f.ruleId === "anti-ai-llm.projection")).toBe(true)
    expect(result.shortCircuited).toBe(false)
  })

  it("共享预计算：features 单实例注入多包（quality 消费与 mech 消费同源）", () => {
    const packs = composeCoreRulePacks({
      chapterContent: SAMPLE,
      sixDimResults: {},
    })
    const qualityPack = packs.find((p) => p.id === "pack.quality-six-dim")!
    const statsRule = qualityPack.rules.find((r) => r.id === "six-dim.structure-stats")!
    const findings = statsRule.run({ isFinale: false })
    expect(findings).toHaveLength(1)
    // 与独立预计算结果数值一致（同一次扫描的派生只读快照）
    const direct = precomputeTextFeatures(SAMPLE)
    expect(findings[0]!.message).toContain(`CV ${direct.sentenceLengthCV.toFixed(3)}`)
    expect(findings[0]!.message).toContain(`${direct.trigramUnique}/${direct.trigramTotal}`)
  })
})
