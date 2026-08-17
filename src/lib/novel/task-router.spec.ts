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
    // “不要写第一章”命中 write_chapter 关键词但置信度低（非开篇请求 confidence 1）
    const route = routeTask("不要写第一章")
    expect(route.intent).toBe("write_chapter")
    expect(route.confidence).toBeLessThan(1)
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
    // general_chat 路径：章节号只进 extractedParams
    expect(routeTask("请帮我看看第十章的内容").extractedParams.chapterNumber).toBe("10")
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

  it("puts incidental Chinese chapter numbers into extractedParams", () => {
    const route = routeTask("请修改第二章的剧情")
    expect(route.extractedParams.chapterNumber).toBe("2")
    expect(route.chapterNumber).toBeUndefined()
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
