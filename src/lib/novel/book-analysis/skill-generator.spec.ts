import { describe, it, expect, vi, beforeEach } from "vitest"
import {
  generateCharacterSkill,
  generateSimpleSkillMarkdown,
  generateSkillsForCharacters,
  isSixDimensionSkill,
} from "./skill-generator"
import type { BookAnalysisMetadata, ExtractedCharacter } from "./types"
import type { LlmConfig } from "@/stores/wiki-store"

const fsMocks = vi.hoisted(() => ({
  writeFile: vi.fn(async () => undefined),
}))

vi.mock("@/commands/fs", () => ({
  writeFile: (...args: Parameters<typeof fsMocks.writeFile>) => fsMocks.writeFile(...args),
}))

const streamChatMock = vi.fn()
vi.mock("@/lib/llm-client", () => ({
  streamChat: (...args: unknown[]) => streamChatMock(...args),
  combineAbortSignals: (signal?: AbortSignal, timeoutSignal?: AbortSignal): AbortSignal | undefined => {
    const signals = [signal, timeoutSignal].filter(Boolean) as AbortSignal[]
    if (signals.length === 0) return undefined
    if (signals.length === 1) return signals[0]
    const controller = new AbortController()
    for (const s of signals) {
      if (s.aborted) { controller.abort(); break }
      s.addEventListener("abort", () => controller.abort(), { once: true })
    }
    return controller.signal
  },
  DEFAULT_LLM_REQUEST_TIMEOUT_MS: 30 * 60 * 1000,
}))

const metadata: BookAnalysisMetadata = {
  title: "长夜书",
  author: "夜航",
  totalChapters: 3,
  totalWords: 12000,
  sourceType: "file",
  createdAt: 1,
  updatedAt: 2,
}

const stubLlmConfig: LlmConfig = {
  provider: "openai",
  apiKey: "x",
  model: "x",
  ollamaUrl: "http://127.0.0.1:1",
  customEndpoint: "http://127.0.0.1:1",
  maxContextSize: 8000,
}

const baseCharacter: ExtractedCharacter = {
  id: "1", name: "许七安", aliases: ["许七"], importance: 1, category: "protagonist",
  firstAppearance: 1, lastAppearance: 2, appearanceCount: 2,
  description: "desc", personality: "p", speechStyle: "s",
  relationships: [{ target: "临安", relation: "知己", description: "儿时玩伴" }],
  keyEvents: [],
}

const sixDimResearch = {
  publicMaterial: "公开资料内容",
  speechStyle: "说话风格", expressionDna: "表情",
  externalViews: "外界看法", decisionLog: "决策", timeline: "时间线",
}
const sixDimMeta = {
  depth: "standard" as const, schemaVersion: 1 as const, generatedAt: 1,
  webSearchUsed: false, llmFallbackUsed: false, sourceNote: "测试",
}

beforeEach(() => {
  streamChatMock.mockReset()
  fsMocks.writeFile.mockClear()
})

describe("isSixDimensionSkill", () => {
  it("research 与 meta 都存在 → true", () => {
    expect(isSixDimensionSkill({ ...baseCharacter, sixDimensionResearch: sixDimResearch, sixDimensionMeta: sixDimMeta })).toBe(true)
  })
  it("仅 research → false", () => {
    expect(isSixDimensionSkill({ ...baseCharacter, sixDimensionResearch: sixDimResearch })).toBe(false)
  })
  it("仅 meta → false", () => {
    expect(isSixDimensionSkill({ ...baseCharacter, sixDimensionMeta: sixDimMeta })).toBe(false)
  })
  it("都没有 → false", () => {
    expect(isSixDimensionSkill(baseCharacter)).toBe(false)
  })
})

describe("generateSimpleSkillMarkdown", () => {
  it("包含 4 字段 + 代表性台词", () => {
    const md = generateSimpleSkillMarkdown({
      characterName: "许七安",
      profile: {
        personality: "机智", motivation: "上位", speechStyle: "犀利",
        behaviorPatterns: "果断", quotes: ["q1", "q2", "q3"],
      },
      sourceBook: "长夜书",
    })
    expect(md).toContain("许七安")
    expect(md).toContain("机智")
    expect(md).toContain("上位")
    expect(md).toContain("犀利")
    expect(md).toContain("果断")
    expect(md).toContain("q1")
    expect(md).toContain("q3")
    expect(md).toContain("长夜书")
  })

  it("sourceBook 缺省时显示未知", () => {
    const md = generateSimpleSkillMarkdown({
      characterName: "A",
      profile: { personality: "", motivation: "", speechStyle: "", behaviorPatterns: "", quotes: [] },
    })
    expect(md).toContain("未知")
  })
})

describe("generateCharacterSkill 模式分支", () => {
  it("personalityProfile 存在时走简单提取模板，不调 LLM", async () => {
    const c: ExtractedCharacter = {
      ...baseCharacter,
      personalityProfile: {
        personality: "机智", motivation: "上位", speechStyle: "犀利",
        behaviorPatterns: "果断", quotes: ["q1", "q2"],
      },
    }
    const md = await generateCharacterSkill(c, metadata, stubLlmConfig)
    expect(md).toContain("许七安")
    expect(md).toContain("机智")
    expect(md).toContain("代表性台词")
    expect(streamChatMock).not.toHaveBeenCalled()
  })

  it("sixDimensionResearch 存在时走 6 维度模板（含 aliasMap 分支）", async () => {
    const c: ExtractedCharacter = {
      ...baseCharacter,
      sixDimensionResearch: sixDimResearch,
      sixDimensionMeta: sixDimMeta,
      aliasMap: { canonical: "许七安", aliases: ["许七", "许七安"] },
    }
    const md = await generateCharacterSkill(c, metadata, stubLlmConfig)
    expect(md).toContain("许七安")
    expect(md).toContain("公开资料内容")
    expect(md).toContain("6 维度分析")
    expect(md).toContain("standard")
    expect(md).toContain("许七") // aliasMap aliases
    expect(streamChatMock).not.toHaveBeenCalled()
  })

  it("6 维度模板：无 aliasMap 时用 name+aliases；description 截断 100；author 缺失", async () => {
    const c: ExtractedCharacter = {
      ...baseCharacter,
      description: "很长的描述".repeat(40),
      sixDimensionResearch: { ...sixDimResearch, publicMaterial: "" },
      sixDimensionMeta: sixDimMeta,
    }
    const metaNoAuthor: BookAnalysisMetadata = { ...metadata, author: undefined }
    const md = await generateCharacterSkill(c, metaNoAuthor, stubLlmConfig)
    expect(md).toContain("许七")
    expect(md).toContain("未知") // author 缺失
    expect(md).toContain("（空）") // publicMaterial 为空
    expect(md).not.toContain("很长的描述".repeat(40)) // 截断到 100
  })

  it("fallback: 无 profile 无 6d → 走 LLM；内容带 frontmatter 时不补 frontmatter；author 缺失走未知", async () => {
    const llmContent = `---
name: 许七安
---

# 正文`
    streamChatMock.mockImplementation(async (_cfg: unknown, _msgs: unknown, callbacks: {
      onToken: (t: string) => void
      onDone: () => void
    }) => {
      callbacks.onToken(llmContent)
      callbacks.onDone()
    })
    const md = await generateCharacterSkill(baseCharacter, { ...metadata, author: undefined }, stubLlmConfig)
    expect(streamChatMock).toHaveBeenCalledTimes(1)
    expect(md).toBe(llmContent)
    expect(streamChatMock.mock.calls[0][1]).toContainEqual({ role: "user", content: expect.stringContaining("未知") })
  })

  it("fallback: LLM 内容无 frontmatter → 自动补 frontmatter + onError 分支", async () => {
    streamChatMock.mockImplementation(async (_cfg: unknown, _msgs: unknown, callbacks: {
      onToken: (t: string) => void
      onError: (e: unknown) => void
    }) => {
      callbacks.onToken("# 角色内容")
      callbacks.onError(new Error("stream failed"))
    })
    const md = await generateCharacterSkill(baseCharacter, metadata, stubLlmConfig)
    expect(md.startsWith("---")).toBe(true)
    expect(md).toContain("name: 许七安")
    expect(md).toContain("# 角色内容")
  })

  it("fallback: onError 收到非 Error 值", async () => {
    streamChatMock.mockImplementation(async (_cfg: unknown, _msgs: unknown, callbacks: {
      onToken: (t: string) => void
      onError: (e: unknown) => void
    }) => {
      callbacks.onToken("x")
      callbacks.onError("raw string")
    })
    const md = await generateCharacterSkill(baseCharacter, metadata, stubLlmConfig)
    expect(md).toContain("x")
  })

  it("fallback: streamChat 抛错 → 返回基础模板（空别名 / 有/无描述的关系）", async () => {
    streamChatMock.mockRejectedValue(new Error("LLM down"))
    const c: ExtractedCharacter = {
      ...baseCharacter,
      aliases: [],
      relationships: [
        { target: "临安", relation: "知己", description: "儿时玩伴" },
        { target: "张", relation: "对手" },
      ],
    }
    const md = await generateCharacterSkill(c, metadata, stubLlmConfig)
    expect(md).toContain("# 许七安")
    expect(md).toContain("无") // 别名空 → 无
    expect(md).toContain("- **临安**：知己 - 儿时玩伴")
    expect(md).toContain("- **张**：对手")
  })

  it("fallback: streamChat 抛非 Error 值", async () => {
    streamChatMock.mockRejectedValue("plain error")
    const md = await generateCharacterSkill(baseCharacter, metadata, stubLlmConfig)
    expect(md).toContain("## 角色基本信息")
  })
})

describe("generateSkillsForCharacters", () => {
  it("批量生成 + 写盘 + onProgress 中间/完成回调 + 安全文件名", async () => {
    streamChatMock.mockImplementation(async (_cfg: unknown, _msgs: unknown, callbacks: {
      onToken: (t: string) => void
    }) => {
      callbacks.onToken("# 生成内容")
    })
    const chars: ExtractedCharacter[] = [
      baseCharacter,
      { ...baseCharacter, id: "2", name: "临安 公主", aliases: [], sixDimensionMeta: sixDimMeta, sixDimensionResearch: sixDimResearch },
    ]
    const onProgress = vi.fn()
    const skills = await generateSkillsForCharacters(chars, metadata, "/tmp/book", stubLlmConfig, onProgress)

    expect(skills).toHaveLength(2)
    expect(skills[0].id).toBe("skill-1")
    expect(skills[0].characterName).toBe("许七安")
    expect(skills[0].chapterRange).toEqual(["1", "2"])
    expect(skills[0].filePath).toContain("skills/许七安-skill.md")
    // 特殊字符 → 下划线
    expect(skills[1].filePath).toContain("skills/临安_公主-skill.md")
    // sixDimensionMeta 透传
    expect(skills[1].depth).toBe("standard")
    expect(skills[1].sixDimensionMeta).toBe(sixDimMeta)
    expect(fsMocks.writeFile).toHaveBeenCalledTimes(2)
    // onProgress: 2 次中间 + 1 次完成
    const calls = onProgress.mock.calls.map((c) => c[0])
    expect(calls).toHaveLength(3)
    expect(calls[0].stage).toBe("generating_skills")
    expect(calls[0].completed).toBe(0)
    expect(calls[0].percentage).toBe(90)
    expect(calls[2].stageLabel).toBe("Skill生成完成")
    expect(calls[2].percentage).toBe(100)
  })

  it("signal 已中止 → 抛 用户取消生成", async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(
      generateSkillsForCharacters([baseCharacter], metadata, "/tmp/book", stubLlmConfig, undefined, controller.signal),
    ).rejects.toThrow("用户取消生成")
    expect(fsMocks.writeFile).not.toHaveBeenCalled()
  })

  it("不传 onProgress 时正常完成", async () => {
    streamChatMock.mockImplementation(async (_cfg: unknown, _msgs: unknown, callbacks: {
      onToken: (t: string) => void
    }) => {
      callbacks.onToken("内容")
    })
    const skills = await generateSkillsForCharacters([baseCharacter], metadata, "/tmp/book", stubLlmConfig)
    expect(skills).toHaveLength(1)
  })
})
