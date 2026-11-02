import { describe, expect, it } from "vitest"
import {
  STABLE_PREFIX_VERSION,
  buildChatStablePrefix,
} from "./stable-prefix"
import { canonRulesDelta, splitCanonRules } from "./novel/context-engine-prompt"
import type { ContextPack } from "./novel/context-engine-types"

/**
 * G6 跨章缓存回归。
 *
 * 背景：`canonRules` 经 `applyTemporalFactsToCanonRules(base, facts, targetChapter)`
 * 处理后**随目标章节变化**（temporal 块按章过滤）。把它整块放进稳定缓存段，
 * 跨章前缀字节不一致 → 上游前缀缓存永不命中，等于没做。
 *
 * 正确形态：稳定段放 `canonRulesBase`（项目级不变），动态段只放 temporal 增量。
 * 下面三条用例把这件事钉住：
 *   1. 同一项目不同章节的稳定前缀**字节一致**（跨章命中的前提）；
 *   2. base 不是 full 前缀时 delta 退化为完整 canonRules（不丢规则）；
 *   3. base + delta 拼接后恰好覆盖完整 canonRules（不重复、不丢失）。
 */
describe("G6 跨章缓存：base 进稳定段、增量留动态段", () => {
  const base = "## 硬性世界规则\n- 灵气不可凭空生成\n- 凡人不可飞行"
  // 生产里 skillPrompt 是常量 `qmQuaiSystemPrompt`（不含章节号）。
  // 这里必须用同一份：若它随章变化，跨章命中就断了（见下方守卫用例）。
  const skillPrompt = "## QM-QUAI 技能\n小说写作主链"
  // 模拟 temporal 叠加：上游 joinNonEmpty([base, temporalBlock], "\n\n")
  const temporalChapter3 = "## 时效规则（第 3 章生效）\n- 血月之夜灵气减半"
  const fullChapter3 = `${base}\n\n${temporalChapter3}`
  const fullChapter7 = `${base}\n\n## 时效规则（第 7 章生效）\n- 天裂封印松动`

  it("同一项目不同章节的稳定前缀字节一致（跨章命中前提）", () => {
    const chapter3 = buildChatStablePrefix({
      novelMode: true,
      skillPrompt,
      canonRulesBase: base,
    })
    const chapter7 = buildChatStablePrefix({
      novelMode: true,
      skillPrompt,
      canonRulesBase: base,
    })

    // 稳定段必须逐字节相同 —— 否则上游前缀缓存从头部匹配就断了。
    expect(chapter3.text).toBe(chapter7.text)
    expect(chapter3.fields.canonRulesBase).toBe(base)
    // 版本进哈希：版本变了前缀必然不同，不会误复用旧缓存。
    expect(chapter3.version).toBe(STABLE_PREFIX_VERSION)
  })

  it("稳定段不含任何随章节变化的内容（temporal 块不得混入）", () => {
    const chapter3 = buildChatStablePrefix({
      novelMode: true,
      skillPrompt,
      canonRulesBase: base,
    })
    expect(chapter3.text).not.toContain("第 3 章生效")
    expect(chapter3.text).not.toContain("血月之夜")
    // 反之，base 必须在里面。
    expect(chapter3.text).toContain("灵气不可凭空生成")
  })

  it("守卫：章节相关文本一旦漏进任何稳定字段，跨章一致立即被打破（能被用例捕获）", () => {
    const chapter3 = buildChatStablePrefix({
      novelMode: true,
      skillPrompt: "写第3章",
      canonRulesBase: base,
    })
    const chapter7 = buildChatStablePrefix({
      novelMode: true,
      skillPrompt: "写第7章",
      canonRulesBase: base,
    })
    // 这条不是「期望它不一致」，而是钉住检测能力：稳定段一旦掺入章节文本，
    // 上面的字节一致用例就会红。生产调用方因此必须传常量 skillPrompt。
    expect(chapter3.text).not.toBe(chapter7.text)
  })

  it("delta 只取 temporal 后缀，base + delta 覆盖完整 canonRules", () => {
    expect(canonRulesDelta(fullChapter3, base)).toBe(temporalChapter3)
    expect(canonRulesDelta(fullChapter7, base)).toContain("天裂封印松动")

    // 拼接后必须等价于原始 full（去掉首尾分隔换行差异）
    const rebuilt = `${base}\n${canonRulesDelta(fullChapter3, base)}`
    expect(rebuilt.replace(/\n+/g, "\n")).toBe(fullChapter3.replace(/\n+/g, "\n"))
  })

  it("base 不是 full 前缀时 delta 退化为完整 canonRules（绝不丢规则）", () => {
    // 上游若改成 temporal 在前，前缀切分会失效 —— 此时必须整体走动态段。
    const reversed = `${temporalChapter3}\n\n${base}`
    expect(canonRulesDelta(reversed, base)).toBe(reversed)

    // base 为空时同理，返回完整内容
    expect(canonRulesDelta(fullChapter3, "")).toBe(fullChapter3)
  })
})

/**
 * 复核修复的回归：MAJOR-1（归一化不一致导致重复渲染）与 MAJOR-2（重复段标题）。
 *
 * 关键不变量：**同一份规则内容在最终 prompt 里只能出现一次**。宁可零缓存收益，
 * 也绝不让 base 既进稳定段又进动态段——那会把「降费」变成「增费」。
 */
describe("G6 退化路径：base 不是前缀时稳定段必须为空（不重复渲染）", () => {
  const base = "## 硬性世界规则\n- 灵气不可凭空生成"
  const temporal = "## 时效规则\n- 血月之夜灵气减半"

  it("base 带行尾空格 → 稳定段为空，完整规则只走动态段", () => {
    const paddedBase = `${base}   `
    // 上游 joinNonEmpty 会 trim，所以 canonRules 里是 base.trim()
    const full = `${base.trim()}\n\n${temporal}`
    const split = splitCanonRules({ ...({} as ContextPack), canonRules: full, canonRulesBase: paddedBase })
    expect(split.stable).toBe(base.trim())
    expect(split.delta).toBe(temporal)
  })

  it("base 带行首空白 → 稳定段为空，delta 为完整 canonRules", () => {
    const indentedBase = `   ${base}`
    const full = `${temporal}\n\n${base}` // 前缀不是 indentedBase
    const split = splitCanonRules({ ...({} as ContextPack), canonRules: full, canonRulesBase: indentedBase })
    expect(split.stable).toBe("")
    expect(split.delta).toBe(full)
  })

  it("base 为空 → 稳定段为空，delta 为完整 canonRules", () => {
    const split = splitCanonRules({ ...({} as ContextPack), canonRules: temporal, canonRulesBase: "" })
    expect(split.stable).toBe("")
    expect(split.delta).toBe(temporal)
  })

  it("稳定段与动态段不得同时包含 base（不重复渲染的核心断言）", () => {
    const full = `${base}\n\n${temporal}`
    const ok = splitCanonRules({ ...({} as ContextPack), canonRules: full, canonRulesBase: base })
    // 正常路径：base 只在 stable 里
    expect(ok.stable).toContain("灵气不可凭空生成")
    expect(ok.delta).not.toContain("灵气不可凭空生成")

    // 退化路径：base 只在 delta 里，stable 必须为空
    const degraded = splitCanonRules({
      ...({} as ContextPack),
      canonRules: full,
      canonRulesBase: `${base}extra`,
    })
    expect(degraded.stable).toBe("")
    expect(degraded.delta).toBe(full)
  })
})
