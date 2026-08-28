/**
 * cross-lang-f1.spec.ts — v2.7.4 跨语言泛化验收
 *
 * 覆盖：F1 ≥ 源域基线×95% / 基线版本锁定
 */
import { describe, expect, it } from "vitest"
import { CROSS_LANG_F1_RATIO, evaluateCrossLang } from "./cross-lang-f1"

describe("跨语言 F1 — 相对阈值", () => {
  it("目标域 F1 ≥ 基线×95% → 达标", () => {
    const r = evaluateCrossLang(0.9, "v2.7.3-7006868f", [
      { lang: "en", f1: 0.88 },
      { lang: "ja", f1: 0.9 },
    ])
    expect(r.langs.every((l) => l.passed)).toBe(true)
    expect(r.passed).toBe(true)
    expect(CROSS_LANG_F1_RATIO).toBe(0.95)
  })

  it("目标域 F1 低于阈值 → 不达标", () => {
    const r = evaluateCrossLang(0.9, "v2.7.3-7006868f", [{ lang: "en", f1: 0.8 }])
    expect(r.langs[0].passed).toBe(false)
    expect(r.passed).toBe(false)
  })

  it("基线版本未锁定 → 不达标", () => {
    const r = evaluateCrossLang(0.9, "", [{ lang: "en", f1: 0.9 }])
    expect(r.passed).toBe(false)
  })
})
