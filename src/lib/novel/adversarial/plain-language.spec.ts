/**
 * plain-language.spec.ts — v2.6.5 D3 验收
 *
 * 覆盖：术语→白话映射覆盖 / stub 图例 / 重标定对照表（纯函数可重放）
 */
import { describe, expect, it } from "vitest"
import { STUB_LEGEND, assertCoverage, buildRecalibrationSheet, plainLanguage } from "./plain-language"

describe("D3 术语→白话映射", () => {
  it("核心术语有白话（加注不删术语——双读）", () => {
    expect(plainLanguage("LLR")).toContain("AI 味分值")
    expect(plainLanguage("对抗回归集")).toContain("作弊样本库")
    expect(plainLanguage("原笔指纹")).toContain("笔迹 DNA")
    expect(plainLanguage("漂移阈值")).toContain("跑偏红线")
    expect(plainLanguage("Consistency(P0)")).toContain("一致性硬门")
  })

  it("未收录术语原样返回", () => {
    expect(plainLanguage("未知术语xyz")).toBe("未知术语xyz")
  })

  it("覆盖断言：全部维度术语都有白话（无缺失）", () => {
    const terms = ["LLR", "对抗回归集", "分层召回", "原笔指纹", "漂移阈值", "ContextPack", "六维 overall", "thril", "pacing", "pull", "Consistency(P0)", "Anti-AI(P1)", "Quality(P2)", "重标定", "漂移幅度", "因子链", "基线版本", "责任判官", "L9 复验"]
    expect(assertCoverage(terms)).toHaveLength(0)
  })
})

describe("D3 stub 图例", () => {
  it("图例明确：占位非缺陷 + 零阳性政策", () => {
    expect(STUB_LEGEND.marker).toBe("[STUB]")
    expect(STUB_LEGEND.meaning).toContain("非缺陷")
    expect(STUB_LEGEND.policy).toContain("不产出任何阳性")
  })
})

describe("D3 重标定对照表 — 纯函数可重放", () => {
  it("对照表含新旧对照 key + 漂移幅度", () => {
    const row = buildRecalibrationSheet("ch1", { thril: 8.0, pacing: 8.5 }, { thril: 9.0, pacing: 8.5 }, "judge-A")
    expect(row.chapterId).toBe("ch1")
    expect(row.scoreBefore.thril).toBe(8.0)
    expect(row.scoreAfter.thril).toBe(9.0)
    expect(row.driftMagnitude.thril).toBeCloseTo(1.0, 10)
    expect(row.driftMagnitude.pacing).toBe(0)
    expect(row.judgeId).toBe("judge-A")
    expect(row.editorSign).toBeNull() // 签字位留白
  })

  it("纯函数确定性：同入同出", () => {
    const a = buildRecalibrationSheet("ch1", { thril: 8.0 }, { thril: 9.0 }, "judge-A")
    const b = buildRecalibrationSheet("ch1", { thril: 8.0 }, { thril: 9.0 }, "judge-A")
    expect(a).toEqual(b)
  })
})
