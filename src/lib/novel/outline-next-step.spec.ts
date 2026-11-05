/**
 * outline-next-step 行为测试（C4 空壳原位重写）。
 *
 * 覆盖：isRecommendationForbidden 全禁令形态、extractNextStep 四源
 * （strict/recovered/fallback/none）、cleanNextStepArtifacts 制品清理、
 * normalizeRecommendations 过滤链、extractJsonObject 边界、fallback 安全推荐、
 * buildNextStepPromptSuffix 约束文案。零 LLM（纯函数模块）。
 */
import { describe, expect, it } from "vitest"
import {
  buildNextStepPromptSuffix,
  cleanNextStepArtifacts,
  extractNextStep,
  isRecommendationForbidden,
  parseNextStep,
} from "./outline-next-step"

const payload = (recs: unknown) =>
  JSON.stringify({
    completedModule: "第一卷",
    completedScope: "第1-10章",
    recommendations: recs,
  })

const wrap = (json: string) => `正文正文\n<!-- next_step -->${json}<!-- /next_step -->尾巴`

describe("isRecommendationForbidden", () => {
  it("放行大纲类推荐", () => {
    expect(isRecommendationForbidden("继续完善第一卷人物小传")).toBe(false)
    expect(isRecommendationForbidden("自定义")).toBe(false)
    expect(isRecommendationForbidden("")).toBe(false)
  })

  it("拦截 10 类正文生成话术", () => {
    const forbidden = [
      "生成下一章正文",
      "写第二章正文",
      "创作本章正文",
      "正文生成续写",
      "正文写细纲",
      "生成章节内容",
      "生成正文章节",
      "章节正文润色",
      "写正文",
      "生成正文",
      "写章节内容",
    ]
    for (const label of forbidden) {
      expect(isRecommendationForbidden(label)).toBe(true)
    }
  })
})

describe("extractNextStep strict 路径", () => {
  it("完整标记块解析出推荐并清理正文", () => {
    const text = wrap(payload([{ id: "A", label: "细化分场", reason: "补齐冲突" }]))
    const res = extractNextStep(text)
    expect(res.source).toBe("strict")
    expect(res.recommendation).toEqual({
      completedModule: "第一卷",
      completedScope: "第1-10章",
      recommendations: [{ id: "A", label: "细化分场", reason: "补齐冲突" }],
    })
    expect(res.cleanText).toBe("正文正文\n尾巴")
  })

  it("蛇形字段 completed_module/completed_scope 被兼容", () => {
    const text = wrap(
      JSON.stringify({
        completed_module: "M",
        completed_scope: "S",
        recommendations: [{ id: "A", label: "L", reason: "R" }],
      }),
    )
    expect(extractNextStep(text).recommendation).toMatchObject({
      completedModule: "M",
      completedScope: "S",
    })
  })

  it("title/description 别名被兼容", () => {
    const text = wrap(payload([{ id: "A", title: "L", description: "R" }]))
    expect(extractNextStep(text).recommendation!.recommendations).toEqual([
      { id: "A", label: "L", reason: "R" },
    ]
    )
  })

  it("代码围栏包裹的 JSON 可解析", () => {
    const text = wrap(`\`\`\`json\n${payload([{ id: "A", label: "L", reason: "R" }])}\n\`\`\``)
    expect(extractNextStep(text).source).toBe("strict")
  })

  it("完整块但非法 JSON → source 按 allowFallback 切换，推荐保持 null", () => {
    const text = wrap("{not json")
    const plain = extractNextStep(text)
    expect(plain.source).toBe("none")
    expect(plain.recommendation).toBeNull()
    // 注意：完整块路径下 fallback 只切换 source，不合成安全推荐
    // （与 recovered/无标记路径不同，该行为差异在此锁定）。
    const fb = extractNextStep(text, { allowFallback: true })
    expect(fb.source).toBe("fallback")
    expect(fb.recommendation).toBeNull()
  })

  it("字符串内转义不破坏花括号配平（extractJsonObject escaped 分支）", () => {
    const text = wrap(
      '{"completedModule":"M","recommendations":[{"id":"A","label":"X\\nY","reason":"R"}]}',
    )
    const res = extractNextStep(text)
    expect(res.source).toBe("strict")
    expect(res.recommendation!.recommendations[0]!.label).toBe("X\nY")
  })

  it("配平但非法 JSON → JSON.parse 抛错被吞，返回 null", () => {
    const res = extractNextStep(wrap('{"a": }'))
    expect(res.source).toBe("none")
    expect(res.recommendation).toBeNull()
  })

  it("非对象/数组 JSON → 无推荐", () => {
    expect(extractNextStep(wrap("[1,2]")).recommendation).toBeNull()
    expect(extractNextStep(wrap("42")).recommendation).toBeNull()
  })

  it("无花括号文本 → 无推荐", () => {
    expect(extractNextStep(wrap("纯文本无对象")).source).toBe("none")
  })

  it("recommendations 非数组 → 空数组但仍 strict", () => {
    const res = extractNextStep(wrap(payload("oops")))
    expect(res.source).toBe("strict")
    expect(res.recommendation!.recommendations).toEqual([])
  })

  it("缺 id/空 label 条目被丢弃，禁令 label 被过滤", () => {
    const text = wrap(
      payload([
        { id: "", label: "L", reason: "R" },
        { id: "B", label: "", reason: "R" },
        { id: "C", label: "生成正文", reason: "R" },
        { id: "D", label: "自定义", reason: "R" },
        "junk",
        null,
      ]),
    )
    const recs = extractNextStep(text).recommendation!.recommendations
    expect(recs).toEqual([{ id: "D", label: "自定义", reason: "R" }])
  })
})

describe("extractNextStep recovered/fallback/none 路径", () => {
  it("只有起始标记：可解析时 recovered", () => {
    const text = `正文<!-- next_step -->${payload([{ id: "A", label: "L", reason: "R" }])}`
    const res = extractNextStep(text)
    expect(res.source).toBe("recovered")
    expect(res.recommendation!.completedModule).toBe("第一卷")
    expect(res.cleanText).toBe("正文")
  })

  it("只有起始标记且不可解析：默认 none，allowFallback 时 fallback", () => {
    const text = "正文<!-- next_step -->乱码无对象"
    expect(extractNextStep(text).source).toBe("none")
    const fb = extractNextStep(text, { allowFallback: true, completedModule: "M", completedScope: "S" })
    expect(fb.source).toBe("fallback")
    expect(fb.recommendation).toMatchObject({ completedModule: "M", completedScope: "S" })
  })

  it("无任何标记：默认 none；allowFallback 用注入的模块/范围", () => {
    expect(extractNextStep("纯正文").source).toBe("none")
    expect(extractNextStep("纯正文").recommendation).toBeNull()
    const fb = extractNextStep("纯正文", { allowFallback: true })
    expect(fb.source).toBe("fallback")
    expect(fb.recommendation!.completedModule).toBe("当前模块")
  })
})

describe("parseNextStep", () => {
  it("透出 recommendation；无标记时 null", () => {
    const text = wrap(payload([{ id: "A", label: "L", reason: "R" }]))
    expect(parseNextStep(text)!.completedScope).toBe("第1-10章")
    expect(parseNextStep("纯正文")).toBeNull()
  })
})

describe("cleanNextStepArtifacts", () => {
  it("完整块、尾随结束标记、裸 next_step 残留都被清除", () => {
    expect(cleanNextStepArtifacts(wrap(payload([{ id: "A", label: "L", reason: "R" }])))).toBe(
      "正文正文\n尾巴",
    )
    expect(cleanNextStepArtifacts("正文<!-- /next_step -->")).toBe("正文")
    expect(cleanNextStepArtifacts("正文 next_step: 残留")).toBe("正文  残留")
    expect(cleanNextStepArtifacts("  两边空格  ")).toBe("两边空格")
  })
})

describe("buildNextStepPromptSuffix", () => {
  it("包含标记约定与约束（仅大纲、D 自定义必填）", () => {
    const suffix = buildNextStepPromptSuffix()
    expect(suffix).toContain("<!-- next_step -->")
    expect(suffix).toContain("completedModule")
    expect(suffix).toContain("不得推荐生成正文或写正文")
    expect(suffix).toContain('必须包含一个 id 为 D 的“自定义”选项')
  })
})
