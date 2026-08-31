import { describe, expect, it } from "vitest"
import {
  bookRulesToPromptFragment,
  EMPTY_BOOK_RULES,
  validateAgainstBookRules,
  type BookRules,
} from "./book-rules"

const RULES: BookRules = {
  version: "1.0",
  protagonist: {
    name: "林澈",
    personalityLock: ["外冷内热"],
    behavioralConstraints: ["不杀降者"],
  },
  genreLock: { primary: "都市刑侦", forbidden: ["修仙", "斗气"] },
  eraConstraints: {
    enabled: true,
    period: "2010 年代",
    region: "华东",
    anachronismTerms: ["智能手机", "扫码支付"],
  },
  prohibitions: ["主角死亡", "涉及真实案件"],
  allowedDeviations: ["预言之梦"],
  fanficMode: undefined,
}

describe("book-rules（吸收自 inkos models/book-rules 治理约束模式）", () => {
  it("空规则 → comply 无 findings", () => {
    const result = validateAgainstBookRules(EMPTY_BOOK_RULES, "任意文本")
    expect(result).toEqual({ findings: [], verdict: "comply" })
  })

  it("命中禁止项 → error → violate", () => {
    const result = validateAgainstBookRules(RULES, "本章主角死亡，涉及真实案件。")
    expect(result.verdict).toBe("violate")
    expect(result.findings.filter((f) => f.code === "prohibition_hit")).toHaveLength(2)
    expect(result.findings.every((f) => f.severity === "error")).toBe(true)
  })

  it("命中题材锁禁止元素 → error", () => {
    const result = validateAgainstBookRules(RULES, "他体内斗气翻涌。")
    expect(result.verdict).toBe("violate")
    expect(result.findings[0].code).toBe("genre_forbidden_hit")
    expect(result.findings[0].message).toContain("都市刑侦")
  })

  it("命中时代穿越元素 → warn（不单独构成 violate）", () => {
    const result = validateAgainstBookRules(RULES, "他掏出智能手机扫码支付。")
    expect(result.findings.every((f) => f.code === "era_anachronism_hit" && f.severity === "warn")).toBe(true)
    expect(result.verdict).toBe("comply")
  })

  it("allowedDeviations 白名单豁免：命中白名单词的禁止项不报", () => {
    // 禁止项「预言之梦不在 prohibitions 里」——改为 prohibitions 含「预知」，
    // 白名单「预言之梦」包含子串命中场景
    const rules: BookRules = {
      ...RULES,
      prohibitions: ["预知"],
      allowedDeviations: ["预言之梦"],
    }
    const result = validateAgainstBookRules(rules, "她做了一个预言之梦。")
    expect(result.findings).toEqual([])
    expect(result.verdict).toBe("comply")
  })

  it("非白名单命中仍报（白名单不扩大豁免）", () => {
    const rules: BookRules = {
      ...RULES,
      prohibitions: ["预知"],
      allowedDeviations: ["预言之梦"],
    }
    const result = validateAgainstBookRules(rules, "他预知了车祸。")
    expect(result.verdict).toBe("violate")
  })

  it("确定性：同输入双跑全等", () => {
    const text = "主角死亡，斗气，智能手机"
    expect(JSON.stringify(validateAgainstBookRules(RULES, text))).toBe(
      JSON.stringify(validateAgainstBookRules(RULES, text)),
    )
  })

  it("bookRulesToPromptFragment 渲染全部规则段；空规则返回空串", () => {
    const frag = bookRulesToPromptFragment(RULES)
    expect(frag).toContain("全书禁止项")
    expect(frag).toContain("题材锁：都市刑侦")
    expect(frag).toContain("林澈 性格锁：外冷内热")
    expect(frag).toContain("时代约束")
    expect(bookRulesToPromptFragment(EMPTY_BOOK_RULES)).toBe("")
  })
})
