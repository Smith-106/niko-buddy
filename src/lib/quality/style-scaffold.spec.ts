/**
 * style-scaffold.spec.ts — v2.6.12 W4 验收
 *
 * 覆盖：风格签名抽取 / 软约束注入（可选+可关闭）
 */
import { describe, expect, it } from "vitest"
import { buildScaffold, extractStyleSignature } from "./style-scaffold"

describe("W4 风格脚手架 — 静态签名", () => {
  it("签名抽取（句长/对话密度/节奏）", () => {
    const sig = extractStyleSignature([
      { sentenceLength: 20, dialogue: true, fastPaced: true },
      { sentenceLength: 30, dialogue: false, fastPaced: false },
      { sentenceLength: 10, dialogue: true, fastPaced: true },
    ])
    expect(sig.avgSentenceLength).toBe(20)
    expect(sig.dialogueDensity).toBeCloseTo(2 / 3)
    expect(sig.pacing).toBeCloseTo(2 / 3)
  })

  it("空样本安全", () => {
    expect(extractStyleSignature([]).avgSentenceLength).toBe(0)
  })
})

describe("W4 风格脚手架 — 软约束注入（可选+可关闭）", () => {
  it("enabled=false 零注入（防同质化）", () => {
    const sig = extractStyleSignature([{ sentenceLength: 20, dialogue: true, fastPaced: true }])
    expect(buildScaffold(sig, false).enabled).toBe(false)
    expect(buildScaffold(sig, true).enabled).toBe(true)
  })
})
