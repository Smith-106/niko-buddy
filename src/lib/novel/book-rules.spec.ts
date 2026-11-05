import { describe, expect, it } from "vitest"
import {
  bookRulesToPromptFragment,
  bookRulesWithAuDeviations,
  EMPTY_BOOK_RULES,
  validateAgainstBookRules,
  validateFanficChapter,
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


describe("W1 补强：validateFanficChapter 同人四模式", () => {
  const base: BookRules = {
    version: "1.0",
    protagonist: {
      name: "林澈",
      personalityLock: ["外冷内热"],
      behavioralConstraints: ["不杀降者"],
    },
    prohibitions: [],
    allowedDeviations: [],
  }

  it("canon 模式：正典人设锁被否定改写 → fanfic_canon_lock error", () => {
    const rules: BookRules = { ...base, fanficMode: "canon" }
    const r = validateFanficChapter(rules, "林澈外冷内热的面具碎了，他不再外冷内热。", ["林澈"])
    expect(r.verdict).toBe("violate")
    expect(r.findings.some((f) => f.code === "fanfic_canon_lock" && f.severity === "error")).toBe(true)
  })

  it("canon 模式：无人设否定改写 → comply", () => {
    const rules: BookRules = { ...base, fanficMode: "canon" }
    const r = validateFanficChapter(rules, "林澈外冷内热，一言不发。", ["林澈"])
    expect(r.verdict).toBe("comply")
    expect(r.findings).toEqual([])
  })

  it("ooc 模式：命中性格锁且无标记 → error；有标记 → comply", () => {
    const rules: BookRules = { ...base, fanficMode: "ooc" }
    const bad = validateFanficChapter(rules, "林澈外冷内热。", ["林澈"])
    expect(bad.verdict).toBe("violate")
    expect(bad.findings.some((f) => f.code === "fanfic_ooc_unmarked")).toBe(true)
    const ok = validateFanficChapter(rules, "（OOC）林澈外冷内热。", ["林澈"])
    expect(ok.verdict).toBe("comply")
    expect(ok.findings.some((f) => f.code === "fanfic_ooc_unmarked")).toBe(false)
  })

  it("cp 模式：未配置 pairing 时只跑词面基线（不抛错）", () => {
    const rules: BookRules = { ...base, fanficMode: "cp" }
    const r = validateFanficChapter(rules, "林澈与苏遥并肩而立。", ["林澈", "苏遥"])
    expect(r.verdict).toBe("comply")
  })

  it("au 模式：词面基线不受影响", () => {
    const rules: BookRules = { ...base, fanficMode: "au" }
    const r = validateFanficChapter(rules, "林澈外冷内热。", ["林澈"])
    expect(r.verdict).toBe("comply")
  })

  it("无 fanficMode 时等价词面基线（policy 默认 canon 但无 protagonist 断言）", () => {
    const rules: BookRules = { ...base, fanficMode: undefined, prohibitions: ["主角死亡"] }
    const r = validateFanficChapter(rules, "本章主角死亡。", ["林澈"])
    expect(r.verdict).toBe("violate")
    expect(r.findings.some((f) => f.code === "prohibition_hit")).toBe(true)
  })
})

describe("W1 补强：bookRulesWithAuDeviations 白名单并入", () => {
  it("非 au 模式原样返回同一引用", () => {
    const rules: BookRules = { version: "1.0", prohibitions: [], allowedDeviations: [] }
    expect(bookRulesWithAuDeviations(rules)).toBe(rules)
  })

  it("au 模式合并后返回新对象（不得修改入参）", () => {
    const rules: BookRules = { version: "1.0", prohibitions: [], allowedDeviations: ["预言之梦"], fanficMode: "au" }
    const merged = bookRulesWithAuDeviations(rules)
    expect(merged).not.toBe(rules)
    expect(merged.fanficMode).toBe("au")
    expect(merged.allowedDeviations).toContain("预言之梦")
    expect(rules.allowedDeviations).toEqual(["预言之梦"])
  })
})

describe("W1 补强：bookRulesToPromptFragment 同人四模式渲染", () => {
  const base: BookRules = { version: "1.0", prohibitions: [], allowedDeviations: [] }

  it("canon/au/ooc/cp 各渲染对应段落", () => {
    const canon = bookRulesToPromptFragment({ ...base, fanficMode: "canon" })
    expect(canon).toContain("同人模式：canon")
    expect(canon).toContain("正典名册锁")
    expect(canon).toContain("全部既有角色")
    const au = bookRulesToPromptFragment({ ...base, fanficMode: "au" })
    expect(au).toContain("同人模式：au")
    expect(au).toContain("AU 设定分叉")
    const ooc = bookRulesToPromptFragment({ ...base, fanficMode: "ooc" })
    expect(ooc).toContain("OOC 必须显式标注")
    expect(ooc).toContain("(OOC)")
    const cp = bookRulesToPromptFragment({ ...base, fanficMode: "cp" })
    expect(cp).toContain("CP 配对双方须同时出现")
  })
})

describe("覆盖战役补齐：空串约束词", () => {
  it("空串 prohibitions 永不命中（countOccurrences 空词守卫）", () => {
    const rules: BookRules = { version: "1.0", prohibitions: [""], allowedDeviations: [] }
    const result = validateAgainstBookRules(rules, "任意正文都不会被空串污染")
    expect(result).toEqual({ findings: [], verdict: "comply" })
  })
})

describe("book-rules 分支覆盖补齐：空值回退与空集合渲染", () => {
  it("时代约束无 period/region：命中消息用 未标注；片段渲染空回退", () => {
    const rules: BookRules = {
      version: "1.0",
      prohibitions: [],
      allowedDeviations: [],
      eraConstraints: { enabled: true, anachronismTerms: ["电话"] },
    }
    const result = validateAgainstBookRules(rules, "他拿起电话拨号。")
    const hit = result.findings.find((f) => f.code === "era_anachronism_hit")
    expect(hit).toBeTruthy()
    expect(hit!.severity).toBe("warn")
    expect(hit!.message).toContain("未标注")
    expect(result.verdict).toBe("comply")
    const frag = bookRulesToPromptFragment(rules)
    expect(frag).toContain("时代约束：；禁出现：电话")
  })

  it("题材锁 forbidden 为空 → 三元 else（无禁止元素段）", () => {
    const rules: BookRules = {
      version: "1.0",
      prohibitions: [],
      allowedDeviations: [],
      genreLock: { primary: "都市刑侦", forbidden: [] },
    }
    const frag = bookRulesToPromptFragment(rules)
    expect(frag).toContain("题材锁：都市刑侦")
    expect(frag).not.toContain("禁止元素")
  })

  it("主角无性格锁 → personalityLock if else（只渲染行为约束）", () => {
    const rules: BookRules = {
      version: "1.0",
      prohibitions: [],
      allowedDeviations: [],
      protagonist: { name: "林澈", personalityLock: [], behavioralConstraints: ["不杀降者"] },
    }
    const frag = bookRulesToPromptFragment(rules)
    expect(frag).not.toContain("性格锁")
    expect(frag).toContain("林澈 行为约束：不杀降者")
  })
})
