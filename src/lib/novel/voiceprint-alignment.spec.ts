import { describe, expect, it } from "vitest"
import { extractAuthorFingerprint } from "./adversarial/author-fingerprint"
import {
  checkVoiceprintConvergence,
  DEFAULT_MAX_ITERATIONS,
  DEFAULT_VOICEPRINT_THRESHOLD,
} from "./voiceprint-alignment"

// 基线文本：中等句长、有对话、有标点多样性。
const BASELINE_TEXT =
  "他走进房间，环顾四周。窗外的雨还在下。" +
  "「你来了。」她轻声说，目光躲闪。" +
  "他没有回答，只是把外套挂在了门后。" +
  "沉默像一层薄冰，覆盖在两人之间。" +
  "良久，他才开口：「这件事，我没有办法。」\n\n" +
  "她站起身，椅子在地板上划出一声尖锐的响。" +
  "走廊尽头的灯忽明忽暗，像是某种预兆。"

const baseline = extractAuthorFingerprint(BASELINE_TEXT)

describe("voiceprint-alignment / 51 号 G2", () => {
  it("改写前后一致 → 收敛 accept（driftVsBefore=0）", () => {
    const r = checkVoiceprintConvergence({
      baseline,
      beforeRewrite: BASELINE_TEXT,
      afterRewrite: BASELINE_TEXT,
    })
    expect(r.converged).toBe(true)
    expect(r.recommendation).toBe("accept")
    expect(r.driftVsBefore).toBe(0)
    expect(r.rationale.join(";")).toMatch(/双向收敛/)
  })

  it("轻微改写、风格保留 → 收敛 accept", () => {
    // 仅替换个别词，句式与标点结构基本不变。
    const after = BASELINE_TEXT
      .replace("他走进房间", "他踏入房间")
      .replace("窗外的雨还在下", "窗外的雨尚未停歇")
    const r = checkVoiceprintConvergence({
      baseline,
      beforeRewrite: BASELINE_TEXT,
      afterRewrite: after,
    })
    expect(r.converged).toBe(true)
    expect(r.recommendation).toBe("accept")
  })

  it("过度改写（句式剧变）→ 未收敛 revise", () => {
    // 改写后全是超短句，句长分布剧变，driftVsBefore 超阈值。
    const after = "他进来。看她。没说话。雨在下。灯在闪。她站起。椅子响。沉默。很久。"
    const r = checkVoiceprintConvergence({
      baseline,
      beforeRewrite: BASELINE_TEXT,
      afterRewrite: after,
    })
    expect(r.converged).toBe(false)
    expect(r.recommendation).toBe("revise")
    expect(r.driftVsBefore).toBeGreaterThan(DEFAULT_VOICEPRINT_THRESHOLD)
  })

  it("风格漂移（偏离基线）→ 未收敛 revise", () => {
    // 改写后长段无标点切分，偏离基线的句长/标点密度。
    const after = BASELINE_TEXT.replace(/[。！？；]/g, "，").replace(/「」/g, "")
    const r = checkVoiceprintConvergence({
      baseline,
      beforeRewrite: BASELINE_TEXT,
      afterRewrite: after,
    })
    expect(r.converged).toBe(false)
    expect(r.driftVsBefore).toBeGreaterThan(DEFAULT_VOICEPRINT_THRESHOLD)
    expect(r.rationale.join(";")).toMatch(/过度改写/)
  })

  it("iteration ≥ maxIterations 且未收敛 → manual 转人工", () => {
    const after = "他进来。看她。没说话。"
    const r = checkVoiceprintConvergence({
      baseline,
      beforeRewrite: BASELINE_TEXT,
      afterRewrite: after,
      iteration: DEFAULT_MAX_ITERATIONS,
    })
    expect(r.converged).toBe(false)
    expect(r.recommendation).toBe("manual")
    expect(r.rationale.join(";")).toMatch(/转人工/)
  })

  it("自定义 threshold 放宽 → 原本未收敛变收敛", () => {
    const after = "他进来。看她。没说话。雨在下。灯在闪。"
    const r0 = checkVoiceprintConvergence({
      baseline,
      beforeRewrite: BASELINE_TEXT,
      afterRewrite: after,
    })
    expect(r0.converged).toBe(false)
    const r1 = checkVoiceprintConvergence({
      baseline,
      beforeRewrite: BASELINE_TEXT,
      afterRewrite: after,
      threshold: 1.5, // 放宽到几乎不触发
    })
    expect(r1.converged).toBe(true)
    expect(r1.recommendation).toBe("accept")
  })

  it("空文本边界：baseline/before/after 均空 → drift 0 收敛（不误报）", () => {
    const emptyBaseline = extractAuthorFingerprint("")
    const r = checkVoiceprintConvergence({
      baseline: emptyBaseline,
      beforeRewrite: "",
      afterRewrite: "",
    })
    expect(r.driftVsBefore).toBe(0)
    expect(r.driftVsBaseline).toBe(0)
    expect(r.converged).toBe(true)
    expect(r.recommendation).toBe("accept")
  })
})
