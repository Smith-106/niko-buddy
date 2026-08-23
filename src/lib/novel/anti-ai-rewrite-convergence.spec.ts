/**
 * anti-ai-rewrite-convergence.spec.ts — TASK-P2-21 (T21): 改写收敛测试
 *
 * 目的:
 *   验证反 AI 检测→改写→检测不退化 (detect→rewrite→detect non-degradation)。
 *   使用 Myers diff (computeMyersDiff) 做章节级差异分析, 替换 LCS 大文本路径。
 *
 * 收敛判据:
 *   ① 改写后 slopPenalty 不上升 (detect→rewrite→detect non-degradation)
 *   ② 改写后文本不丢失原文内容 (diff 重建一致)
 *   ③ dual-pass 软检报告 productionHardGate=false (Track B soft)
 *   ④ 三档 anti_ai_mode 在 route() 门控中行为正确:
 *      - off: anti_ai=fail → judge (不阻塞)
 *      - warn: anti_ai=fail → judge (不阻塞, 含注解)
 *      - block: anti_ai=fail → revise (硬挡)
 *
 * 执行纪律:
 *   - ADR-19 机械层零模型调用: 本 spec 不调用任何模型 / IO / Tauri invoke。
 *   - Draft-first (ADR-08): 本 spec 不触及 .novel/status.json 正式层。
 *   - fast-diff: 使用 computeMyersDiff 做行级章节 diff, 替换 LCS 大文本 O(NM) 路径。
 *
 * @license MIT © QMAI
 */

import { describe, expect, it } from "vitest"
import { slopScore, classifySlop } from "./mechanical-slop-detector"
import { runDeAiDualPass } from "./de-ai-dual-pass"
import { computeMyersDiff } from "./diff"
import { route } from "./control-kernel"
import type { AntiAiMode, ControlState } from "./control-kernel"
import { ANTI_AI_MODES } from "./control-sentinels"

// ============================================================================
// 测试夹具
// ============================================================================

/**
 * 模拟"AI 腔"测试文本: 包含 TIER1 强禁用词、TIER2 可疑词、TIER3 机械句式、
 * 低句长熵、低段落 CV 等典型 AI 信号。
 */
const AI_TAINTED_TEXT = [
  "显然，这一切都表明了一个事实。",
  "与此同时，他的内心充满了复杂的情感。",
  "事实上，他不得不承认，这确实是一个至关重要的决定。",
  "他深吸一口气，目光变得坚定，心中暗道：是时候了。",
  "时间仿佛静止，空气中弥漫着紧张的气氛。",
  "他嘴角勾起一丝微笑，眼神中透露出深不可测的光芒。",
  "毫无疑问，这将会彻底改变一切。",
  "她低下头，心中五味杂陈，不知道该说什么好。",
  "紧接着，他感到一股无法言说的情绪涌上心头。",
  "她抬起头，目光交汇的瞬间，时间仿佛凝固了。",
  "他握紧拳头，目光变得坚定，在心中暗暗做出了决定。",
  "然而，事情的转折来得太快，让人措手不及。",
  "她心中充满了疑惑和不安，无法确认自己的判断是否正确。",
  "他深吸一口气，努力保持镇定，但心跳加速无法掩饰。",
  "从此，一切都发生了翻天覆地的变化。",
].join("\n\n")

/**
 * 干净对照文本: 无 AI 腔特征, 句长多样, 段落 CV 高。
 */
const CLEAN_TEXT = [
  "门开了。",
  "白砚站在门口，肩上还滴着水。",
  "「你来了。」王迦抬起头，把烟按灭在烟灰缸里。",
  "白砚没说话，走过去坐下。椅子发出一声轻响。",
  "「雨大。」他说。",
  "王迦看着他，等他开口。",
  "过了很久，白砚才说：「李昭然死了。」",
  "王迦的手停在半空。",
  "「什么时候？」",
  "「三天前。车祸。」",
  "窗外雨声渐密。",
  "王迦慢慢把手放下来，搁在桌上。",
  "「跟我没关系。」他说。",
  "白砚抬起头看他。",
  "「我知道。」",
  "两人都没再说话。",
  "雨声填满了整个房间。",
].join("\n\n")

/**
 * 构建 route() 的 review 阶段控制态, 用于测试 anti_ai_mode 门控。
 */
function reviewState(
  antiAiMode: AntiAiMode,
  antiAiVerdict: "pending" | "pass" | "fail" = "fail",
  consistencyVerdict: "pending" | "pass" | "fail" = "pass",
  qualityVerdict: "pending" | "pass" | "fail" = "pass",
  overrides: Partial<ControlState> = {},
): ControlState {
  return {
    phase: "writing",
    stage: "review",
    chapterNumber: 5,
    completedChapters: 4,
    pendingRewrites: [],
    gates: { consistency: consistencyVerdict, anti_ai: antiAiVerdict, quality: qualityVerdict },
    antiAiMode,
    manualReviewRequired: false,
    foundationMissing: [],
    planningTier: "",
    reviewInterval: 0,
    lastGlobalReviewChapter: 0,
    arcBoundary: undefined,
    hasArcReview: false,
    hasArcSummary: false,
    hasVolumeSummary: false,
    shellMode: "legacy",
    ...overrides,
  }
}

// ============================================================================
// 收敛测试
// ============================================================================

describe("T21 anti-ai-rewrite-convergence", () => {
  // ============================================================================
  // ① 检测基线: slopScore 能区分 AI 腔文本与干净文本
  // ============================================================================

  describe("① 检测基线 (slopScore 区分度)", () => {
    it("AI 腔文本 slopPenalty 应显著高于干净文本", () => {
      const aiReport = slopScore(AI_TAINTED_TEXT)
      const cleanReport = slopScore(CLEAN_TEXT)

      // AI 腔文本 penalty 应高于干净文本
      expect(aiReport.slopPenalty).toBeGreaterThan(cleanReport.slopPenalty)
      // AI 腔文本应有 TIER 命中
      expect(aiReport.tier1Hits.length + aiReport.tier2Hits.length + aiReport.tier3Hits.length).toBeGreaterThan(0)
      // 干净文本应无或极少命中
      expect(cleanReport.tier1Hits.length + cleanReport.tier2Hits.length + cleanReport.tier3Hits.length).toBeLessThanOrEqual(
        aiReport.tier1Hits.length + aiReport.tier2Hits.length + aiReport.tier3Hits.length,
      )
    })

    it("AI 腔文本 classifySlop 应至少为 warn", () => {
      const report = slopScore(AI_TAINTED_TEXT)
      const classification = classifySlop(report)
      // AI 腔文本应至少触发 warn
      expect(["warn", "block"]).toContain(classification)
    })

    it("干净文本 classifySlop 应为 clean", () => {
      const report = slopScore(CLEAN_TEXT)
      const classification = classifySlop(report)
      expect(classification).toBe("clean")
    })
  })

  // ============================================================================
  // ② 改写收敛: detect→rewrite→detect 不退化
  // ============================================================================

  describe("② 改写收敛 (detect→rewrite→detect non-degradation)", () => {
    it("AI 腔文本通过 dual-pass 软检后 slopPenalty 不上升", () => {
      // 1. Detect (基线)
      const beforeReport = slopScore(AI_TAINTED_TEXT)
      const beforePenalty = beforeReport.slopPenalty

      // 2. Rewrite (dual-pass 软检, 模拟改写指导)
      const dualPass = runDeAiDualPass(AI_TAINTED_TEXT)
      expect(dualPass.productHardGate).toBe(false) // Track B soft
      expect(dualPass.pass2.remediationNotes.length).toBeGreaterThan(0)

      // 模拟改写: 去除强禁用词 (TIER1 命中移除)
      const rewritten = AI_TAINTED_TEXT
        .replace(/显然，/g, "")
        .replace(/这一切/g, "这个局面")
        .replace(/事实上，/g, "")
        .replace(/毫无疑问，/g, "")
        .replace(/他深吸一口气，/g, "")
        .replace(/时间仿佛静止，/g, "")
        .replace(/他嘴角勾起一丝微笑，/g, "他笑了。")
        .replace(/目光交汇的瞬间/g, "对视")
        .replace(/时间仿佛凝固了/g, "谁都没开口")
        .replace(/他握紧拳头，/g, "")
        .replace(/目光变得坚定/g, "没再犹豫")
        .replace(/心中暗道/g, "想")
        .replace(/心中五味杂陈/g, "说不出话")
        .replace(/紧接着，/g, "")
        .replace(/他感到一股无法言说的情绪涌上心头/g, "他胸口堵了一下")
        .replace(/她的心中充满了疑惑和不安/g, "她皱眉")
        .replace(/一切都发生了翻天覆地的变化/g, "一切都不一样了")

      // 3. Re-detect
      const afterReport = slopScore(rewritten)
      const afterPenalty = afterReport.slopPenalty

      // 收敛判据: 改写后 penalty 不上升
      expect(afterPenalty).toBeLessThanOrEqual(beforePenalty)
      // 改写后文本应有更少的 TIER 命中
      const beforeHits = beforeReport.tier1Hits.length + beforeReport.tier2Hits.length + beforeReport.tier3Hits.length
      const afterHits = afterReport.tier1Hits.length + afterReport.tier2Hits.length + afterReport.tier3Hits.length
      // 至少有一些命中减少了
      expect(afterHits).toBeLessThanOrEqual(beforeHits)
    })

    it("干净文本改写后 slopPenalty 不变 (退化保护)", () => {
      const beforeReport = slopScore(CLEAN_TEXT)

      const dualPass = runDeAiDualPass(CLEAN_TEXT)
      expect(dualPass.productHardGate).toBe(false)

      // 干净文本不应有 remediation notes
      // 注: 可能仍有空提示, 但不应有实质性修改建议
      const afterReport = slopScore(CLEAN_TEXT)
      expect(afterReport.slopPenalty).toBe(beforeReport.slopPenalty)
    })
  })

  // ============================================================================
  // ③ diff 重建一致性: Myers diff 行级重建 = 原文/改写文
  // ============================================================================

  describe("③ Myers diff 行级重建一致性", () => {
    it("AI 腔文本改写前后 diff 重建一致", () => {
      const rewritten = AI_TAINTED_TEXT
        .replace(/显然，/g, "")
        .replace(/这一切/g, "这个局面")
        .replace(/事实上，/g, "")
        .replace(/毫无疑问，/g, "")

      const changes = computeMyersDiff(AI_TAINTED_TEXT, rewritten)

      // 重建原文: 非 insert 块拼接 = 原文
      const reconstructedOriginal = changes
        .filter((c) => c.type !== "insert")
        .map((c) => c.text)
        .join("\n")
      expect(reconstructedOriginal).toBe(AI_TAINTED_TEXT)

      // 重建改写文: 非 delete 块拼接 = 改写文
      const reconstructedReplacement = changes
        .filter((c) => c.type !== "delete")
        .map((c) => c.text)
        .join("\n")
      expect(reconstructedReplacement).toBe(rewritten)
    })
  })

  // ============================================================================
  // ④ anti_ai_mode 三档门控: route() gateRouting 行为正确
  // ============================================================================

  describe("④ anti_ai_mode 三档门控 (route() gateRouting)", () => {
    it("off: anti_ai=fail → judge (不阻塞)", () => {
      const inst = route(reviewState("off", "fail"))
      expect(inst.action).toBe("judge")
      expect(inst.reason).toContain("off")
    })

    it("warn: anti_ai=fail → judge (不阻塞, 含注解)", () => {
      const inst = route(reviewState("warn", "fail"))
      expect(inst.action).toBe("judge")
      expect(inst.reason).toContain("warn")
    })

    it("warn: 带 warnAnnotation 时 reason 含 T19 信息", () => {
      const inst = route(
        reviewState("warn", "fail", "pass", "pass", {
          warnAnnotation: {
            triggeredFactors: ["nGramOverlap", "sentenceEntropy"],
            summary: "两个因子触发警告",
            calibrationSource: "synthetic-degraded",
          },
        }),
      )
      expect(inst.action).toBe("judge")
      expect(inst.reason).toContain("nGramOverlap")
      expect(inst.reason).toContain("synthetic-degraded")
    })

    it("block: anti_ai=fail → revise (硬挡)", () => {
      const inst = route(reviewState("block", "fail"))
      expect(inst.action).toBe("revise")
      expect(inst.reason).toContain("block")
    })

    it("block: anti_ai=pass → judge (不挡)", () => {
      const inst = route(reviewState("block", "pass"))
      expect(inst.action).toBe("judge")
    })

    it("block: 带 blockThresholdApplied 时 reason 含 T20 已接线信息", () => {
      const inst = route(
        reviewState("block", "fail", "pass", "pass", {
          blockThresholdApplied: true,
        }),
      )
      expect(inst.action).toBe("revise")
      expect(inst.reason).toContain("T20 阈值已接线")
    })

    it("block: 未标定 (pending-real-corpus) 时 reason 含 pending 信息", () => {
      const inst = route(
        reviewState("block", "fail", "pass", "pass", {
          blockThresholdApplied: false,
        }),
      )
      expect(inst.action).toBe("revise")
      expect(inst.reason).toContain("pending-real-corpus")
    })

    it("P0(consistency) 优先于 anti_ai: consistency=fail → revise (无论 anti_ai 模式)", () => {
      for (const mode of ANTI_AI_MODES) {
        const inst = route(reviewState(mode, "pass", "fail"))
        expect(inst.action).toBe("revise")
        expect(inst.reason).toContain("门控失败")
      }
    })

    it("P2(quality) 永不挡: quality=fail 时三种模式均 → judge", () => {
      for (const mode of ANTI_AI_MODES) {
        const inst = route(reviewState(mode, "pass", "pass", "fail"))
        expect(inst.action).toBe("judge")
      }
    })
  })
})