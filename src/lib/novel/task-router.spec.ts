import { describe, expect, it } from "vitest"
import { routeTask, buildTaskDirective } from "./task-router"

describe("routeTask chapter generation", () => {
  it("routes continue-next-chapter requests into chapter generation flow", () => {
    const route = routeTask("继续生成下一章")

    expect(route.intent).toBe("continue_chapter")
  })

  it("routes the continue-next-chapter button prompt into chapter generation flow", () => {
    const route = routeTask("请根据当前小说上下文、记忆库、最新章节结尾、下一章推进建议和章纲，继续生成下一章正文。")

    expect(route.intent).toBe("continue_chapter")
  })

  it("routes outline-based chapter requests and extracts Chinese chapter numbers", () => {
    const route = routeTask("请根据第八章章纲生成正文")

    expect(route.intent).toBe("write_chapter")
    expect(route.chapterNumber).toBe(8)
  })

  it("routes analyze-outline-then-generate-chapter requests into chapter writing", () => {
    const route = routeTask("分析大纲内容去生成第3章")

    expect(route.intent).toBe("write_chapter")
    expect(route.chapterNumber).toBe(3)
  })

  it("routes explicit English chapter generation requests and keeps the chapter number", () => {
    const route = routeTask("Generate chapter 11 body. CURRENT_BUILD_SAMPLE. Only output the chapter prose.")

    expect(route.intent).toBe("write_chapter")
    expect(route.chapterNumber).toBe(11)
  })

  it("does not hijack a customized next-chapter prompt that mentions 开篇 writing requirements (issue #9)", () => {
    const route = routeTask(
      "请根据当前小说上下文、记忆库、最新章节结尾、下一章推进建议和章纲，继续生成下一章正文。只输出可直接保存到章节库的小说正文，不要解释，不要列提纲。正文必须是完整章节，内容要吸引读者，留住读者，目标约 3000 字，建议 2800-3400 字，低于 2600 字视为未完成，开篇200字内必须制造'钩子'。",
    )

    expect(route.intent).toBe("continue_chapter")
    expect(route.chapterNumber).toBeUndefined()
  })

  it("does not treat incidental 第一章 mentions in next-chapter requests as opening requests", () => {
    const route = routeTask("继续生成下一章正文，不要重复第一章的内容。")

    expect(route.intent).toBe("continue_chapter")
    expect(route.chapterNumber).toBeUndefined()
  })

  it("keeps explicit later chapter numbers even when the prompt mentions 开篇 hooks", () => {
    const route = routeTask("写第5章，开篇要有钩子")

    expect(route.intent).toBe("write_chapter")
    expect(route.chapterNumber).toBe(5)
  })
})

describe("routeTask fallbacks / openings / chapter extraction", () => {
  it("returns general_chat with confidence 1 for empty input", () => {
    const route = routeTask("   ")
    expect(route.intent).toBe("general_chat")
    expect(route.confidence).toBe(1)
    expect(route.extractedParams).toEqual({})
  })

  it("returns general_chat 0.5 when nothing matches", () => {
    const route = routeTask("今天天气不错")
    expect(route.intent).toBe("general_chat")
    expect(route.confidence).toBe(0.5)
  })
  it("does not treat negated opening directives as opening requests (CORR-005)", () => {
    // ISS-20260709-007：否定守卫从仅阻断开篇短路升级为逐处否定过滤——
    // 完全被否定的写章触发词不再计分，整句不再误路由为 write_chapter。
    const route = routeTask("不要写第一章")
    expect(route.intent).toBe("general_chat")
    // TASK-001：general_chat 早退改为与正常返回同形（顶层 chapterNumber 与
    // extractedParams 对齐）。extractChapterNumber 最后一道 CHAPTER_NUMBER_PATTERNS
    // 兜底不受否定守卫约束（ISS-20260709-007 已登记为独立技术债，本任务不得改），
    // 因此这里接受 chapterNumber=1 而不是给兜底补否定守卫。
    expect(route.chapterNumber).toBe(1)
    expect(route.extractedParams.chapterNumber).toBe("1")
  })

  it("keeps the unnegated chapter when a negated one is mentioned first (ISS-20260709-007)", () => {
    // “别写第2章，写第3章”：第2章被否定，目标章应为 3。
    const route = routeTask("别写第2章，写第3章")
    expect(route.intent).toBe("write_chapter")
    expect(route.chapterNumber).toBe(3)
    expect(routeTask("不要写第2章").intent).toBe("general_chat")
  })

  it("keeps an incidental 第一章 mention as the chapter target when not a next-chapter prompt", () => {
    const route = routeTask("继续写，不要重复第一章的内容")
    expect(route.intent).toBe("continue_chapter")
    expect(route.chapterNumber).toBe(1)
  })

  it("routes opening requests for 首章/第二/三章", () => {
    expect(routeTask("写首章").chapterNumber).toBe(1)
    expect(routeTask("写第二章").chapterNumber).toBe(2)
    expect(routeTask("写第三章").chapterNumber).toBe(3)
    expect(routeTask("小说开篇").chapterNumber).toBe(1)
  })

  it("extracts Chinese chapter numbers with multipliers and digits", () => {
    expect(routeTask("写第两千三百四十五章").chapterNumber).toBe(2345)
    // TASK-001：general_chat 路径不再只把章节号放进 extractedParams，
    // 顶层 chapterNumber 与正常返回同形（此前恒为 undefined）。
    const incidental = routeTask("请帮我看看第十章的内容")
    expect(incidental.intent).toBe("general_chat")
    expect(incidental.extractedParams.chapterNumber).toBe("10")
    expect(incidental.chapterNumber).toBe(10)
    expect(routeTask("第一百章讲了什么").extractedParams.chapterNumber).toBe("100")
    expect(routeTask("第千章").extractedParams.chapterNumber).toBe("1000")
    // 百 前无系数（current=0）→ (0 || 1) * 100
    expect(routeTask("第百章").extractedParams.chapterNumber).toBe("100")
    // 非正章号（第0章）不返回
    expect(routeTask("第0章讲了什么").extractedParams.chapterNumber).toBeUndefined()
  })

  it("leaves chapterNumber undefined when the text has none", () => {
    const route = routeTask("帮我润色一下文笔")
    expect(route.intent).toBe("polish_chapter")
    expect(route.chapterNumber).toBeUndefined()
  })

  it("puts incidental Chinese chapter numbers into extractedParams and chapterNumber", () => {
    const route = routeTask("请修改第二章的剧情")
    expect(route.intent).toBe("general_chat")
    expect(route.extractedParams.chapterNumber).toBe("2")
    // TASK-001：顶层 chapterNumber 与 extractedParams 同形对齐（此前为 undefined）。
    expect(route.chapterNumber).toBe(2)
  })
})

describe("buildTaskDirective", () => {
  it("emits an intent directive with the label and confidence for routed intents", () => {
    const text = buildTaskDirective({ intent: "write_chapter", confidence: 0.6, extractedParams: {} })
    expect(text).toContain("章节生成")
    expect(text).toContain("60%")
    expect(text).toContain("生成完整的章节正文")
  })

  it("returns empty for general_chat", () => {
    expect(buildTaskDirective({ intent: "general_chat", confidence: 1, extractedParams: {} })).toBe("")
  })
})

describe("P1-IMP-07 KbIntent 穷举映射", () => {
  it("KB_INTENT_ALIASES 覆盖全部 NovelTaskIntent（无 undefined）", async () => {
    const { KB_INTENT_ALIASES, KB_INTENTS } = await import("./task-router")
    const intentKeys = Object.keys(KB_INTENT_ALIASES)
    // 每个 NovelTaskIntent 都有映射，且落在五值域内
    for (const k of intentKeys) {
      const v = (KB_INTENT_ALIASES as Record<string, string>)[k]
      expect(v, `${k} 映射`).toBeTruthy()
      expect(KB_INTENTS).toContain(v)
    }
    // 映射值仅来自五值域
    expect(new Set(Object.values(KB_INTENT_ALIASES)).size).toBeLessThanOrEqual(KB_INTENTS.length)
  })

  it("toKbIntent 样例：「写第三章」→draft、「查伏笔」→lookup", async () => {
    const { routeTask, toKbIntent } = await import("./task-router")
    const writeRes = routeTask("写第三章")
    expect(toKbIntent(writeRes.intent)).toBe("draft")
    const lookupRes = routeTask("查一下前面埋的伏笔")
    expect(toKbIntent(lookupRes.intent)).toBe("lookup")
  })
})

describe("TASK-001 章节页交接模板路由（write_chapter 第 9 条 pattern）", () => {
  // 真实生产者：src/components/novel/main-control-handoff.ts buildChapterDraftGoal
  // 产出「为「第12章 旧梦」生成本章草稿」。此处手抄同形文案，锁正则形状；
  // 生产者的逐字断言在 main-control.spec.ts（另一 agent 负责）。
  it("routes the handoff template into write_chapter with the chapter number", () => {
    const route = routeTask("为「第12章 旧梦」生成本章草稿")
    expect(route.intent).toBe("write_chapter")
    expect(route.chapterNumber).toBe(12)
    expect(route.extractedParams.chapterNumber).toBe("12")
  })

  it("accepts the 给 preposition and 该章/这章 pronouns", () => {
    expect(routeTask("给「第7章 夜行」生成该章草稿").intent).toBe("write_chapter")
    expect(routeTask("为「第九章 归途」生成这章草稿").chapterNumber).toBe(9)
  })

  // 7 条误命中反例（main-control.spec.ts 复核清单）：必须仍不被判 write_chapter。
  it("does not misfire on mention / negation / question forms", () => {
    const misfires = [
      "不需要生成本章草稿",
      "请勿生成第7章草稿",
      "暂停生成本章草稿",
      "为什么要生成本章草稿？",
      "生成本章草稿的验收标准有哪些？",
      "输出第8章草稿的字数统计",
      "他说「生成本章草稿」是什么意思",
    ]
    for (const goal of misfires) {
      expect(routeTask(goal).intent, goal).not.toBe("write_chapter")
    }
  })

  // 检索/提及类反例：同样不得被判 write_chapter。
  it("does not misfire on retrieval / mention goals", () => {
    for (const goal of ["第12章 旧梦", "本章草稿在哪", "写一份草稿给编辑"]) {
      expect(routeTask(goal).intent, goal).not.toBe("write_chapter")
    }
  })

  // 代词限定 本章|该章|这章（不含「大纲」）：「生成大纲草稿」仍归 generate_outline。
  it("keeps 生成大纲草稿 on generate_outline", () => {
    const route = routeTask("生成大纲草稿")
    expect(route.intent).toBe("generate_outline")
  })
})

describe("B4 尾锚定 / B11 孪生反例 / RVF-07 问题后缀", () => {
  // B11：上面那 7 条误命中反例（与 main-control.spec.ts 同清单）无一包含
  // 「为/给 + 「第N章…」」前缀——它们在首字符就失配，所以 B4（只锚 `^` 不锚 `$`）
  // 在结构上测不到。以下给每条反例配一个“加前缀孪生”：前缀是真实交接模板形状，
  // 尾巴是同一条反例的话术。孪生命中 = B4 复活，用例必须一起红。
  const prefixedTwinsOfTheSevenMisfires = [
    "为「第12章 旧梦」不需要生成本章草稿",
    "为「第12章 旧梦」请勿生成本章草稿",
    "为「第12章 旧梦」暂停生成本章草稿",
    "为「第12章 旧梦」为什么要生成本章草稿？",
    "为「第12章 旧梦」生成本章草稿的验收标准有哪些？",
    "为「第12章 旧梦」输出第8章草稿的字数统计",
    "为「第12章 旧梦」他说「生成本章草稿」是什么意思",
  ]

  // 复核清单里点名的孪生形状（不依赖反例原句，直接锁模板 + 后缀的组合）。
  const reviewTwinMisfires = [
    "为「第12章 旧梦」生成本章草稿吗？",
    "为「第12章 旧梦」生成本章草稿的验收标准有哪些？",
    "为「第12章 旧梦」生成本章草稿的字数统计",
    "为「第12章 旧梦」生成本章草稿是什么意思",
    "给「第7章 X」生成本章草稿？",
  ]

  it("B11 孪生反例：原 7 条反例的加前缀孪生全部不判 write_chapter", () => {
    for (const goal of prefixedTwinsOfTheSevenMisfires) {
      expect(routeTask(goal).intent, goal).not.toBe("write_chapter")
    }
  })

  it("B11/RVF-07 孪生反例：模板 + 问题/统计/释义后缀全部不判 write_chapter", () => {
    for (const goal of reviewTwinMisfires) {
      expect(routeTask(goal).intent, goal).not.toBe("write_chapter")
    }
  })

  it("RVF-07：「草稿吗？」「草稿的验收标准有哪些？」这类问题句落在 general_chat", () => {
    expect(routeTask("为「第12章 旧梦」生成本章草稿吗？").intent).toBe("general_chat")
    expect(routeTask("为「第12章 旧梦」生成本章草稿的验收标准有哪些？").intent).toBe("general_chat")
    // 反证：这不是正则整体失效——去掉问题尾巴的同一条文案仍判 write_chapter。
    expect(routeTask("为「第12章 旧梦」生成本章草稿").intent).toBe("write_chapter")
  })

  it("B11 孪生反例：代词不是 本章/该章/这章 时不挂到 write_chapter（大纲草稿仍归 generate_outline）", () => {
    const route = routeTask("为「第12章 旧梦」生成大纲草稿")
    expect(route.intent).toBe("generate_outline")
    expect(route.intent).not.toBe("write_chapter")
  })

  // B4 正向锚：尾锚定只放行句末标点，不能把带句号的正当请求也误杀。
  it("B4 正向锚：句末标点（。！!）与首尾空白仍武装，章号不变", () => {
    for (const goal of [
      "为「第12章 旧梦」生成本章草稿",
      "为「第12章 旧梦」生成本章草稿。",
      "为「第12章 旧梦」生成本章草稿！",
      "为「第12章 旧梦」生成本章草稿!",
      "  为「第12章 旧梦」生成本章草稿。  ",
      "为「第12章 旧梦」生成本章草稿\n",
    ]) {
      const route = routeTask(goal)
      expect(route.intent, goal).toBe("write_chapter")
      expect(route.chapterNumber, goal).toBe(12)
    }
  })

  // 回归：原 7 条反例（无前缀形态）必须继续全部不武装。
  it("B4 回归：原 7 条反例（无前缀）仍全部不判 write_chapter", () => {
    for (const goal of [
      "不需要生成本章草稿",
      "请勿生成第7章草稿",
      "暂停生成本章草稿",
      "为什么要生成本章草稿？",
      "生成本章草稿的验收标准有哪些？",
      "输出第8章草稿的字数统计",
      "他说「生成本章草稿」是什么意思",
    ]) {
      expect(routeTask(goal).intent, goal).not.toBe("write_chapter")
    }
  })
})

describe("RVF-06 章节号取号：标题里的「首章」二字不得劫持目标章", () => {
  // 根因（改动前实测）：extractOpeningChapterNumber 的 `/首章|第一章|第1章/` 分支
  // 先于中文数字解析命中，而 1..3 的显式章号循环只认阿拉伯数字，于是
  // 「为「第二章 首章」生成本章草稿」被判成 chapterNumber=1。
  it("显式中文数字「第N章」优先于标题里的「首章」（改动前均为 1）", () => {
    const second = routeTask("为「第二章 首章」生成本章草稿")
    expect(second.intent).toBe("write_chapter")
    expect(second.chapterNumber).toBe(2)
    expect(second.extractedParams.chapterNumber).toBe("2")

    const third = routeTask("为「第三章 首章」生成本章草稿")
    expect(third.intent).toBe("write_chapter")
    expect(third.chapterNumber).toBe(3)

    expect(routeTask("为「第二章 首章」生成该章草稿").chapterNumber).toBe(2)
  })

  it("N>3 的中文数字目标章同样压过「首章」（改动前为 1）", () => {
    expect(routeTask("为「第十二章 首章」生成本章草稿").chapterNumber).toBe(12)
    expect(routeTask("为「第12章 首章」生成本章草稿").chapterNumber).toBe(12)
    expect(routeTask("为「第一百章 首章」生成本章草稿").chapterNumber).toBe(100)
  })

  it("「开篇」类弱关键词不再把中文数字目标章改写成 1（改动前为 1）", () => {
    // 与既有用例「写第5章，开篇要有钩子 → 5」的阿拉伯数字形态同义。
    expect(routeTask("写第五章，开篇要有钩子").chapterNumber).toBe(5)
    expect(routeTask("写第十二章，开篇要有钩子").chapterNumber).toBe(12)
  })

  // 意图不变量：取号改动只允许改“章号”，不得把写章请求的意图改掉（实测基线：
  // 若让意图门也认中文数字，「生成第四章，开篇要有钩子」会从 write_chapter 翻成
  // general_chat——通用写章意图正则只覆盖阿拉伯数字；意图门因此保持只认阿拉伯数字）。
  it("意图不变量：中文数字写章请求的意图不因取号改动而变化", () => {
    expect(routeTask("生成第四章，开篇要有钩子").intent).toBe("write_chapter")
    expect(routeTask("创作第五章，开篇要有钩子").intent).toBe("write_chapter")
    expect(routeTask("写首章，第五章再回收伏笔").intent).toBe("write_chapter")
    expect(routeTask("写第五章，开篇要有钩子").intent).toBe("write_chapter")
  })

  // 既有取号行为回归（改动前逐条实测值，一个都不许变）。
  it("既有取号行为不变（开篇/否定/下一章/中文数字多位数）", () => {
    expect(routeTask("写首章").chapterNumber).toBe(1)
    expect(routeTask("写第一章").chapterNumber).toBe(1)
    expect(routeTask("写开局").chapterNumber).toBe(1)
    expect(routeTask("开篇章节").chapterNumber).toBe(1)
    expect(routeTask("小说开篇").chapterNumber).toBe(1)
    expect(routeTask("写第二章").chapterNumber).toBe(2)
    expect(routeTask("写第三章").chapterNumber).toBe(3)
    expect(routeTask("写第5章，开篇要有钩子").chapterNumber).toBe(5)
    expect(routeTask("继续写，不要重复第一章的内容").chapterNumber).toBe(1)
    expect(routeTask("继续生成下一章正文，不要重复第一章的内容。").chapterNumber).toBeUndefined()
    expect(routeTask("别写第2章，写第3章").chapterNumber).toBe(3)
    expect(routeTask("不要写第二章").intent).toBe("general_chat")
    expect(routeTask("写第两千三百四十五章").chapterNumber).toBe(2345)
    expect(routeTask("第一百章讲了什么").chapterNumber).toBe(100)
    expect(routeTask("第千章").chapterNumber).toBe(1000)
    expect(routeTask("第百章").chapterNumber).toBe(100)
  })
})
