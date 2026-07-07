import { describe, expect, it } from "vitest"
import { contextPackToPrompt, type ContextPack, type SourceTier, type ContextGap } from "./context-engine"
import { computeContextBudget } from "@/lib/context-budget"

const basePack: ContextPack = {
  task: "生成第2章正文",
  chapterGoal: "",
  outline: "",
  recentSummaries: [],
  previousChapterEnding: "",
  characterStates: "",
  soulDoc: "",
  characterAuras: "",
  cognitionStates: "",
  foreshadowingStates: "",
  timeline: "",
  relatedSettings: "",
  canonRules: "",
  writingStyle: "",
  searchResults: "",
  graphSearchResults: "",
  mustDo: "",
  mustAvoid: "",
  nextChapterAdvice: "",
  revisionDirectives: "",
  recentChapterContents: [],
  gaps: [],
}

describe("contextPackToPrompt", () => {
  it("将最近章节正文片段写入小说上下文包", () => {
    const prompt = contextPackToPrompt({
      ...basePack,
      recentChapterContents: [
        "## 第1章正文片段\n黑背心纹身大汉倒在雨里。",
      ],
    })

    expect(prompt).toContain("最近章节正文片段")
    expect(prompt).toContain("黑背心纹身大汉倒在雨里")
  })
})

describe("TASK-003 protected/compressible tiering", () => {
  it("SourceTier 类型包含 protected 与 compressible 两个取值", () => {
    const tiers: SourceTier[] = ["protected", "compressible"]
    expect(tiers).toContain("protected")
    expect(tiers).toContain("compressible")
  })

  it("ContextGap 记录被裁源的 type/ref/reason 字段（IC-02 契约）", () => {
    const gap: ContextGap = {
      type: "truncated",
      ref: "canon-rules:fallback",
      reason: "budget_exceeded",
      originalLength: 9000,
      retainedLength: 8000,
    }
    expect(gap.type).toBe("truncated")
    expect(gap.ref).toBe("canon-rules:fallback")
    expect(gap.reason).toBe("budget_exceeded")
    expect(gap.originalLength).toBeGreaterThan(gap.retainedLength)
  })

  it("protected 段在 contextPackToPrompt 中不被压缩（canonRules 全量出现在 prompt）", () => {
    // 模拟一个 protected tier 的 canon rules 内容（即便很长也不应被 prompt 层裁剪）
    const longCanon = "正史规则：".repeat(1) + Array.from({ length: 200 }, (_, i) => `规则${i}`).join("；")
    const prompt = contextPackToPrompt({
      ...basePack,
      canonRules: longCanon,
    })
    // protected 段的全量内容应出现在 prompt 中（contextPackToPrompt 不再对 canon 做截断）
    expect(prompt).toContain(longCanon)
  })

  it("compressible 段经 prompt 层呈现（recentSummaries 数组内容可见）", () => {
    const summaries = ["第1章：起因揭示", "第2章：冲突升级"]
    const prompt = contextPackToPrompt({
      ...basePack,
      recentSummaries: summaries,
    })
    // compressible 段的内容应被注入到 prompt（虽然底层读取时可能被 tieredSlice 截断，
    // 但 prompt 装配层应呈现已注入的内容）
    expect(prompt).toContain("第1章：起因揭示")
    expect(prompt).toContain("第2章：冲突升级")
  })

  it("gaps[] 字段存在于 ContextPack（IC-02 契约 — 禁静默降级）", () => {
    const pack: ContextPack = {
      ...basePack,
      gaps: [
        {
          type: "truncated",
          ref: "character-states:fallback",
          reason: "tier_compressible",
          originalLength: 5000,
          retainedLength: 2000,
        },
      ],
    }
    expect(pack.gaps).toBeDefined()
    expect(pack.gaps!.length).toBe(1)
    expect(pack.gaps![0].reason).toBe("tier_compressible")
  })
})

describe("TASK-003 chapterNumber 自适应预算", () => {
  it("chapterNumber undefined 走原逻辑（向后兼容）", () => {
    const withoutChapter = computeContextBudget(204_800)
    const withChapterOne = computeContextBudget(204_800, 1)
    // undefined 和 chapter 1 (<=10 满额) 应该得到相同的预算
    expect(withoutChapter.indexBudget).toBe(withChapterOne.indexBudget)
    expect(withoutChapter.pageBudget).toBe(withChapterOne.pageBudget)
  })

  it("chapterNumber=5 vs 500 预算不同（自适应 — 章 500 更压缩）", () => {
    const early = computeContextBudget(204_800, 5)
    const late = computeContextBudget(204_800, 500)
    // 早期章节应该比后期章节获得更大的 index/page 预算
    expect(early.indexBudget).toBeGreaterThan(late.indexBudget)
    expect(early.pageBudget).toBeGreaterThan(late.pageBudget)
  })

  it("chapterNumber<=10 满额（scale=1.0）", () => {
    const baseline = computeContextBudget(204_800)
    const chapter10 = computeContextBudget(204_800, 10)
    expect(chapter10.indexBudget).toBe(baseline.indexBudget)
    expect(chapter10.pageBudget).toBe(baseline.pageBudget)
  })

  it("chapterNumber=100 对数衰减到 ~80%", () => {
    const baseline = computeContextBudget(204_800)
    const chapter100 = computeContextBudget(204_800, 100)
    // scale at n=100 should be 0.8, so budgets should be ~80% of baseline
    // (floor() introduces off-by-one tolerance, use ~)
    expect(chapter100.indexBudget).toBeGreaterThanOrEqual(Math.floor(baseline.indexBudget * 0.79))
    expect(chapter100.indexBudget).toBeLessThanOrEqual(Math.floor(baseline.indexBudget * 0.81))
  })

  it("chapterNumber>100 继续向 0.6 收敛（n=10000 < n=100）", () => {
    const baseline = computeContextBudget(204_800)
    const chapter100 = computeContextBudget(204_800, 100)
    const chapter10000 = computeContextBudget(204_800, 10_000)
    // scale at n=100 is 0.8, at n=10000 is 0.7 (0.6 + 0.4*1/4) — still
    // converging toward 0.6 asymptotically. The key property: later
    // chapters get strictly smaller budgets than chapter 100, and the
    // budget stays above the 0.6 floor.
    expect(chapter10000.indexBudget).toBeLessThan(chapter100.indexBudget)
    expect(chapter10000.indexBudget).toBeGreaterThanOrEqual(Math.floor(baseline.indexBudget * 0.6))
    expect(chapter10000.indexBudget).toBeLessThanOrEqual(Math.floor(baseline.indexBudget * 0.75))
  })

  it("responseReserve 不受 chapterNumber 缩放影响（LLM 回答空间恒定）", () => {
    const early = computeContextBudget(204_800, 5)
    const late = computeContextBudget(204_800, 500)
    expect(early.responseReserve).toBe(late.responseReserve)
  })

  it("DEFAULT_MAX_CTX fallback 保持不变（falsy maxContextSize）", () => {
    const fromZero = computeContextBudget(0, 500)
    const fromUndefined = computeContextBudget(undefined, 500)
    const fromExplicit = computeContextBudget(204_800, 500)
    expect(fromZero.maxCtx).toBe(204_800)
    expect(fromUndefined.maxCtx).toBe(204_800)
    expect(fromExplicit.maxCtx).toBe(204_800)
  })
})
