import { describe, expect, it } from "vitest"
import {
  buildIntentAnalysisPrompt,
  buildIntentPhaseSystemRules,
  classifyDirectOutlineGenerationRequest,
  parseIntentClarity,
  parseIntentClarityProtocol,
  shouldAutoFollowUpGeneration,
  stripStructuredMarkers,
  type IntentClarityResult,
} from "./outline-intent-clarity"

const OPEN = "<!-- intent_clarity -->"
const CLOSE = "<!-- /intent_clarity -->"

function wrap(json: string): string {
  return `${OPEN}\n${json}\n${CLOSE}`
}

function expectValid(text: string): IntentClarityResult {
  const outcome = parseIntentClarityProtocol(text)
  expect(outcome.kind).toBe("valid")
  if (outcome.kind !== "valid") throw new Error("unreachable")
  return outcome.result
}

describe("classifyDirectOutlineGenerationRequest", () => {
  it("动词 + 章节细纲目标 => 章节细纲", () => {
    expect(classifyDirectOutlineGenerationRequest("帮我生成第3章大纲")).toEqual({ module: "章节细纲" })
    expect(classifyDirectOutlineGenerationRequest("编写章节细纲")).toEqual({ module: "章节细纲" })
  })

  it("按目标表顺序取第一个命中的模块", () => {
    expect(classifyDirectOutlineGenerationRequest("生成卷纲")).toEqual({ module: "卷纲" })
    expect(classifyDirectOutlineGenerationRequest("生成人物设定")).toEqual({ module: "人物小传" })
    expect(classifyDirectOutlineGenerationRequest("补充组织势力设定")).toEqual({ module: "组织势力设定" })
    expect(classifyDirectOutlineGenerationRequest("细化力量体系")).toEqual({ module: "力量体系" })
    expect(classifyDirectOutlineGenerationRequest("重写金手指设定")).toEqual({ module: "金手指设定" })
    expect(classifyDirectOutlineGenerationRequest("完善地理设定")).toEqual({ module: "地理设定" })
    expect(classifyDirectOutlineGenerationRequest("扩写背景设定")).toEqual({ module: "背景设定" })
    expect(classifyDirectOutlineGenerationRequest("补充伏笔设定")).toEqual({ module: "伏笔计划" })
    expect(classifyDirectOutlineGenerationRequest("改写故事大纲")).toEqual({ module: "故事大纲" })
  })

  it("未登记的表内短语（卷大纲）不命中任何目标 => null", () => {
    // 「卷大纲」既不是「卷纲」也不是「分卷大纲」，故事大纲条目也被否定前瞻排除
    expect(classifyDirectOutlineGenerationRequest("生成卷大纲")).toBeNull()
  })

  it("带章号的「第N章…大纲」命中章节细纲", () => {
    expect(classifyDirectOutlineGenerationRequest("扩写第12章的过渡大纲")).toEqual({ module: "章节细纲" })
  })

  it("只有动词没有目标 => null", () => {
    expect(classifyDirectOutlineGenerationRequest("请生成一些内容")).toBeNull()
  })

  it("只有目标没有动词 => null", () => {
    expect(classifyDirectOutlineGenerationRequest("这是我的故事大纲")).toBeNull()
  })

  it("大小写无关地不误判英文句子", () => {
    expect(classifyDirectOutlineGenerationRequest("Generate an outline")).toBeNull()
  })
})

describe("shouldAutoFollowUpGeneration", () => {
  it("仅 intent_analysis 阶段自动跟进", () => {
    expect(shouldAutoFollowUpGeneration("intent_analysis")).toBe(true)
    expect(shouldAutoFollowUpGeneration("generation")).toBe(false)
    expect(shouldAutoFollowUpGeneration("waiting_user_input")).toBe(false)
    expect(shouldAutoFollowUpGeneration(undefined)).toBe(false)
  })
})

describe("parseIntentClarityProtocol", () => {
  it("没有开标记 => kind none", () => {
    expect(parseIntentClarityProtocol("普通正文，没有协议块")).toEqual({ kind: "none" })
  })

  it("开标记存在但为空 => invalid", () => {
    expect(parseIntentClarityProtocol(`${OPEN}\n${CLOSE}`)).toEqual({
      kind: "invalid",
      error: "意图分析 JSON 不完整或缺失",
    })
  })

  it("开标记后没有任何内容 => invalid", () => {
    expect(parseIntentClarityProtocol(OPEN)).toEqual({
      kind: "invalid",
      error: "意图分析 JSON 不完整或缺失",
    })
  })

  it("JSON 无法解析 => invalid", () => {
    expect(parseIntentClarityProtocol(wrap("{not json}"))).toEqual({
      kind: "invalid",
      error: "意图分析 JSON 无法解析",
    })
  })

  it("payload 是数组 => invalid", () => {
    expect(parseIntentClarityProtocol(wrap('["clear"]'))).toEqual({
      kind: "invalid",
      error: "意图分析结果必须是 JSON 对象",
    })
  })

  it("payload 是标量 null => invalid（JSON.parse 得到 null）", () => {
    expect(parseIntentClarityProtocol(wrap("null"))).toEqual({
      kind: "invalid",
      error: "意图分析结果必须是 JSON 对象",
    })
  })

  it("clarity 缺失或非法 => invalid", () => {
    expect(parseIntentClarityProtocol(wrap('{"module":"卷纲"}'))).toEqual({
      kind: "invalid",
      error: "意图分析缺少有效的 clarity 字段",
    })
    expect(parseIntentClarityProtocol(wrap('{"clarity":"maybe"}'))).toEqual({
      kind: "invalid",
      error: "意图分析缺少有效的 clarity 字段",
    })
  })

  it("完整协议块 => canonical 结果，字段全量映射", () => {
    const result = expectValid(
      wrap(
        JSON.stringify({
          clarity: "needs_input",
          module: "章节细纲",
          analysis: "缺少第3-5章细纲",
          detectedScope: "第3-5章",
          missingItems: ["第3章", "第4章", 42],
          options: [
            { id: "a", label: "全部生成", description: "生成缺失项" },
            { id: "b", label: "推断生成" },
            { id: "", label: "缺 id" },
            { id: "c", label: "" },
            { description: "只有描述，缺 id 与 label" },
            "not-an-object",
            null,
            ["array"],
          ],
          question: "要生成哪几章？",
        }),
      ),
    )
    expect(result).toMatchObject({
      clarity: "needs_input",
      module: "章节细纲",
      analysis: "缺少第3-5章细纲",
      detectedScope: "第3-5章",
      missingItems: ["第3章", "第4章"],
      question: "要生成哪几章？",
      normalizationSource: "canonical",
    })
    // 非对象项、缺 id、缺 label 的选项被剔除；缺 description 补空串
    expect(result.options).toEqual([
      { id: "a", label: "全部生成", description: "生成缺失项" },
      { id: "b", label: "推断生成", description: "" },
    ])
  })

  it("options 不是数组 => 空选项；missingItems 非数组 => 空数组", () => {
    const result = expectValid(wrap(JSON.stringify({ clarity: "clear", options: "oops", missingItems: "x" })))
    expect(result.options).toEqual([])
    expect(result.missingItems).toEqual([])
  })

  it("legacy status 字段被接受，normalizationSource=legacy_status", () => {
    const result = expectValid(wrap(JSON.stringify({ status: "clear", module: "卷纲" })))
    expect(result.clarity).toBe("clear")
    expect(result.normalizationSource).toBe("legacy_status")
  })

  it("未闭合标记 + 完整 JSON 对象 => legacy_unclosed", () => {
    const result = expectValid(`${OPEN}\n{"clarity":"clear","module":"卷纲"}`)
    expect(result.clarity).toBe("clear")
    expect(result.module).toBe("卷纲")
    expect(result.normalizationSource).toBe("legacy_unclosed")
  })

  it("未闭合标记 + legacy status => legacy_status_unclosed", () => {
    const result = expectValid(`${OPEN}\n{"status":"needs_input"}`)
    expect(result.clarity).toBe("needs_input")
    expect(result.normalizationSource).toBe("legacy_status_unclosed")
  })

  it("未闭合标记且 JSON 后还有额外内容 => invalid", () => {
    expect(parseIntentClarityProtocol(`${OPEN}\n{"clarity":"clear"}\n额外解释文字`)).toEqual({
      kind: "invalid",
      error: "意图分析缺少闭合标记且 JSON 后仍有额外内容",
    })
  })

  it("未闭合标记且没有 JSON => invalid", () => {
    expect(parseIntentClarityProtocol(`${OPEN}\n只有说明文字`)).toEqual({
      kind: "invalid",
      error: "意图分析 JSON 不完整或缺失",
    })
  })

  it("未闭合标记且 JSON 未闭合（括号不平衡）=> invalid", () => {
    expect(parseIntentClarityProtocol(`${OPEN}\n{"clarity":"clear"`)).toEqual({
      kind: "invalid",
      error: "意图分析 JSON 不完整或缺失",
    })
  })

  it("JSON 字符串里的花括号与转义引号不打断对象边界扫描", () => {
    const json = '{"clarity":"clear","analysis":"包含 } 字符 and \\"quote\\""}'
    const result = expectValid(`${OPEN}\n${json}`)
    expect(result.analysis).toBe('包含 } 字符 and "quote"')
  })

  it("未闭合标记里字符串含反斜杠转义时不会误判结束", () => {
    const json = '{"clarity":"clear","analysis":"路径 C:\\\\out \\\\n"}'
    const result = expectValid(`${OPEN}\n${json}`)
    expect(result.analysis).toBe("路径 C:\\out \\n")
  })

  it("嵌套 JSON 对象不会提前结束边界扫描", () => {
    const json = '{"clarity":"clear","meta":{"nested":{"deep":1}},"module":"卷纲"}'
    const result = expectValid(`${OPEN}\n${json}\n${CLOSE}`)
    expect(result.module).toBe("卷纲")
    expect(result.clarity).toBe("clear")
  })

  it("嵌套 JSON + 未闭合标记 + 尾部内容 => 按设计拒绝（不把尾部内容当作 JSON 的一部分）", () => {
    const json = '{"clarity":"clear","meta":{"nested":{"deep":1}},"module":"卷纲"}'
    expect(parseIntentClarityProtocol(`${OPEN}\n${json}\n尾部忽略`)).toEqual({
      kind: "invalid",
      error: "意图分析缺少闭合标记且 JSON 后仍有额外内容",
    })
  })

  it("module 缺省时按 legacy 描述字段匹配目标模块", () => {
    expect(expectValid(wrap(JSON.stringify({ clarity: "clear", target: "生成人物小传" }))).module).toBe("人物小传")
    expect(expectValid(wrap(JSON.stringify({ clarity: "clear", scope: "力量体系" }))).module).toBe("力量体系")
    expect(expectValid(wrap(JSON.stringify({ clarity: "clear", intent: "世界观" }))).module).toBe("背景设定")
  })

  it("完全无法推断 module 时回落「大纲」", () => {
    expect(expectValid(wrap(JSON.stringify({ clarity: "clear" }))).module).toBe("大纲")
  })

  it("analysis/detectedScope/question 的 legacy 别名可被读取", () => {
    const result = expectValid(
      wrap(JSON.stringify({ clarity: "clear", intent: "legacy analysis", scope: "legacy scope" })),
    )
    expect(result.analysis).toBe("legacy analysis")
    expect(result.detectedScope).toBe("legacy scope")
    expect(result.question).toBe("")
  })
})

describe("parseIntentClarity", () => {
  it("valid 时返回结果，其他情况返回 null", () => {
    expect(parseIntentClarity(wrap('{"clarity":"clear"}'))?.clarity).toBe("clear")
    expect(parseIntentClarity("无协议")).toBeNull()
    expect(parseIntentClarity(wrap('{"clarity":"bogus"}'))).toBeNull()
  })
})

describe("buildIntentAnalysisPrompt", () => {
  it("嵌入标题与分项要求，并强制 clarity 字段名", () => {
    const prompt = buildIntentAnalysisPrompt("卷纲", "仅分析当前卷")
    expect(prompt).toContain("「生成卷纲」")
    expect(prompt).toContain("仅分析当前卷")
    expect(prompt).toContain(OPEN)
    expect(prompt).toContain(CLOSE)
    expect(prompt).toContain("字段名必须使用 clarity，禁止使用 status")
  })
})

describe("buildIntentPhaseSystemRules", () => {
  it("intent_analysis 阶段要求只输出协议块", () => {
    const rules = buildIntentPhaseSystemRules("intent_analysis")
    expect(rules).toContain("## 本轮阶段：意图分析")
    expect(rules).toContain(OPEN)
    expect(rules).toContain(CLOSE)
  })

  it("generation 阶段禁止再次输出协议块", () => {
    const rules = buildIntentPhaseSystemRules("generation")
    expect(rules).toContain("## 本轮阶段：正文生成")
    expect(rules).not.toContain(OPEN)
  })

  it("其余阶段无额外规则", () => {
    expect(buildIntentPhaseSystemRules("waiting_user_input")).toBe("")
    expect(buildIntentPhaseSystemRules(undefined)).toBe("")
  })
})

describe("stripStructuredMarkers", () => {
  it("移除成对协议块与其内部内容", () => {
    expect(stripStructuredMarkers(`前言\n${wrap('{"clarity":"clear"}')}\n正文`)).toBe("前言\n\n正文")
  })

  it("成对 next_step 块也被移除", () => {
    const text = "A\n<!-- next_step -->\n建议\n<!-- /next_step -->\nB"
    expect(stripStructuredMarkers(text)).toBe("A\n\nB")
  })

  it("流式中间态：未闭合开标签及其后全部内容被切断", () => {
    expect(stripStructuredMarkers(`开头\n${OPEN}\n{"clarity":`)).toBe("开头")
    expect(stripStructuredMarkers("开头\n<!-- next_step -->\n半截")).toBe("开头")
  })

  it("残留裸闭标签被移除", () => {
    expect(stripStructuredMarkers(`正文 ${CLOSE}`)).toBe("正文")
    expect(stripStructuredMarkers("正文 <!-- /next_step -->")).toBe("正文")
  })

  it("details 折叠块连同内容被移除", () => {
    const text = "前<details><summary>点开</summary>隐藏内容</details>后"
    expect(stripStructuredMarkers(text)).toBe("前后")
  })

  it("未闭合 details 会吞掉其后内容", () => {
    expect(stripStructuredMarkers("前<details><summary>点开</summary>隐藏")).toBe("前")
  })

  it("块级与行内标签被移除但保留文本", () => {
    expect(stripStructuredMarkers("<p>段落<strong>重点</strong></p>")).toBe("段落重点")
    expect(stripStructuredMarkers("<table><tr><td>单元</td></tr></table>")).toBe("单元")
  })

  it("折叠多余空行并 trim", () => {
    expect(stripStructuredMarkers("\n\n甲\n\n\n\n乙\n\n")).toBe("甲\n\n乙")
  })
})
