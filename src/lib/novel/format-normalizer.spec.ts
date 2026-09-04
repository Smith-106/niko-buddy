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

describe("S1b format-normalizer 边界分支补全", () => {
  it("arabicToChineseDigits: 负数/超界/非整数 → 原样返回; 0 → 零", () => {
    expect(arabicToChineseDigits(-1)).toBe("-1")
    expect(arabicToChineseDigits(10000)).toBe("10000")
    expect(arabicToChineseDigits(3.5)).toBe("3.5")
    expect(arabicToChineseDigits(0)).toBe("零")
  })

  it("arabicToChineseDigits: 百位直读与带零补位 (200→二百 / 205→二百零五)", () => {
    expect(arabicToChineseDigits(200)).toBe("二百")
    expect(arabicToChineseDigits(205)).toBe("二百五")
    expect(arabicToChineseDigits(123)).toBe("一百二十三")
    expect(arabicToChineseDigits(10)).toBe("十")
  })

  it("formatYearToChinese 越界年份原样返回 (999 / 10000)", () => {
    expect(formatYearToChinese(999)).toBe("999")
    expect(formatYearToChinese(10000)).toBe("10000")
  })

  it("formatMonthDayToChinese 非法月份/日期原样返回", () => {
    expect(formatMonthDayToChinese(13, 5)).toBe("13月5日")
    expect(formatMonthDayToChinese(0, 32)).toBe("0月32日")
    expect(formatMonthDayToChinese(2, 30)).toBe("二月三十日")
  })

  it("maxReplacements=0 立即停止 (break 分支)", () => {
    const r = formatNormalize("然而，天快黑了。", { maxReplacements: 0 })
    expect(r.replacementCount).toBe(0)
    expect(r.text).toContain("然而")
  })

  it("自定义替换索引经 options.replacements 生效 (branch 43)", () => {
    const r = formatNormalize("喵喵叫。", {
      replacements: [{ from: "喵喵", to: ["汪汪"] }],
    })
    expect(r.text).toContain("汪汪")
    expect(r.replacementCount).toBeGreaterThan(0)
  })

  it("deleteInstead 条目 (进行) 直接删除；deleteCount 只反映 DELETE_ON_SIGHT 命中", () => {
    const r = formatNormalize("正在进行处理。")
    expect(r.text).not.toContain("进行")
    expect(r.replacementCount).toBeGreaterThan(0)
    const r2 = formatNormalize("值得注意的是，他走了。")
    expect(r2.text).not.toContain("值得注意的是")
    expect(r2.deleteCount).toBeGreaterThan(0)
  })

  it("to 为空的非 delete 条目被跳过 (entry.to[0] ?? '' → continue)", () => {
    const r = formatNormalize("xyz 文本", {
      replacements: [{ from: "xyz", to: [] }],
    })
    expect(r.text).toBe("xyz 文本")
    expect(r.replacementCount).toBe(0)
  })

  it("deleteInstead 条目未命中文本 → match 返回 null 走 ?? [] 计数分支", () => {
    // 文本不含任何删除清单套话: out.match(regex) === null → ?? [] → occurrences 0
    const r = formatNormalize("今天天气很好，我们出发去集市。")
    expect(r.deleteCount).toBe(0)
    expect(r.text).toContain("今天天气很好")
  })

  it("半角感叹号/问号转全角", () => {
    const r = formatNormalize("Hello! 真的吗?")
    expect(r.text).toContain("！")
    expect(r.text).toContain("？")
    expect(r.text).not.toMatch(/[!?]/)
  })

  it("引号容错: 单独出现的闭引号按开引号处理, 连续开引号按闭引号容错", () => {
    // 单独闭引号 → 视为开引号
    expect(formatNormalize("\u201D你好\u201D").text).toBe("「你好」")
    // 连续两个开引号 → 第二个按闭引号容错
    expect(formatNormalize("\u201C\u201C你好\u201D").text).toBe("「」你好「")
    // 单引号版
    expect(formatNormalize("\u2019好的\u2019").text).toBe("『好的』")
    expect(formatNormalize("\u2018\u2018好的\u2019").text).toBe("『』好的『")
  })

  it("连续问号/句号修复 (？？？→？, 。。。→。)", () => {
    const r = formatNormalize("真的吗？？？ 好吧。。。")
    expect(r.text).not.toContain("？？？")
    expect(r.text).not.toContain("。。。")
    expect(r.repeatedPunctFixed).toBeGreaterThan(0)
  })

  it("无改动时不计数 (countDiff 0 路径)", () => {
    const r = formatNormalize("雨停了。")
    expect(r.repeatedPunctFixed).toBe(0)
    expect(r.changed).toBe(false)
  })
})

describe("pangu 中英文自动空格 (可选排版增强)", () => {
  it("enablePangu 默认关闭: 中英混排不加空格", () => {
    const r = formatNormalize("中文English混合")
    expect(r.panguSpaced).toBe(0)
    expect(r.text).toBe("中文English混合")
  })

  it("enablePangu=true: 中英边界插入空格", () => {
    const r = formatNormalize("当你But有用", { enablePangu: true })
    expect(r.panguSpaced).toBeGreaterThan(0)
    expect(r.text).toContain(" ")
  })

  it("enablePangu=true: 纯中文不插入空格", () => {
    const r = formatNormalize("雨停了他走了", { enablePangu: true })
    expect(r.panguSpaced).toBe(0)
    expect(r.text).toBe("雨停了他走了")
  })

  it("enablePangu 与其他规范化叠加 (格式规范化后追加空格)", () => {
    const r = formatNormalize("中文English混合！！！", { enablePangu: true })
    expect(r.text).toContain(" ")
    expect(r.repeatedPunctFixed).toBeGreaterThan(0)
    expect(r.changed).toBe(true)
  })
})

describe("55 W2-8: 全角化 + mojibake 修复 (默认 false)", () => {
  it("enableFullwidth 默认关闭: 半角逗号/句号/冒号保留", () => {
    const r = formatNormalize("他走了, 天黑了. 时间: 3点; 括号(x)")
    expect(r.text).toContain("他走了, 天黑了. 时间: 3点; 括号(x)")
  })

  it("enableFullwidth=true: 半角标点 → 全角 (空格保留)", () => {
    const r = formatNormalize("他走了, 天黑了. 时间: 3点; 括号(x)", { enableFullwidth: true })
    expect(r.text).toContain("他走了， 天黑了。 时间： 3点； 括号（x）")
  })

  it("enableMojibakeFix 默认开启 (2026-09-04 激活): 乱码自动还原", () => {
    const r = formatNormalize("cafÃ© 和 â€œ引号â€")
    expect(r.text).toContain("café")
    expect(r.text).toContain("“引号”")
  })

  it("enableMojibakeFix 默认开启: 正常文本零变更 (A2 行为 additive 保持)", () => {
    const input = "他沿着青石台阶拾级而上，两侧古木参天。"
    const r = formatNormalize(input)
    expect(r.text).toBe(input)
  })

  it("enableMojibakeFix=false 显式关闭: 乱码原样保留 (后向兼容)", () => {
    const r = formatNormalize("cafÃ© 和 â€œ引号â€", { enableMojibakeFix: false })
    expect(r.text).toContain("cafÃ©")
  })

  it("enableMojibakeFix=true: UTF-8 双重编码乱码还原", () => {
    const r = formatNormalize("cafÃ© 和 â€œ引号â€", { enableMojibakeFix: true })
    expect(r.text).toContain("café")
    expect(r.text).toContain("“引号”")
  })

  it("enableMojibakeFix=true: â€™ (U+2019 撇号) 长序列先于 â€ 短序列还原 (55 终验 P2-2)", () => {
    const r = formatNormalize("donâ€™t", { enableMojibakeFix: true })
    expect(r.text).toContain("don’t")
    expect(r.text).not.toContain("â€")
  })

  it("两选项叠加: 全角化 + mojibake 同时生效", () => {
    const r = formatNormalize("cafÃ©, ok.", { enableFullwidth: true, enableMojibakeFix: true })
    expect(r.text).toContain("café， ok。")
  })
})
