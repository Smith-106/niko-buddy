import { describe, expect, it } from "vitest"
import type { ContextPack } from "./context-engine"
import {
  canonRulesDelta,
  contextPackToPrompt,
  renderCanonRulesBaseForStablePrefix,
  splitCanonRules,
} from "./context-engine-prompt"

/**
 * context-engine-prompt 分支覆盖补齐（Ralph 覆盖率战役）。
 * 只增补：覆盖全量引用 spec 仍未走到的条件分支另一侧，每例均断言可观察行为。
 */
function packOf(extra: Record<string, unknown>): ContextPack {
  return { task: "分支补齐探针任务", ...extra } as unknown as ContextPack
}

describe("context-engine-prompt 分支补齐", () => {
  it("hardInjectEnabled=true 但 pack 无 hardInject 字段 → 该段跳过", () => {
    const out = contextPackToPrompt(packOf({ outline: "大纲探针" }), undefined, {
      hardInjectEnabled: true,
    })
    expect(out).toContain("大纲探针")
    expect(out).not.toContain("硬注入")
  })

  it("formerFacts 无 temporalFacts 时全走失效行；空 object/空 predicate 措辞分支", () => {
    const out = contextPackToPrompt(
      packOf({
        formerFacts: [
          { id: "f1", subject: "林晚", predicate: "持有", object: "长剑", validFrom: 3, validUntil: 5 },
          { id: "f2", subject: "老周", predicate: "位于", object: "", validFrom: 2, validUntil: 4 },
          { id: "f3", subject: "苏念", predicate: "", object: "玉佩", validFrom: 1, validUntil: 2 },
        ],
      }),
      undefined,
      undefined,
    )
    // 无 temporalFacts → 无替代配对，全部走「当前已失效」行
    expect(out).toContain("曾以为「林晚持有 长剑」（当前已失效")
    // 空 object → 只剩 subject
    expect(out).toContain("曾以为「老周」（当前已失效")
    // 空 predicate → subject+object 直连
    expect(out).toContain("曾以为「苏念玉佩」（当前已失效")
  })

  it("formerFacts 命中空 predicate 替代事实 → 配对行省 predicate", () => {
    const out = contextPackToPrompt(
      packOf({
        formerFacts: [
          { id: "f5", subject: "阿南", predicate: "", object: "马车", validFrom: 1, validUntil: 2 },
        ],
        temporalFacts: [
          { id: "t5", subject: "阿南", predicate: "", object: "牛车", validFrom: 1 },
        ],
      }),
      undefined,
      undefined,
    )
    expect(out).toContain("曾以为「阿南马车」→ 现「阿南牛车」")
  })

  it("splitCanonRules 缺 canonRules 字段 → delta 为空串", () => {
    const split = splitCanonRules({ canonRulesBase: "项目基线" } as unknown as ContextPack)
    expect(split.stable).toBe("")
    expect(split.delta).toBe("")
  })

  it("canonRulesDelta base 为 nullish → 返回全文", () => {
    expect(canonRulesDelta("全文规则", undefined as unknown as string)).toBe("全文规则")
  })

  it("renderCanonRulesBaseForStablePrefix 有效前缀 → 稳定段标题+基线", () => {
    const out = renderCanonRulesBaseForStablePrefix({
      canonRules: "项目基线\n本章新增规则",
      canonRulesBase: "项目基线",
    } as unknown as ContextPack)
    expect(out).toContain("## 禁止违背")
    expect(out).toContain("项目基线")
    expect(out).not.toContain("本章新增规则")
  })

  it("renderCanonRulesBaseForStablePrefix 退化（base 非前缀）→ 返回空串", () => {
    const out = renderCanonRulesBaseForStablePrefix({
      canonRules: "本章独立规则",
      canonRulesBase: "毫不相干的基线",
    } as unknown as ContextPack)
    expect(out).toBe("")
  })

  it("excludeCanonRulesBase + base 前缀 → 增量段带时效后缀", () => {
    const out = contextPackToPrompt(
      packOf({ canonRules: "项目基线\n本章新增规则", canonRulesBase: "项目基线" }),
      undefined,
      { excludeCanonRulesBase: true },
    )
    expect(out).toContain("（本章时效增量）")
    expect(out).toContain("本章新增规则")
  })

  it("excludeCanonRulesBase + base 退化 → 完整规则无后缀", () => {
    const out = contextPackToPrompt(
      packOf({ canonRules: "本章独立规则全文", canonRulesBase: "毫不相干的基线" }),
      undefined,
      { excludeCanonRulesBase: true },
    )
    expect(out).toContain("本章独立规则全文")
    expect(out).not.toContain("（本章时效增量）")
  })
})
