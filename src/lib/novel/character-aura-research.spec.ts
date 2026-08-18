import { beforeEach, describe, expect, it, vi } from "vitest"
import type { LlmConfig } from "@/stores/wiki-store"

const streamChatMock = vi.hoisted(() => vi.fn())
vi.mock("@/lib/llm-client", () => ({
  streamChat: streamChatMock,
  combineAbortSignals: (...signals: Array<AbortSignal | undefined>): AbortSignal | undefined => {
    const active = signals.filter(Boolean) as AbortSignal[]
    if (active.length === 0) return undefined
    if (active.length === 1) return active[0]
    const controller = new AbortController()
    for (const s of active) {
      if (s.aborted) {
        controller.abort()
        break
      }
      s.addEventListener("abort", () => controller.abort(), { once: true })
    }
    return controller.signal
  },
  DEFAULT_LLM_REQUEST_TIMEOUT_MS: 1000,
}))

const storeState = vi.hoisted(() => ({
  llmConfig: { provider: "custom", model: "m", customEndpoint: "http://x" } as LlmConfig,
}))
vi.mock("@/stores/wiki-store", () => ({
  useWikiStore: { getState: () => storeState },
}))

vi.mock("@/lib/novel/model-resolver", () => ({
  resolveDefaultModel: (cfg: unknown) => cfg,
}))

import {
  AURA_WORKFLOW_STAGES,
  buildAuraResearchStage,
  buildAuraResearchStageFallback,
  synthesizeCustomAuraFields,
} from "./character-aura-research"
import type { CustomCharacterAuraGenerationInput } from "./character-aura-types"

const USABLE_LLM = { provider: "custom", model: "m", customEndpoint: "http://x", apiKey: "" } as LlmConfig
const NO_LLM = { provider: "openai", model: "", apiKey: "" } as LlmConfig

function genInput(overrides: Partial<CustomCharacterAuraGenerationInput> = {}): CustomCharacterAuraGenerationInput {
  return {
    name: "林动",
    category: "主角",
    corpus: "语料",
    sourceUrls: "https://a.com",
    localDocumentPaths: "/d/ok.md",
    generationPrompt: "提示词",
    enableWebSearch: false,
    importedDocuments: [],
    failedDocuments: [],
    importedUrls: [],
    failedUrls: [],
    searchQueries: [],
    webSearchResults: [],
    importedSearchDocuments: [],
    failedSearchUrls: [],
    generationNotes: [],
    ...overrides,
  }
}

function fullInput(): CustomCharacterAuraGenerationInput {
  return genInput({
    corpus: "这是一段很长的用户资料文本。",
    importedDocuments: [{ path: "/d/1.md", content: "本地文档内容" }],
    importedUrls: [{ url: "https://a.com", content: "网页内容" }],
    webSearchResults: [{ title: "搜索标题", url: "https://s.com", snippet: "摘要", source: "tavily" }],
    importedSearchDocuments: [
      { title: "搜索正文", url: "https://s.com/1", snippet: "摘要", source: "tavily", query: "q", content: "正文" },
    ],
    generationNotes: ["备注一"],
  })
}

function fullFieldsJson(): string {
  return JSON.stringify({
    sourceNote: "来源说明",
    styleDescription: "风格描述",
    behaviorRules: "行为规则",
    boundaries: "边界",
    notes: "备注",
    expressionDna: "表达DNA",
    mentalModel: "心智模型",
    decisionHeuristics: "决策启发式",
    valueAntiPatterns: "反模式",
    honestyBoundaries: "诚实边界",
  })
}

const stage01 = AURA_WORKFLOW_STAGES[0]
const stage02 = AURA_WORKFLOW_STAGES[1]
const stage03 = AURA_WORKFLOW_STAGES[2]
const stage04 = AURA_WORKFLOW_STAGES[3]
const stage05 = AURA_WORKFLOW_STAGES[4]
const stage06 = AURA_WORKFLOW_STAGES[5]

describe("AURA_WORKFLOW_STAGES", () => {
  it("defines the 6-stage workflow", () => {
    expect(AURA_WORKFLOW_STAGES).toHaveLength(6)
    for (const stage of AURA_WORKFLOW_STAGES) {
      expect(stage.sections.length).toBeGreaterThan(0)
      expect(stage.goal.length).toBeGreaterThan(0)
    }
  })
})

describe("buildAuraResearchStage (LLM path)", () => {
  beforeEach(() => {
    streamChatMock.mockReset()
  })

  function llmOk(raw: string): void {
    streamChatMock.mockImplementation(async (_cfg: unknown, _msgs: unknown, cb: { onToken: (t: string) => void; onDone: () => void }) => {
      cb.onToken(raw)
      cb.onDone()
    })
  }

  it("returns the LLM markdown verbatim when it starts with a heading", async () => {
    llmOk("# 林动 - 公开资料\n\n## 核心结论\n内容")
    const out = await buildAuraResearchStage(stage01, genInput(), {}, { llmConfig: USABLE_LLM })
    expect(out).toContain("# 林动 - 公开资料")
    expect(out).toContain("## 核心结论")
  })

  it("prepends a heading when the LLM output lacks one", async () => {
    llmOk("## 核心结论\n内容")
    const out = await buildAuraResearchStage(stage01, genInput(), {}, { llmConfig: USABLE_LLM })
    expect(out).toMatch(/^# 林动 - 公开资料\n\n## 核心结论/)
  })

  it("falls back to the template when the LLM returns only whitespace", async () => {
    llmOk("   ")
    const out = await buildAuraResearchStage(stage01, genInput(), {}, { llmConfig: USABLE_LLM })
    expect(out).toContain("# 林动 - 公开资料")
    expect(out).toContain("## 核心结论")
  })

  it("records a generation note and falls back when streamChat throws", async () => {
    streamChatMock.mockRejectedValue(new Error("llm down"))
    const input = genInput()
    const out = await buildAuraResearchStage(stage01, input, {}, { llmConfig: USABLE_LLM })
    expect(out).toContain("# 林动 - 公开资料")
    expect(input.generationNotes).toContain("01 公开资料 生成失败，已降级为模板生成：llm down")
  })

  it("throws the stream error when streamChat reports onError", async () => {
    streamChatMock.mockImplementation(async (_c: unknown, _m: unknown, cb: { onError: (e: Error) => void }) => {
      cb.onError(new Error("stream broke"))
    })
    const input = genInput()
    const out = await buildAuraResearchStage(stage01, input, {}, { llmConfig: USABLE_LLM })
    expect(out).toContain("## 核心结论")
    expect(input.generationNotes[0]).toContain("stream broke")
  })

  it("records non-Error failures with a generic message", async () => {
    streamChatMock.mockRejectedValue("string failure")
    const input = genInput()
    const out = await buildAuraResearchStage(stage01, input, {}, { llmConfig: USABLE_LLM })
    expect(out).toContain("## 证据线索")
    expect(input.generationNotes[0]).toContain("未知错误")
  })

  it("skips the LLM and returns the template when no usable LLM is configured", async () => {
    const out = await buildAuraResearchStage(stage01, genInput(), {}, { llmConfig: NO_LLM })
    expect(out).toContain("# 林动 - 公开资料")
    expect(streamChatMock).not.toHaveBeenCalled()
  })

  it("falls back to the store llmConfig when no config is injected", async () => {
    llmOk("# ok")
    await buildAuraResearchStage(stage01, genInput(), {}, {})
    expect(streamChatMock).toHaveBeenCalled()
  })

  it("builds material blocks for every populated source bucket", async () => {
    let userPrompt = ""
    streamChatMock.mockImplementation(async (_c: unknown, messages: Array<{ content: string }>, cb: { onToken: (t: string) => void; onDone: () => void }) => {
      userPrompt = messages[1].content
      cb.onToken("# x")
      cb.onDone()
    })
    await buildAuraResearchStage(stage02, fullInput(), { "01-writings.md": "# 前序" }, { llmConfig: USABLE_LLM })
    expect(userPrompt).toContain("【用户资料文本】")
    expect(userPrompt).toContain("【本地文档摘录】")
    expect(userPrompt).toContain("【用户网页摘录】")
    expect(userPrompt).toContain("【AI 搜索结果摘要】")
    expect(userPrompt).toContain("【AI 搜索网页正文摘录】")
    expect(userPrompt).toContain("【已生成的前序研究文件】")
    expect(userPrompt).toContain("【生成备注】")
    expect(userPrompt).toContain("【当前阶段】02 对话方式")
    expect(userPrompt).toContain("AI 搜索：未开启")
  })

  it("tolerates a previous research file whose content is undefined (LLM material path)", async () => {
    let userPrompt = ""
    streamChatMock.mockImplementation(async (_c: unknown, messages: Array<{ content: string }>, cb: { onToken: (t: string) => void; onDone: () => void }) => {
      userPrompt = messages[1].content
      cb.onToken("# x")
      cb.onDone()
    })
    await buildAuraResearchStage(
      stage01,
      genInput(),
      { "01-writings.md": undefined as unknown as string },
      { llmConfig: USABLE_LLM },
    )
    expect(userPrompt).toContain("【已生成的前序研究文件】")
    expect(userPrompt).toContain("### 01-writings.md\n")
  })

  it("builds material with a defined empty prior research file", async () => {
    let userPrompt = ""
    streamChatMock.mockImplementation(async (_c: unknown, messages: Array<{ content: string }>, cb: { onToken: (t: string) => void; onDone: () => void }) => {
      userPrompt = messages[1].content
      cb.onToken("# x")
      cb.onDone()
    })
    await buildAuraResearchStage(stage01, genInput(), { "01-writings.md": "" }, { llmConfig: USABLE_LLM })
    expect(userPrompt).toContain("【已生成的前序研究文件】")
    expect(userPrompt).toContain("### 01-writings.md\n")
  })

  it("builds a minimal material block when every bucket is empty", async () => {
    let userPrompt = ""
    streamChatMock.mockImplementation(async (_c: unknown, messages: Array<{ content: string }>, cb: { onToken: (t: string) => void; onDone: () => void }) => {
      userPrompt = messages[1].content
      cb.onToken("# x")
      cb.onDone()
    })
    await buildAuraResearchStage(stage01, genInput({ corpus: "", category: "", generationPrompt: "", enableWebSearch: true }), {}, { llmConfig: USABLE_LLM })
    expect(userPrompt).not.toContain("【用户资料文本】")
    expect(userPrompt).toContain("人物分类：自定义灵魂")
    expect(userPrompt).toContain("生成提示词：未提供")
    expect(userPrompt).toContain("AI 搜索：已开启")
  })
})

describe("synthesizeCustomAuraFields", () => {
  beforeEach(() => {
    streamChatMock.mockReset()
  })

  function llmReturn(raw: string): void {
    streamChatMock.mockImplementation(async (_c: unknown, _msgs: unknown, cb: { onToken: (t: string) => void; onDone: () => void }) => {
      cb.onToken(raw)
      cb.onDone()
    })
  }

  it("parses a fenced JSON summary from the LLM", async () => {
    llmReturn(`\`\`\`json\n${fullFieldsJson()}\n\`\`\``)
    const fields = await synthesizeCustomAuraFields(genInput(), {}, { llmConfig: USABLE_LLM })
    expect(fields.sourceNote).toBe("来源说明")
    expect(fields.honestyBoundaries).toBe("诚实边界")
  })

  it("parses a plain JSON summary without a fence", async () => {
    llmReturn(fullFieldsJson())
    const fields = await synthesizeCustomAuraFields(genInput(), {}, { llmConfig: USABLE_LLM })
    expect(fields.expressionDna).toBe("表达DNA")
  })

  it("throws and falls back when the LLM output has no JSON object", async () => {
    llmReturn("抱歉，我无法完成。")
    const input = genInput()
    const fields = await synthesizeCustomAuraFields(input, {}, { llmConfig: USABLE_LLM })
    expect(fields.sourceNote).toContain("基于用户资料整理出的自定义人物灵魂")
    expect(input.distillationFallbackNote).toContain("模型未返回有效 JSON")
  })

  it("throws and falls back when a required field is missing", async () => {
    llmReturn(JSON.stringify({ sourceNote: "x" }))
    const input = genInput()
    await synthesizeCustomAuraFields(input, {}, { llmConfig: USABLE_LLM })
    expect(input.distillationFallbackNote).toContain("模型结果缺少")
  })

  it("throws and falls back when a required field is an empty string", async () => {
    const partial = JSON.parse(fullFieldsJson()) as Record<string, string>
    partial.styleDescription = "   "
    llmReturn(JSON.stringify(partial))
    const input = genInput()
    await synthesizeCustomAuraFields(input, {}, { llmConfig: USABLE_LLM })
    expect(input.distillationFallbackNote).toContain("模型结果缺少 styleDescription")
  })

  it("falls back when streamChat throws", async () => {
    streamChatMock.mockRejectedValue(new Error("llm down"))
    const input = genInput()
    const fields = await synthesizeCustomAuraFields(input, { "01-writings.md": "# 资料" }, { llmConfig: USABLE_LLM })
    expect(fields.behaviorRules).toContain("写作行为规则")
    expect(input.distillationFallbackNote).toContain("llm down")
  })

  it("builds the synthesis prompt with research files and notes", async () => {
    let userPrompt = ""
    streamChatMock.mockImplementation(async (_c: unknown, messages: Array<{ content: string }>, cb: { onToken: (t: string) => void; onDone: () => void }) => {
      userPrompt = messages[1].content
      cb.onToken(fullFieldsJson())
      cb.onDone()
    })
    const input = genInput({ generationNotes: ["搜索失败"] })
    await synthesizeCustomAuraFields(
      input,
      { "01-writings.md": "# 公开资料", "02-conversations.md": "# 对话" },
      { llmConfig: USABLE_LLM },
    )
    expect(userPrompt).toContain("### 01 公开资料")
    expect(userPrompt).toContain("生成备注：")
    expect(userPrompt).toContain("- 搜索失败")
  })

  it("builds a synthesis prompt without research files or notes", async () => {
    let userPrompt = ""
    streamChatMock.mockImplementation(async (_c: unknown, messages: Array<{ content: string }>, cb: { onToken: (t: string) => void; onDone: () => void }) => {
      userPrompt = messages[1].content
      cb.onToken(fullFieldsJson())
      cb.onDone()
    })
    await synthesizeCustomAuraFields(genInput(), {}, { llmConfig: USABLE_LLM })
    expect(userPrompt).toContain("### 01 公开资料\n")
    expect(userPrompt).not.toContain("生成备注")
  })

  it("builds fallback fields with all source buckets populated", async () => {
    const input = fullInput()
    input.enableWebSearch = true
    input.distillationFallbackNote = "汇总降级"
    const fields = await synthesizeCustomAuraFields(
      input,
      {
        "01-writings.md": "# 公开资料\n- 要点A",
        "02-conversations.md": "## 对话\n- 要点B",
        "03-expression-dna.md": "表达",
        "04-external-views.md": "外部",
        "05-decisions.md": "决策",
        "06-timeline.md": "时间线",
      },
      { llmConfig: NO_LLM },
    )
    expect(fields.sourceNote).toContain("AI 搜索补充资料")
    expect(fields.sourceNote).toContain("提示词重点：提示词")
    expect(fields.sourceNote).toContain("汇总降级")
    expect(fields.behaviorRules).toContain("决策")
    expect(fields.notes).toContain("生成备注：备注一")
    expect(fields.mentalModel).toContain("决策")
    expect(fields.decisionHeuristics).toContain("决策")
    expect(fields.valueAntiPatterns).toContain("外部")
  })

  it("falls back to the store llmConfig when no config is injected (synthesize path)", async () => {
    streamChatMock.mockImplementation(async (_c: unknown, _msgs: unknown, cb: { onToken: (t: string) => void; onDone: () => void }) => {
      cb.onToken(fullFieldsJson())
      cb.onDone()
    })
    const fields = await synthesizeCustomAuraFields(genInput(), {})
    expect(fields.sourceNote).toBe("来源说明")
    expect(streamChatMock).toHaveBeenCalled()
  })

  it("records a generic note when streamChat fails with a non-Error value (synthesize path)", async () => {
    streamChatMock.mockRejectedValue("string failure")
    const input = genInput()
    await synthesizeCustomAuraFields(input, {}, { llmConfig: USABLE_LLM })
    expect(input.distillationFallbackNote).toContain("未知错误")
  })

  it("builds a synthesis prompt with blank category/prompt and web search enabled", async () => {
    let userPrompt = ""
    streamChatMock.mockImplementation(async (_c: unknown, messages: Array<{ content: string }>, cb: { onToken: (t: string) => void; onDone: () => void }) => {
      userPrompt = messages[1].content
      cb.onToken(fullFieldsJson())
      cb.onDone()
    })
    await synthesizeCustomAuraFields(
      genInput({ category: "", generationPrompt: "", enableWebSearch: true }),
      {},
      { llmConfig: USABLE_LLM },
    )
    expect(userPrompt).toContain("人物分类：自定义灵魂")
    expect(userPrompt).toContain("生成提示词：未提供")
    expect(userPrompt).toContain("AI 搜索：已开启")
  })

  it("builds fallback fields with empty research files and no search", async () => {
    const fields = await synthesizeCustomAuraFields(
      genInput({ enableWebSearch: false, generationPrompt: "" }),
      {},
      { llmConfig: NO_LLM },
    )
    expect(fields.sourceNote).toContain("仅依据你提供的资料")
    expect(fields.sourceNote).toContain("未提供额外提示词")
    expect(fields.sourceNote).toContain("当前可用资料仍然偏少")
    expect(fields.styleDescription).toContain("当前仍以有限资料推断整体气质")
    expect(fields.notes).not.toContain("生成备注")
    expect(fields.expressionDna).toContain("资料不足时")
    expect(fields.mentalModel).toContain("先判断角色真正害怕失去什么")
    expect(fields.decisionHeuristics).toContain("面对选择时，先判断优先级")
    expect(fields.valueAntiPatterns).toContain("不要把角色写成全对")
  })
})

describe("buildAuraResearchStageFallback", () => {
  it("renders 01-writings with all sources populated", () => {
    const out = buildAuraResearchStageFallback(stage01, { ...fullInput(), enableWebSearch: true }, {})
    expect(out).toContain("# 林动 - 公开资料")
    expect(out).toContain("- 角色定位：主角。")
    expect(out).toContain("- 提示词焦点：提示词。")
    expect(out).toContain("用户资料 + AI 搜索补充")
    expect(out).toContain("- 联网补充的外部线索显示：")
    expect(out).toContain("- 备注一")
    expect(out).toContain("### 生成提示词")
    expect(out).toContain("## 网页资料正文")
    expect(out).toContain("## 本地文档正文")
    expect(out).toContain("## AI 搜索网页正文")
  })

  it("renders 01-writings with no sources and web search disabled", () => {
    const out = buildAuraResearchStageFallback(
      stage01,
      genInput({ corpus: "", sourceUrls: "", localDocumentPaths: "", category: "", generationPrompt: "" }),
      {},
    )
    expect(out).toContain("- 角色定位：自定义灵魂。")
    expect(out).toContain("未提供，主要依靠用户资料归纳。")
    expect(out).toContain("仅用户资料")
    expect(out).toContain("- 若需要更像真人语感，建议补充公开讲话")
    expect(out).toContain("当前仍需补充：角色资料文本")
    expect(out).toContain("- 若资料不足，后续小节会使用「基于现有资料的推断」进行扩写。")
    expect(out).toContain("## 网页资料正文\n\n未读取到网页资料正文。")
    expect(out).toContain("## 本地文档正文\n\n未读取到本地文档正文。")
    expect(out).toContain("## AI 搜索网页正文\n\n未开启 AI 搜索。")
  })

  it("renders 01-writings missing hints for each bucket", () => {
    const out1 = buildAuraResearchStageFallback(
      stage01,
      genInput({ corpus: "", localDocumentPaths: "/d/x.md", importedDocuments: [] }),
      {},
    )
    expect(out1).toContain("可读取的本地文档正文")
    const out2 = buildAuraResearchStageFallback(
      stage01,
      genInput({ corpus: "", sourceUrls: "https://x.com", importedUrls: [] }),
      {},
    )
    expect(out2).toContain("可抓取的网页正文")
    const out3 = buildAuraResearchStageFallback(
      stage01,
      genInput({ corpus: "", enableWebSearch: true, webSearchResults: [] }),
      {},
    )
    expect(out3).toContain("可用的 AI 搜索结果")
  })

  it("renders 02-conversations with and without a prior 01 file", () => {
    const withPrev = buildAuraResearchStageFallback(stage02, genInput(), { "01-writings.md": "# 前序资料" })
    expect(withPrev).toContain("结合公开资料可推断：")
    const withoutPrev = buildAuraResearchStageFallback(stage02, genInput({ corpus: "" }), {})
    expect(withoutPrev).toContain("当前资料不足，建议后续补充冲突语境下的原始表达样本")
    expect(withoutPrev).toContain("缺少直接对白素材")
  })

  it("renders 03-expression-dna with and without a prior 02 file", () => {
    const withPrev = buildAuraResearchStageFallback(stage03, genInput(), { "02-conversations.md": "# 对话" })
    expect(withPrev).toContain("对话方式可进一步支撑表达 DNA：")
    const withoutPrev = buildAuraResearchStageFallback(stage03, genInput(), {})
    expect(withoutPrev).toContain("若后续补充更多对白")
  })

  it("renders 04-external-views with and without prior 01 / search docs", () => {
    const withAll = buildAuraResearchStageFallback(
      stage04,
      genInput({ importedSearchDocuments: [{ title: "t", url: "u", snippet: "舆论", source: "s", query: "q", content: "c" }] }),
      { "01-writings.md": "# 公开" },
    )
    expect(withAll).toContain("可参考公开资料中的正面线索：")
    expect(withAll).toContain("AI 搜索补充的舆论线索：")
    const none = buildAuraResearchStageFallback(stage04, genInput(), {})
    expect(none).toContain("当前缺少正面旁观材料")
    expect(none).toContain("当前没有足够的外部评价样本")
  })

  it("renders 05-decisions with and without a prior 04 file", () => {
    const withPrev = buildAuraResearchStageFallback(stage05, genInput(), { "04-external-views.md": "# 外部" })
    expect(withPrev).toContain("外部评价能反推其决策代价：")
    const withoutPrev = buildAuraResearchStageFallback(stage05, genInput(), {})
    expect(withoutPrev).toContain("当前资料不足，建议补充角色在危机、冲突、背叛或资源紧缺时的真实选择案例")
  })

  it("renders 06-timeline with and without search docs / prior 05 file", () => {
    const withAll = buildAuraResearchStageFallback(
      stage06,
      genInput({ importedSearchDocuments: [{ title: "t", url: "u", snippet: "s", source: "s", query: "q", content: "关键事件" }] }),
      { "05-decisions.md": "# 决策" },
    )
    expect(withAll).toContain("AI 搜索补充的关键事件线索：")
    expect(withAll).toContain("决策记录可反推关系转折：")
    const none = buildAuraResearchStageFallback(stage06, genInput(), {})
    expect(none).toContain("当前仍缺关键事件链条")
    expect(none).toContain("若资料缺少关系信息")
  })

  it("renders 01-writings with a search document whose content is undefined", () => {
    const out = buildAuraResearchStageFallback(
      stage01,
      genInput({ importedSearchDocuments: [{ title: "t", url: "u", snippet: "s", source: "s", query: "q" } as never] }),
      {},
    )
    expect(out).toContain("- 联网补充的外部线索显示：。")
  })

  it("renders 02-conversations with a blank prompt", () => {
    const out = buildAuraResearchStageFallback(stage02, genInput({ generationPrompt: "", corpus: "" }), {})
    expect(out).toContain("围绕「林动」展开")
  })

  it("renders 03-expression-dna with a blank prompt", () => {
    const out = buildAuraResearchStageFallback(stage03, genInput({ generationPrompt: "" }), {})
    expect(out).toContain("重点围绕提示词「林动」构造词汇域")
  })

  it("renders 04-external-views with a search doc without snippet", () => {
    const out = buildAuraResearchStageFallback(
      stage04,
      genInput({ importedSearchDocuments: [{ title: "t", url: "u", source: "s", query: "q", content: "c" } as never] }),
      {},
    )
    expect(out).toContain("AI 搜索补充的舆论线索：")
  })

  it("renders 05-decisions with a blank prompt", () => {
    const out = buildAuraResearchStageFallback(stage05, genInput({ generationPrompt: "" }), {})
    expect(out).toContain("未提供，需要从资料中继续归纳")
  })

  it("renders 06-timeline with a blank corpus and a search doc without content", () => {
    const out = buildAuraResearchStageFallback(
      stage06,
      genInput({ corpus: "", importedSearchDocuments: [{ title: "t", url: "u", snippet: "s", source: "s", query: "q" } as never] }),
      {},
    )
    expect(out).toContain("资料较少，建议补充出身")
    expect(out).toContain("AI 搜索补充的关键事件线索：")
  })

  it("renders the default placeholder for unknown stages", () => {
    const unknown = { fileName: "99-other.md", label: "99 其它", sections: [], goal: "" } as unknown as typeof stage01
    const out = buildAuraResearchStageFallback(unknown, genInput(), {})
    expect(out).toContain("# 林动 - 其它")
    expect(out).toContain("当前阶段没有可用的默认模板")
  })
})
