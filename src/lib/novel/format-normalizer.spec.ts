import { describe, expect, it } from "vitest"
import { formatNormalize, arabicToChineseDigits, formatYearToChinese, formatMonthDayToChinese, MAX_EXCLAMATION_PER_CHAPTER, REPLACEMENT_WHITELIST } from "./format-normalizer"
import { replacementDictStats, buildReplacementIndex, ALL_REPLACEMENTS } from "./replacement-dict"

describe("S1b replacement-dict 数据完整性 (humanizer-zh absorb)", () => {
  it("字典条目数量符合摘录数据 (40 短语 + 40 词汇 + 28 口语化, 去重后)", () => {
    const stats = replacementDictStats()
    expect(stats.phraseCount).toBe(40)
    expect(stats.wordCount).toBe(40)
    expect(stats.colloquialCount).toBe(28)
    expect(stats.totalCount).toBe(108)
  })

  it("索引按长优先构建 (短语先于短词匹配)", () => {
    const index = buildReplacementIndex()
    const keys = [...index.keys()]
    // "令人印象深刻" 必须排在 "深刻" 前 (若有); 短语整体比词长
    expect(keys[0]!.length).toBeGreaterThanOrEqual(keys[keys.length - 1]!.length)
  })

  it("删除清单条目非空", () => {
    expect(ALL_REPLACEMENTS.filter((e) => e.deleteInstead).length).toBeGreaterThan(0)
  })

  it("无空 from / 无重复 from", () => {
    const froms = ALL_REPLACEMENTS.map((e) => e.from)
    expect(new Set(froms).size).toBe(froms.length)
    for (const e of ALL_REPLACEMENTS) {
      expect(e.from.length).toBeGreaterThan(0)
    }
  })
})

describe("S1b format-normalizer 格式规范化 (humanizer-zh 规则)", () => {
  it("中文数字转换: 1987 → 一九八七年, 3月15日 → 三月十五日", () => {
    expect(arabicToChineseDigits(1987)).toBe("一九八七")
    expect(formatYearToChinese(1987)).toBe("一九八七年")
    expect(formatMonthDayToChinese(3, 15)).toBe("三月十五日")
    expect(formatYearToChinese(2000)).toBe("二零零零年")
    expect(arabicToChineseDigits(15)).toBe("十五")
    expect(arabicToChineseDigits(20)).toBe("二十")
  })

  it("引号统一: 弯引号 → 「」/『』 (成对)", () => {
    const r = formatNormalize('他说：“你好。”她想：‘好的。’')
    expect(r.text).toContain("「你好。」")
    expect(r.text).toContain("『好的。』")
    expect(r.text).not.toContain("“")
  })

  it("省略号与破折号统一", () => {
    const r = formatNormalize("他沉默... 然后--说道。")
    expect(r.text).toContain("……")
    expect(r.text).toContain("——")
    expect(r.text).not.toContain("...")
  })

  it("连续标点禁止 (！！！→！)", () => {
    const r = formatNormalize("太好了！！！")
    expect(r.text).toBe("太好了！")
    expect(r.repeatedPunctFixed).toBeGreaterThan(0)
  })

  it("感叹号每章 ≤5 (超出降级为句号)", () => {
    const text = "一！二！三！四！五！六！七！"
    const r = formatNormalize(text)
    const exclamations = (r.text.match(/！/g) ?? []).length
    expect(exclamations).toBe(MAX_EXCLAMATION_PER_CHAPTER)
    expect(r.exclamationReduced).toBe(2)
  })

  it("年份/月日阿拉伯 → 中文", () => {
    const r = formatNormalize("1987年春天，3月15日那天。")
    expect(r.text).toContain("一九八七年")
    expect(r.text).toContain("三月十五日")
    expect(r.numberNormalized).toBeGreaterThan(0)
  })
})

describe("S1b format-normalizer 替换执行 (draft-first 前置机械层)", () => {
  it("短语替换: 令人印象深刻 → 挺厉害", () => {
    const r = formatNormalize("他的演讲令人印象深刻。")
    expect(r.text).toContain("挺厉害")
    expect(r.replacementCount).toBeGreaterThan(0)
  })

  it("词汇替换: 然而 → 但是", () => {
    const r = formatNormalize("然而，事情并非如此。")
    expect(r.text).toContain("但是")
    expect(r.text).not.toContain("然而")
  })

  it("口语化替换默认关闭 (保留口癖约束)", () => {
    const r = formatNormalize("非常高兴认识你。")
    expect(r.text).toContain("非常") // 默认 enableColloquial=false
    const r2 = formatNormalize("非常高兴认识你。", { enableColloquial: true })
    expect(r2.text).toContain("特别")
  })

  it("AI 套话删除: 众所周知 → 删除", () => {
    const r = formatNormalize("众所周知，事情很简单。", { enableColloquial: true })
    expect(r.text).not.toContain("众所周知")
    expect(r.deleteCount).toBeGreaterThan(0)
  })

  it("删除清单禁用开关", () => {
    const r = formatNormalize("众所周知，事情很简单。", { enableDeleteOnSight: false })
    expect(r.text).toContain("众所周知")
  })

  it("changed 标记: 无改动文本返回 false", () => {
    const clean = "雨停了，阿青把绳子挂上。"
    const r = formatNormalize(clean)
    expect(r.changed).toBe(false)
    expect(r.text).toBe(clean)
  })

  it("替换白名单: 然而→但是 的豁免键存在", () => {
    expect(REPLACEMENT_WHITELIST["但是"]).toContain("然而")
    expect(REPLACEMENT_WHITELIST["忍不住"]).toContain("不由自主")
  })

  it("空文本安全", () => {
    const r = formatNormalize("")
    expect(r.changed).toBe(false)
    expect(r.text).toBe("")
  })
})

describe("S1b 替换优先于惩罚 (与 mechanical-slop 协同)", () => {
  it("替换后的文本不再含原 slop 词 (然而/仿佛/因此)", () => {
    const r = formatNormalize("然而，他仿佛因此陷入沉思。", { enableColloquial: true })
    for (const w of ["然而", "仿佛", "因此"]) {
      expect(r.text).not.toContain(w)
    }
  })
})

describe("TASK-203 字典扩充 + 白名单豁免/替换优先于惩罚回归", () => {
  it("扩充计数与文件头摘录一致 (PHRASE 40 / WORD 40 / COLLOQUIAL 28)", () => {
    const stats = replacementDictStats()
    expect(stats.phraseCount).toBe(40)
    expect(stats.wordCount).toBe(40)
    expect(stats.colloquialCount).toBe(28)
    expect(stats.totalCount).toBe(108)
  })

  it("新增删除清单条目: 需要强调的是 → 删除", () => {
    const r = formatNormalize("需要强调的是，这件事并不难。")
    expect(r.text).not.toContain("需要强调的是")
    expect(r.deleteCount).toBeGreaterThan(0)
  })

  it("新增短语命中替换: 全力以赴 → 拼了命", () => {
    const r = formatNormalize("他全力以赴地准备着。")
    expect(r.text).toContain("拼了命")
    expect(r.text).not.toContain("全力以赴")
    expect(r.replacementCount).toBeGreaterThan(0)
  })

  it("新增词汇命中替换: 逐渐 → 一点点", () => {
    const r = formatNormalize("天色逐渐暗了下来。")
    expect(r.text).toContain("一点点")
    expect(r.text).not.toContain("逐渐")
  })

  it("新增口语化命中替换 (enableColloquial): 高兴 → 乐呵", () => {
    const r = formatNormalize("她高兴地笑了。", { enableColloquial: true })
    expect(r.text).toContain("乐呵")
    expect(r.text).not.toContain("高兴")
  })

  it("新增口语化默认关闭: 高兴 保留 (保留口癖约束)", () => {
    const r = formatNormalize("她高兴地笑了。")
    expect(r.text).toContain("高兴")
  })

  it("白名单豁免: 然而→但是 替换后结果词可经 REPLACEMENT_WHITELIST 豁免 (替换优先于惩罚)", () => {
    const r = formatNormalize("然而，事情并非如此。")
    // 替换优先: 原 TIER2 词 "然而" 已从文本消失, 惩罚层无从计罚
    expect(r.text).not.toContain("然而")
    // 结果词 "但是" 同为 TIER2 — 白名单键存在, de-ai 惩罚层应豁免
    expect(r.text).toContain("但是")
    expect(REPLACEMENT_WHITELIST["但是"]).toContain("然而")
  })

  it("self-conflict 词对 (然而/但是): 默认模式停在白名单词 但是", () => {
    const r = formatNormalize("然而，天快黑了。")
    expect(r.text).toContain("但是")
    expect(r.text).not.toContain("然而")
    expect(REPLACEMENT_WHITELIST["但是"]).toContain("然而")
  })

  it("self-conflict 词对 (然而/但是): 口语化开启时链式收敛到 可/不过, 原词与中间词均消失", () => {
    const r = formatNormalize("然而，天快黑了。", { enableColloquial: true })
    expect(r.text).not.toContain("然而")
    expect(r.text).not.toContain("但是")
    expect(r.text).toMatch(/可|不过/)
  })
})
