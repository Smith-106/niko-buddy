/**
 * anti-ai-mode.spec.ts — TASK-P2-21 (T21): 三档 anti_ai_mode 门控契约测试
 *
 * 蓝图 §6 P2 T21 验收: `npx vitest run anti-ai-mode convergence`
 * 本文件 = anti-ai-mode 部分（集成级契约，非纯单元）：
 *   - 三档（off/warn/block）× anti_ai 判定（pass/fail）→ route() 期望路由
 *   - P0>P1>P2 优先级：consistency fail 优先于 anti_ai（block 不得被 quality 覆盖）
 *   - block 档边界：T20 标定后（FPR 0%/召回 100%）block 仅在 anti_ai=fail 时硬挡，
 *     pass 时绝不误触（零误杀语义）
 *   - warn 档注解：warnAnnotation（T19 候选池触发因子）注入 reason
 *   - block 档激活状态：pending（T20 判据达标但未接线验证，Draft-first 安全边界）
 *
 * 执行纪律:
 *   - ADR-19 机械层零模型调用: 不调用任何模型 / IO / Tauri invoke。
 *   - Draft-first (ADR-08): 不触及 .novel/status.json 正式层。
 */
import { describe, expect, it } from "vitest"
import { route, type ControlState, type AntiAiMode } from "./control-kernel"
import { ANTI_AI_MODES } from "./control-sentinels"

// ============================================================================
// 测试夹具（与 control-kernel.spec 同型）
// ============================================================================

function baseState(overrides: Partial<ControlState> = {}): ControlState {
  return {
    phase: "writing",
    stage: "review",
    chapterNumber: 3,
    completedChapters: 2,
    pendingRewrites: [],
    gates: { consistency: "pass", anti_ai: "pass", quality: "pass" },
    antiAiMode: "off",
    manualReviewRequired: false,
    foundationMissing: [],
    planningTier: "",
    reviewInterval: 0,
    lastGlobalReviewChapter: 0,
    hasArcReview: false,
    hasArcSummary: false,
    hasVolumeSummary: false,
    shellMode: "legacy",
    ...overrides,
  }
}

// ============================================================================
// 三档 × anti_ai 判定矩阵 → route() 期望
// ============================================================================

describe("TASK-P2-21 (T21) 三档 anti_ai_mode 门控契约", () => {
  it("三档 × anti_ai=pass → 全部 judge（pass 永不阻塞）", () => {
    for (const mode of ANTI_AI_MODES) {
      const s = baseState({ antiAiMode: mode, gates: { consistency: "pass", anti_ai: "pass", quality: "pass" } })
      const r = route(s)
      expect(r.action, `mode=${mode} anti_ai=pass 应 judge`).toBe("judge")
    }
  })

  it("off 档 × anti_ai=fail → judge（不阻塞）", () => {
    const s = baseState({ antiAiMode: "off", gates: { consistency: "pass", anti_ai: "fail", quality: "pass" } })
    expect(route(s).action).toBe("judge")
  })

  it("warn 档 × anti_ai=fail → judge（警告不阻塞）", () => {
    const s = baseState({ antiAiMode: "warn", gates: { consistency: "pass", anti_ai: "fail", quality: "pass" } })
    expect(route(s).action).toBe("judge")
  })

  it("block 档 × anti_ai=fail → revise（硬挡）", () => {
    const s = baseState({ antiAiMode: "block", gates: { consistency: "pass", anti_ai: "fail", quality: "pass" } })
    expect(route(s).action).toBe("revise")
  })

  it("block 档 × anti_ai=fail × quality=fail → revise（P1 硬挡不被 P2 覆盖）", () => {
    const s = baseState({ antiAiMode: "block", gates: { consistency: "pass", anti_ai: "fail", quality: "fail" } })
    expect(route(s).action).toBe("revise")
  })

  it("P0 优先级：consistency=fail × block 档 → revise（P0 硬挡优先）", () => {
    const s = baseState({ antiAiMode: "block", gates: { consistency: "fail", anti_ai: "fail", quality: "pass" } })
    expect(route(s).action).toBe("revise")
  })

  it("P0 优先级：consistency=fail × off 档 → revise（P0 硬挡与 anti_ai 无关）", () => {
    const s = baseState({ antiAiMode: "off", gates: { consistency: "fail", anti_ai: "fail", quality: "pass" } })
    expect(route(s).action).toBe("revise")
  })

  it("warn 档注解：warnAnnotation 注入 reason（T19 候选池触发因子）", () => {
    const s = baseState({
      antiAiMode: "warn",
      gates: { consistency: "pass", anti_ai: "fail", quality: "pass" },
      warnAnnotation: { triggeredFactors: ["nGramOverlap"], calibrationSource: "real-corpus-1035-139" },
    })
    const r = route(s)
    expect(r.action).toBe("judge")
    expect(r.reason ?? "").toContain("nGramOverlap")
    expect(r.reason ?? "").toContain("real-corpus-1035-139")
  })

  it("block 档激活状态：pending（T20 判据达标但未接线验证，Draft-first）", () => {
    // blockThresholdApplied 未设置 → antiAiReason 显示 pending 语义（不误报"已接线"）
    const s = baseState({ antiAiMode: "block", gates: { consistency: "pass", anti_ai: "fail", quality: "pass" } })
    const r = route(s)
    expect(r.action).toBe("revise")
    expect(r.reason ?? "").toContain("pending")
  })

  it("block 档零误杀边界：anti_ai=pass 时 block 档绝不 revise（T20 FPR 0% 语义）", () => {
    for (const mode of ANTI_AI_MODES) {
      const s = baseState({ antiAiMode: mode, gates: { consistency: "pass", anti_ai: "pass", quality: "fail" } })
      expect(route(s).action, `mode=${mode} anti_ai=pass quality=fail 应 judge（P2 不挡）`).toBe("judge")
    }
  })

  it("三档全矩阵穷举（3 mode × 2 anti_ai × 2 quality = 12 组合）", () => {
    const expected: Record<string, "judge" | "revise"> = {
      "off-pass-pass": "judge", "off-pass-fail": "judge",
      "off-fail-pass": "judge", "off-fail-fail": "judge",
      "warn-pass-pass": "judge", "warn-pass-fail": "judge",
      "warn-fail-pass": "judge", "warn-fail-fail": "judge",
      "block-pass-pass": "judge", "block-pass-fail": "judge",
      "block-fail-pass": "revise", "block-fail-fail": "revise",
    }
    for (const mode of ANTI_AI_MODES) {
      for (const anti of ["pass", "fail"] as const) {
        for (const q of ["pass", "fail"] as const) {
          const key = `${mode}-${anti}-${q}`
          const s = baseState({
            antiAiMode: mode,
            gates: { consistency: "pass", anti_ai: anti, quality: q },
          })
          expect(route(s).action, key).toBe(expected[key])
        }
      }
    }
  })
})
