import { describe, expect, it } from "vitest"
import {
  BUILTIN_SENSITIVE_RULES,
  gatePublishing,
  mergeSensitiveRules,
  scanSensitiveWords,
  type SensitiveWordRule,
} from "./sensitive-words"

const RULES: SensitiveWordRule[] = [
  { term: "违禁甲", action: "ban", category: "illegal" },
  { term: "敏感乙", action: "warn", category: "violence" },
  { term: "留痕丙", action: "review", category: "adult" },
]

describe("sensitive-words（吸收累积残余：敏感词分级检测模式）", () => {
  it("三级命中聚合：计数正确且保持规则声明序", () => {
    const result = scanSensitiveWords("提到敏感乙两次敏感乙，还有留痕丙。", RULES)
    expect(result.hits.map((h) => h.term)).toEqual(["敏感乙", "留痕丙"])
    expect(result.hits[0].count).toBe(2)
    expect(result.verdict).toBe("needsReview")
  })

  it("ban 级命中 → blocked；clean → clear", () => {
    expect(scanSensitiveWords("出现违禁甲了", RULES).verdict).toBe("blocked")
    expect(scanSensitiveWords("完全干净的内容", RULES).verdict).toBe("clear")
    expect(scanSensitiveWords("", RULES)).toEqual({ hits: [], verdict: "clear" })
  })

  it("gatePublishing 语义：blocked 拒绝 / needsReview 放行留痕 / clear 直接放行", () => {
    const blocked = gatePublishing(scanSensitiveWords("违禁甲", RULES))
    expect(blocked.allowed).toBe(false)
    const review = gatePublishing(scanSensitiveWords("敏感乙", RULES))
    expect(review.allowed).toBe(true)
    expect(review.requirement).toContain("复核")
    const clear = gatePublishing(scanSensitiveWords("干净", RULES))
    expect(clear).toEqual({ allowed: true })
  })

  it("mergeSensitiveRules：项目词表覆盖内置同名 term，其余追加", () => {
    const project: SensitiveWordRule[] = [
      { term: "TODO_EXPIRED_CERT", action: "review", category: "custom" },
      { term: "项目词", action: "ban", category: "custom" },
    ]
    const merged = mergeSensitiveRules(BUILTIN_SENSITIVE_RULES, project)
    expect(merged.find((r) => r.term === "TODO_EXPIRED_CERT")?.action).toBe("review")
    expect(merged.filter((r) => r.term === "TODO_EXPIRED_CERT")).toHaveLength(1)
    expect(merged.some((r) => r.term === "项目词")).toBe(true)
  })

  it("确定性：同输入双跑全等", () => {
    expect(JSON.stringify(scanSensitiveWords("敏感乙 留痕丙", RULES))).toBe(
      JSON.stringify(scanSensitiveWords("敏感乙 留痕丙", RULES)),
    )
  })
})
