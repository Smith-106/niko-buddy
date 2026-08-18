import { describe, expect, it, vi } from "vitest"

vi.mock("@/lib/llm-client", () => ({
  streamChat: vi.fn(),
  combineAbortSignals: vi.fn(),
  DEFAULT_LLM_REQUEST_TIMEOUT_MS: 1000,
}))
vi.mock("@/stores/wiki-store", () => ({
  useWikiStore: { getState: () => ({ llmConfig: {}, searchApiConfig: {} }) },
}))

import type { CharacterAura, CharacterAuraResearchFileName, CustomCharacterAuraGenerationInput } from "./character-aura-types"
import {
  buildStoredCorpus,
  customResearchMarkdown,
  customSkillMarkdown,
  customSourceIndexMarkdown,
  generationNotesMarkdown,
  localDocumentContentMarkdown,
  researchFilesSummaryMarkdown,
  searchDocumentContentMarkdown,
  storedCustomResearchMarkdown,
  storedCustomSkillMarkdown,
  urlDocumentContentMarkdown,
  workflowStageIndexMarkdown,
} from "./character-aura-markdown"

function aura(overrides: Partial<CharacterAura> = {}): CharacterAura {
  return {
    id: "custom-1",
    builtIn: false,
    name: "林动",
    category: "主角",
    sourceNote: "来源说明",
    corpus: "语料文本",
    styleDescription: "风格描述",
    behaviorRules: "行为规则",
    boundaries: "边界",
    notes: "备注",
    expressionDna: "表达DNA",
    mentalModel: "心智模型",
    decisionHeuristics: "决策启发式",
    valueAntiPatterns: "反模式",
    honestyBoundaries: "诚实边界",
    generationPrompt: "提示词",
    webSearchEnabled: true,
    skillFolder: "/P/.qmai/character-auras/custom-1-perspective",
    createdAt: 1,
    updatedAt: 2,
    ...overrides,
  }
}

function sparseAura(): CharacterAura {
  return {
    id: "custom-2",
    builtIn: false,
    name: "简·奥斯汀",
    category: undefined,
    sourceNote: "",
    corpus: "",
    styleDescription: "",
    behaviorRules: "仅行为",
    boundaries: "仅边界",
    notes: "",
    expressionDna: "仅气质描述",
    generationPrompt: "",
    skillFolder: "/s2",
  }
}

function genInput(overrides: Partial<CustomCharacterAuraGenerationInput> = {}): CustomCharacterAuraGenerationInput {
  return {
    name: "林动",
    category: "主角",
    corpus: "",
    sourceUrls: "https://a.com",
    localDocumentPaths: "/d/1.md",
    generationPrompt: "提示词",
    enableWebSearch: true,
    importedDocuments: [],
    failedDocuments: [],
    importedUrls: [],
    failedUrls: [],
    searchQueries: ["q1"],
    webSearchResults: [],
    importedSearchDocuments: [],
    failedSearchUrls: [],
    generationNotes: [],
    ...overrides,
  }
}

function fullInput(): CustomCharacterAuraGenerationInput {
  return genInput({
    corpus: "用户语料",
    importedDocuments: [{ path: "/d/1.md", content: "本地正文" }],
    failedDocuments: ["/d/bad.md"],
    importedUrls: [{ url: "https://a.com", content: "网页正文" }],
    failedUrls: ["https://bad.com"],
    webSearchResults: [
      { title: "标题1", url: "https://s1.com", snippet: "摘要1", source: "tavily" },
      { title: "标题2", url: "https://s2.com", snippet: "摘要2", source: "tavily" },
      { title: "标题3", url: "https://s3.com", snippet: "摘要3", source: "tavily" },
    ],
    importedSearchDocuments: [
      { title: "正文标题", url: "https://s1.com", snippet: "摘要", source: "tavily", query: "q1", content: "正文内容" },
    ],
    failedSearchUrls: ["https://s4.com"],
    searchQueries: ["q1", "q2"],
    generationNotes: ["搜索备注"],
    distillationFallbackNote: "汇总降级",
  })
}

describe("customSkillMarkdown", () => {
  it("renders the full skill with notes and research summaries", () => {
    const md = customSkillMarkdown(aura(), fullInput(), { "01-writings.md": "# 公开资料\n- 要点" })
    expect(md).toContain("name: 林动")
    expect(md).toContain("# 林动 · 自定义人物灵魂操作系统")
    expect(md).toContain("- 分类：主角")
    expect(md).toContain("## 生成备注")
    expect(md).toContain("- 搜索备注")
    expect(md).toContain("- 汇总降级")
    expect(md).toContain("### 01 公开资料")
    expect(md).toContain("研究资料/06-timeline.md：06 时间线")
    expect(md).toContain("## 诚实边界\n\n诚实边界")
  })

  it("renders without notes and with empty research files", () => {
    const md = customSkillMarkdown(aura(), genInput(), {})
    expect(md).not.toContain("## 生成备注")
    expect(md).toContain("当前还没有该阶段的研究摘要。")
    expect(md).toContain("## 核心心智模型")
  })
})

describe("customSourceIndexMarkdown", () => {
  it("renders every populated section", () => {
    const md = customSourceIndexMarkdown(fullInput())
    expect(md).toContain("## 资料索引")
    expect(md).toContain("提示词")
    expect(md).toContain("- 状态：已开启")
    expect(md).toContain("- 检索词：q1；q2")
    expect(md).toContain("- https://a.com")
    expect(md).toContain("- /d/1.md")
    expect(md).toContain("- 标题1｜tavily")
    expect(md).toContain("- https://s4.com")
    expect(md).toContain("- 搜索备注")
  })

  it("renders placeholder sections for empty input", () => {
    const md = customSourceIndexMarkdown({})
    expect(md).toContain("- 未填写")
    expect(md).toContain("- 检索词：未生成")
    expect(md).toContain("- 未开启 AI 搜索")
    expect(md).not.toContain("联网抓取失败")
  })

  it("uses webSearchEnabled when enableWebSearch is absent", () => {
    const md = customSourceIndexMarkdown({ webSearchEnabled: true })
    expect(md).toContain("- 状态：已开启")
    expect(md).toContain("- 本次未拿到可用的 AI 搜索结果")
  })

  it("caps the search result list at 5", () => {
    const many = Array.from({ length: 7 }, (_, i) => ({
      title: `标题${i}`,
      url: `https://s${i}.com`,
      snippet: `摘要${i}`,
      source: "tavily",
    }))
    const md = customSourceIndexMarkdown({ webSearchResults: many })
    expect(md).toContain("- 标题4｜tavily")
    expect(md).not.toContain("- 标题5｜tavily")
  })
})

describe("generationNotesMarkdown", () => {
  it("returns empty for no notes and a blank fallback", () => {
    expect(generationNotesMarkdown([], "   ")).toBe("")
    expect(generationNotesMarkdown()).toBe("")
  })

  it("renders notes and appends a non-blank fallback", () => {
    const md = generationNotesMarkdown(["备注一"], "降级说明")
    expect(md).toContain("## 生成备注")
    expect(md).toContain("- 备注一")
    expect(md).toContain("- 降级说明")
  })
})

describe("workflowStageIndexMarkdown", () => {
  it("lists all six stages with their goals", () => {
    const md = workflowStageIndexMarkdown()
    expect(md).toContain("1. 01 公开资料：整理角色的公开资料")
    expect(md).toContain("6. 06 时间线：构建角色的时间线")
  })
})

describe("researchFilesSummaryMarkdown", () => {
  it("renders content for populated stages and placeholders for the rest", () => {
    const md = researchFilesSummaryMarkdown({ "01-writings.md": "# 标题\n- 要点" })
    expect(md).toContain("## 工作流产出摘要")
    expect(md).toContain("### 01 公开资料")
    expect(md).toContain("标题 要点")
    expect(md).toContain("当前还没有该阶段的研究摘要。")
  })

  it("renders placeholders for an empty map", () => {
    const md = researchFilesSummaryMarkdown({})
    expect(md.match(/当前还没有该阶段的研究摘要。/g)).toHaveLength(6)
  })
})

describe("localDocumentContentMarkdown", () => {
  it("renders imported docs and failures", () => {
    const md = localDocumentContentMarkdown(fullInput())
    expect(md).toContain("## 本地文档正文")
    expect(md).toContain("### /d/1.md")
    expect(md).toContain("- /d/bad.md：读取失败")
  })

  it("renders the empty placeholder when nothing was imported", () => {
    const md = localDocumentContentMarkdown(genInput())
    expect(md).toContain("未读取到本地文档正文。")
    expect(md).not.toContain("读取失败")
  })
})

describe("urlDocumentContentMarkdown", () => {
  it("renders imported urls and failures", () => {
    const md = urlDocumentContentMarkdown(fullInput())
    expect(md).toContain("## 网页资料正文")
    expect(md).toContain("### https://a.com")
    expect(md).toContain("- https://bad.com：读取失败")
  })

  it("renders the empty placeholder when nothing was imported", () => {
    const md = urlDocumentContentMarkdown(genInput())
    expect(md).toContain("未读取到网页资料正文。")
  })
})

describe("searchDocumentContentMarkdown", () => {
  it("renders imported search docs and failures", () => {
    const md = searchDocumentContentMarkdown(fullInput())
    expect(md).toContain("## AI 搜索网页正文")
    expect(md).toContain("### 正文标题")
    expect(md).toContain("- 检索词：q1")
    expect(md).toContain("- https://s4.com：读取失败")
  })

  it("distinguishes search-enabled from search-disabled placeholders", () => {
    const enabled = searchDocumentContentMarkdown(genInput({ enableWebSearch: true }))
    expect(enabled).toContain("未读取到可用的 AI 搜索网页正文。")
    const disabled = searchDocumentContentMarkdown(genInput({ enableWebSearch: false }))
    expect(disabled).toContain("未开启 AI 搜索。")
  })
})

describe("buildStoredCorpus", () => {
  it("returns the trimmed corpus when present", () => {
    expect(buildStoredCorpus(genInput({ corpus: "  语料  " }))).toBe("语料")
  })

  it("builds from the generation prompt when corpus is absent", () => {
    const corpus = buildStoredCorpus(genInput({ corpus: "" }))
    expect(corpus).toBe("提示词：提示词")
  })

  it("includes search result summaries", () => {
    const corpus = buildStoredCorpus(
      genInput({ corpus: "", generationPrompt: "", webSearchResults: [{ title: "标题", url: "u", snippet: "摘要", source: "s" }] }),
    )
    expect(corpus).toContain("AI 搜索摘要：")
    expect(corpus).toContain("- 标题：摘要")
  })

  it("includes local document excerpts", () => {
    const corpus = buildStoredCorpus(
      genInput({ corpus: "", generationPrompt: "", importedDocuments: [{ path: "/d/1.md", content: "本地正文" }] }),
    )
    expect(corpus).toContain("- /d/1.md：本地正文")
  })

  it("includes url excerpts", () => {
    const corpus = buildStoredCorpus(
      genInput({ corpus: "", generationPrompt: "", importedUrls: [{ url: "https://a.com", content: "网页正文" }] }),
    )
    expect(corpus).toContain("- https://a.com：网页正文")
  })

  it("falls back to the index-only message when nothing is available", () => {
    expect(buildStoredCorpus(genInput({ corpus: "", generationPrompt: "" }))).toBe(
      "用户未填写资料文本，仅提供资料索引。",
    )
  })
})

describe("customResearchMarkdown", () => {
  it("renders all six files with a full aura", () => {
    const input = fullInput()
    const out01 = customResearchMarkdown(aura(), input, "01-writings.md")
    expect(out01).toContain("# 林动 - 公开资料")
    expect(out01).toContain("## 本地文档正文")
    expect(out01).toContain("## 生成备注")
    const out02 = customResearchMarkdown(aura(), input, "02-conversations.md")
    expect(out02).toContain("## 已沉淀的灵魂摘要")
    expect(out02).toContain("## 资料证据线索")
    const out03 = customResearchMarkdown(aura(), input, "03-expression-dna.md")
    expect(out03).toContain("## 当前灵魂字段映射")
    expect(out03).toContain("- 表达特征：表达DNA")
    const out04 = customResearchMarkdown(aura(), input, "04-external-views.md")
    expect(out04).toContain("## 当前外部视角摘要")
    expect(out04).toContain("## 反模式提醒")
    const out05 = customResearchMarkdown(aura(), input, "05-decisions.md")
    expect(out05).toContain("## 当前决策启发式")
    expect(out05).toContain("## 当前心智模型")
    const out06 = customResearchMarkdown(aura(), input, "06-timeline.md")
    expect(out06).toContain("## 当前资料摘要")
    expect(out06).toContain("## AI 搜索网页正文")
  })

  it("renders with a sparse aura and empty input", () => {
    const input = genInput({ corpus: "", generationPrompt: "", generationNotes: [] })
    const out02 = customResearchMarkdown(sparseAura(), input, "02-conversations.md")
    expect(out02).toContain(auraFallbackStyle())
    const out03 = customResearchMarkdown(sparseAura(), input, "03-expression-dna.md")
    expect(out03).toContain("- 表达特征：仅气质描述")
    const out04 = customResearchMarkdown(sparseAura(), input, "04-external-views.md")
    expect(out04).toContain("## 反模式提醒")
    const out05 = customResearchMarkdown(sparseAura(), input, "05-decisions.md")
    expect(out05).toContain("## 当前决策启发式")
    const out06 = customResearchMarkdown(sparseAura(), input, "06-timeline.md")
    expect(out06).toContain("待用户继续补充资料文本。")
  })
})

function auraFallbackStyle(): string {
  return "仅气质描述"
}

describe("storedCustomSkillMarkdown", () => {
  it("renders with a full aura and research summaries", () => {
    const md = storedCustomSkillMarkdown(aura(), { "01-writings.md": "# 公开" })
    expect(md).toContain("name: 林动")
    expect(md).toContain("## 资料导入设置")
    expect(md).toContain("- 状态：已开启")
    expect(md).toContain("## 核心心智模型\n\n心智模型")
    expect(md).toContain("### 01 公开资料")
  })

  it("renders fallback fields for a sparse aura", () => {
    const md = storedCustomSkillMarkdown({
      id: "custom-2",
      builtIn: false,
      name: "简·奥斯汀",
      sourceNote: "",
      corpus: "语料",
      styleDescription: "仅气质描述",
      behaviorRules: "仅行为",
      boundaries: "仅边界",
      notes: "",
      generationPrompt: "",
      skillFolder: "/s2",
    })
    expect(md).toContain("## 核心心智模型\n\n语料")
    expect(md).toContain("## 决策启发式\n\n仅行为")
    expect(md).toContain("## 表达特征\n\n仅气质描述")
    expect(md).toContain("## 价值观与反模式")
    expect(md).toContain("## 诚实边界\n\n仅边界")
  })
})

describe("storedCustomResearchMarkdown", () => {
  it("renders all six files with a full aura", () => {
    const out01 = storedCustomResearchMarkdown(aura(), "01-writings.md")
    expect(out01).toContain("# 林动 - 公开资料")
    expect(out01).toContain("- 角色定位：主角。")
    expect(out01).toContain("- 气质说明：来源说明。")
    const out02 = storedCustomResearchMarkdown(aura(), "02-conversations.md")
    expect(out02).toContain("## 说话节奏\n风格描述")
    expect(out02).toContain("## 常用表达策略\n表达DNA")
    expect(out02).toContain("## 冲突中的说话方式\n决策启发式")
    const out03 = storedCustomResearchMarkdown(aura(), "03-expression-dna.md")
    expect(out03).toContain("## 词汇偏好\n表达DNA")
    expect(out03).toContain("## 情绪显影\n风格描述")
    expect(out03).toContain("## 表达禁区\n诚实边界")
    const out04 = storedCustomResearchMarkdown(aura(), "04-external-views.md")
    expect(out04).toContain("## 支持者视角\n来源说明")
    expect(out04).toContain("## 对手视角\n反模式")
    const out05 = storedCustomResearchMarkdown(aura(), "05-decisions.md")
    expect(out05).toContain("## 核心优先级\n心智模型")
    expect(out05).toContain("## 典型取舍\n反模式")
    const out06 = storedCustomResearchMarkdown(aura(), "06-timeline.md")
    expect(out06).toContain("## 起点\n语料文本")
    expect(out06).toContain("## 关系变化\n备注")
    expect(out06).toContain("## 未来可延展线索")
  })

  it("renders fallbacks for a sparse aura", () => {
    const out01 = storedCustomResearchMarkdown(sparseAura(), "01-writings.md")
    expect(out01).toContain("- 角色定位：自定义灵魂。")
    expect(out01).toContain("- 气质说明：待补充。")
    expect(out01).toContain("- 生成提示词：未填写。")
    expect(out01).toContain("## 证据线索\n待用户继续补充资料文本。")
    const out02 = storedCustomResearchMarkdown(sparseAura(), "02-conversations.md")
    expect(out02).toContain("## 说话节奏\n待补充")
    const out03 = storedCustomResearchMarkdown(sparseAura(), "03-expression-dna.md")
    expect(out03).toContain("## 情绪显影\n待补充")
    expect(out03).toContain("## 叙事镜头感\n待补充")
    const out04 = storedCustomResearchMarkdown(sparseAura(), "04-external-views.md")
    expect(out04).toContain("## 支持者视角\n待补充")
    const out05 = storedCustomResearchMarkdown(sparseAura(), "05-decisions.md")
    expect(out05).toContain("## 高压下的选择\n仅行为")
    expect(out05).toContain("## 失败代价\n仅边界")
    const out06 = storedCustomResearchMarkdown(sparseAura(), "06-timeline.md")
    expect(out06).toContain("## 起点\n待用户补充出身、早期处境和最初欲望。")
    expect(out06).toContain("## 关系变化\n待补充")
  })
})

describe("character-aura-markdown residual branches", () => {
  it("customSkillMarkdown falls back to 自定义灵魂 when category is absent", () => {
    const md = customSkillMarkdown(aura({ category: undefined }), fullInput(), {})
    expect(md).toContain("- 分类：自定义灵魂")
  })

  it("searchDocumentContentMarkdown falls back for empty query and snippet", () => {
    const md = searchDocumentContentMarkdown(
      genInput({
        importedSearchDocuments: [
          { title: "t", url: "https://x.com", snippet: "", source: "tavily", query: "", content: "c" },
        ],
      }),
    )
    expect(md).toContain("- 检索词：未记录")
    expect(md).toContain("- 摘要：无")
  })

  it("customResearchMarkdown falls back to the first workflow stage for an unknown fileName", () => {
    const out = customResearchMarkdown(aura(), fullInput(), "99-invalid.md" as unknown as CharacterAuraResearchFileName) // 故意构造非法 fileName 测回退分支
    // stageForResearchFile 未命中时回退 AURA_WORKFLOW_STAGES[0]，而 content 表无该键 → undefined
    expect(out).toBeUndefined()
  })

  it("customResearchMarkdown falls back to styleDescription when expressionDna is empty", () => {
    const a = aura({ expressionDna: "", styleDescription: "风格描述" })
    const out02 = customResearchMarkdown(a, fullInput(), "02-conversations.md")
    expect(out02).toContain("## 表达特征补充\n\n风格描述")
    const out03 = customResearchMarkdown(a, fullInput(), "03-expression-dna.md")
    expect(out03).toContain("- 表达特征：风格描述")
  })

  it("storedCustomResearchMarkdown falls back to styleDescription when expressionDna is absent", () => {
    const a = aura({ expressionDna: undefined, styleDescription: "风格描述" })
    const out01 = storedCustomResearchMarkdown(a, "01-writings.md")
    expect(out01).toContain("- 表达特征：风格描述")
    const out02 = storedCustomResearchMarkdown(a, "02-conversations.md")
    expect(out02).toContain("## 常用表达策略\n风格描述")
    const out03 = storedCustomResearchMarkdown(a, "03-expression-dna.md")
    expect(out03).toContain("## 词汇偏好\n风格描述")
  })
})
