import { describe, it, expect, vi } from "vitest"
import { extractSimpleProfiles, extractSingleProfile } from "./simple-extraction-engine"
import type { RecognizedCharacter } from "./types"
import type { LlmConfig } from "@/stores/wiki-store"

const defaultLlmCallMock = vi.hoisted(() =>
  vi.fn(async () => JSON.stringify([]))
)

vi.mock("@/lib/llm-client", () => ({
  defaultLlmCall: (...args: unknown[]) => defaultLlmCallMock(...args),
}))

const stubLlmConfig: LlmConfig = {
  provider: "openai",
  apiKey: "x",
  model: "x",
  ollamaUrl: "http://127.0.0.1:1",
  customEndpoint: "http://127.0.0.1:1",
  maxContextSize: 8000,
}

const empty = () => ({ personality: "", motivation: "", speechStyle: "", behaviorPatterns: "", quotes: [] })

describe("extractSimpleProfiles", () => {
  const candidates: RecognizedCharacter[] = [
    { id: "1", name: "许七安", aliases: [], appearances: 3, chapterIndices: [0, 1, 2], importanceScore: 95, category: "主角", sourceBook: "test" },
    { id: "2", name: "临安公主", aliases: [], appearances: 2, chapterIndices: [0, 1], importanceScore: 60, category: "配角", sourceBook: "test" },
  ]

  it("1 次 LLM 调用 + 输出每个角色的 profile + onProgress 回调", async () => {
    const llmCall = vi.fn().mockResolvedValue(JSON.stringify([
      { name: "许七安", personality: "机智", motivation: "上位", speechStyle: "犀利", behaviorPatterns: "果断", quotes: ["q1", "q2", "q3", "q4", "q5", "q6", "q7"] },
      { name: "临安公主", personality: "温柔", motivation: "自由", speechStyle: "婉约", behaviorPatterns: "隐忍", quotes: ["q1", "q2", "q3"] },
    ]))
    const onProgress = vi.fn()

    const result = await extractSimpleProfiles({
      candidates,
      chapterSamples: "x",
      llmConfig: stubLlmConfig,
      _llmCall: llmCall,
      onProgress,
    })

    expect(llmCall).toHaveBeenCalledTimes(1)
    expect(result.profiles).toHaveLength(2)
    expect(result.profiles[0].name).toBe("许七安")
    // quotes 截断到 5
    expect(result.profiles[0].profile.quotes).toHaveLength(5)
    expect(onProgress).toHaveBeenCalledWith(1, 2)
    expect(onProgress).toHaveBeenCalledWith(2, 2)
  })

  it("LLM 返回带 ```json 围栏时剥离后解析", async () => {
    const llmCall = vi.fn().mockResolvedValue("```json\n" + JSON.stringify([
      { name: "许七安", personality: "机智", motivation: "上位", speechStyle: "犀利", behaviorPatterns: "果断", quotes: [] },
    ]) + "\n```")
    const result = await extractSimpleProfiles({
      candidates: [candidates[0]],
      chapterSamples: "x",
      llmConfig: stubLlmConfig,
      _llmCall: llmCall,
    })
    expect(result.profiles[0].profile.personality).toBe("机智")
    expect(result.profiles[0].profile.quotes).toEqual([])
  })

  it("LLM 返回缺少某个角色时, 该角色走 emptyProfile", async () => {
    const llmCall = vi.fn().mockResolvedValue(JSON.stringify([
      { name: "许七安", personality: "机智", motivation: "上位", speechStyle: "犀利", behaviorPatterns: "果断", quotes: ["q"] },
    ]))
    const result = await extractSimpleProfiles({
      candidates,
      chapterSamples: "x",
      llmConfig: stubLlmConfig,
      _llmCall: llmCall,
    })
    expect(result.profiles[0].profile.personality).toBe("机智")
    expect(result.profiles[1].profile).toEqual(empty())
  })

  it("quotes 缺失时 ?? [] 兜底", async () => {
    const llmCall = vi.fn().mockResolvedValue(JSON.stringify([
      { name: "许七安", personality: "机智", motivation: "上位", speechStyle: "犀利", behaviorPatterns: "果断" },
    ]))
    const result = await extractSimpleProfiles({
      candidates: [candidates[0]],
      chapterSamples: "x",
      llmConfig: stubLlmConfig,
      _llmCall: llmCall,
    })
    expect(result.profiles[0].profile.quotes).toEqual([])
  })

  it("LLM 失败时每个角色返回空 profile + 标记 error (Error)", async () => {
    const llmCall = vi.fn().mockRejectedValue(new Error("fail"))
    const result = await extractSimpleProfiles({
      candidates,
      chapterSamples: "x",
      llmConfig: stubLlmConfig,
      _llmCall: llmCall,
    })
    expect(result.error).toBe("fail")
    expect(result.profiles[0].profile).toEqual(empty())
  })

  it("LLM 失败且抛非 Error 时 error 为 unknown error", async () => {
    const llmCall = vi.fn().mockRejectedValue("plain string")
    const result = await extractSimpleProfiles({
      candidates,
      chapterSamples: "x",
      llmConfig: stubLlmConfig,
      _llmCall: llmCall,
    })
    expect(result.error).toBe("unknown error")
  })

  it("signal 已中止时抛错进入 error 分支", async () => {
    const controller = new AbortController()
    controller.abort()
    const llmCall = vi.fn().mockResolvedValue(JSON.stringify([]))
    const result = await extractSimpleProfiles({
      candidates,
      chapterSamples: "x",
      llmConfig: stubLlmConfig,
      _llmCall: llmCall,
      signal: controller.signal,
    })
    expect(result.error).toBe("aborted")
  })

  it("parsed 非数组（对象）时 find 抛错进入 error 分支", async () => {
    const llmCall = vi.fn().mockResolvedValue('{"a":1}')
    const result = await extractSimpleProfiles({
      candidates: [candidates[0]],
      chapterSamples: "x",
      llmConfig: stubLlmConfig,
      _llmCall: llmCall,
    })
    expect(result.error).toBeDefined()
    expect(result.profiles[0].profile).toEqual(empty())
  })

  it("未注入 _llmCall 时回退 defaultLlmCall (mock)", async () => {
    defaultLlmCallMock.mockClear()
    const result = await extractSimpleProfiles({
      candidates: [candidates[0]],
      chapterSamples: "x",
      llmConfig: stubLlmConfig,
    })
    expect(defaultLlmCallMock).toHaveBeenCalledTimes(1)
    expect(result.profiles[0].profile).toEqual(empty())
    expect(result.error).toBeUndefined()
  })
})

describe("extractSingleProfile", () => {
  const character: RecognizedCharacter = {
    id: "1", name: "许七安", aliases: [], appearances: 3, chapterIndices: [0, 1, 2],
    importanceScore: 95, category: "主角", sourceBook: "test",
  }

  it("happy path: 数组命中角色, 字段透传, quotes 截断到 5", async () => {
    const llmCall = vi.fn().mockResolvedValue(JSON.stringify([
      { name: "许七安", personality: "机智", motivation: "上位", speechStyle: "犀利", behaviorPatterns: "果断", quotes: ["q1", "q2", "q3", "q4", "q5", "q6"] },
    ]))
    const result = await extractSingleProfile({
      character, chapterSamples: "x", llmConfig: stubLlmConfig, _llmCall: llmCall,
    })
    expect(result.error).toBeUndefined()
    expect(result.profile).toEqual({
      personality: "机智", motivation: "上位", speechStyle: "犀利", behaviorPatterns: "果断", quotes: ["q1", "q2", "q3", "q4", "q5"],
    })
  })

  it("字段缺失时 || '' 兜底, quotes 缺失 ?? []", async () => {
    const llmCall = vi.fn().mockResolvedValue(JSON.stringify([
      { name: "许七安" },
    ]))
    const result = await extractSingleProfile({
      character, chapterSamples: "x", llmConfig: stubLlmConfig, _llmCall: llmCall,
    })
    expect(result.profile).toEqual(empty())
  })

  it("未中止 signal 传入: signal?.aborted 为 false, 正常走通", async () => {
    const controller = new AbortController()
    const llmCall = vi.fn().mockResolvedValue(JSON.stringify([
      { name: "许七安", personality: "机智", motivation: "上位", speechStyle: "犀利", behaviorPatterns: "果断", quotes: ["q"] },
    ]))
    const result = await extractSingleProfile({
      character, chapterSamples: "x", llmConfig: stubLlmConfig, _llmCall: llmCall,
      signal: controller.signal,
    })
    expect(result.profile.personality).toBe("机智")
    expect(result.error).toBeUndefined()
  })

  it("markdown 围栏剥离", async () => {
    const llmCall = vi.fn().mockResolvedValue("```\n" + JSON.stringify([
      { name: "许七安", personality: "机智", motivation: "上位", speechStyle: "犀利", behaviorPatterns: "果断", quotes: ["q"] },
    ]) + "\n```")
    const result = await extractSingleProfile({
      character, chapterSamples: "x", llmConfig: stubLlmConfig, _llmCall: llmCall,
    })
    expect(result.profile.personality).toBe("机智")
  })

  it("JSON.parse 失败: 提取部分内容 errorKind=parse", async () => {
    const llmCall = vi.fn().mockResolvedValue("这是一段纯文本，没有 JSON")
    const result = await extractSingleProfile({
      character, chapterSamples: "x", llmConfig: stubLlmConfig, _llmCall: llmCall,
    })
    expect(result.errorKind).toBe("parse")
    expect(result.error).toContain("格式不正确")
    expect(result.profile.personality).toContain("纯文本")
  })

  it("parsed 非数组: 进入 parse 兜底", async () => {
    const llmCall = vi.fn().mockResolvedValue('{"not":"array"}')
    const result = await extractSingleProfile({
      character, chapterSamples: "x", llmConfig: stubLlmConfig, _llmCall: llmCall,
    })
    expect(result.errorKind).toBe("parse")
  })

  it("数组中未找到角色: errorKind=missing", async () => {
    const llmCall = vi.fn().mockResolvedValue(JSON.stringify([
      { name: "别人", personality: "x", motivation: "x", speechStyle: "x", behaviorPatterns: "x", quotes: [] },
    ]))
    const result = await extractSingleProfile({
      character, chapterSamples: "x", llmConfig: stubLlmConfig, _llmCall: llmCall,
    })
    expect(result.errorKind).toBe("missing")
    expect(result.error).toContain("未找到角色")
    expect(result.profile).toEqual(empty())
  })

  it("signal 已中止: throw aborted → errorKind=network", async () => {
    const controller = new AbortController()
    controller.abort()
    const llmCall = vi.fn().mockResolvedValue(JSON.stringify([{ name: "许七安" }]))
    const result = await extractSingleProfile({
      character, chapterSamples: "x", llmConfig: stubLlmConfig, _llmCall: llmCall,
      signal: controller.signal,
    })
    expect(result.error).toBe("aborted")
    expect(result.errorKind).toBe("network")
  })

  it("network 关键词 → errorKind=network", async () => {
    for (const msg of ["network error", "fetch failed", "request timeout"]) {
      const llmCall = vi.fn().mockRejectedValue(new Error(msg))
      const result = await extractSingleProfile({
        character, chapterSamples: "x", llmConfig: stubLlmConfig, _llmCall: llmCall,
      })
      expect(result.error).toBe(msg)
      expect(result.errorKind).toBe("network")
    }
  })

  it("aborted 关键词（Error 消息）→ errorKind=network", async () => {
    const llmCall = vi.fn().mockRejectedValue(new Error("aborted"))
    const result = await extractSingleProfile({
      character, chapterSamples: "x", llmConfig: stubLlmConfig, _llmCall: llmCall,
    })
    expect(result.errorKind).toBe("network")
  })

  it("未知错误 → errorKind=unknown", async () => {
    const llmCall = vi.fn().mockRejectedValue(new Error("boom"))
    const result = await extractSingleProfile({
      character, chapterSamples: "x", llmConfig: stubLlmConfig, _llmCall: llmCall,
    })
    expect(result.error).toBe("boom")
    expect(result.errorKind).toBe("unknown")
  })

  it("未注入 _llmCall 时回退 defaultLlmCall (mock)", async () => {
    defaultLlmCallMock.mockClear()
    const result = await extractSingleProfile({
      character, chapterSamples: "x", llmConfig: stubLlmConfig,
    })
    expect(defaultLlmCallMock).toHaveBeenCalledTimes(1)
    expect(result.errorKind).toBe("missing")
  })

  it("非 Error 抛错 → msg=unknown error, errorKind=unknown", async () => {
    const llmCall = vi.fn().mockRejectedValue("boom")
    const result = await extractSingleProfile({
      character, chapterSamples: "x", llmConfig: stubLlmConfig, _llmCall: llmCall,
    })
    expect(result.error).toBe("unknown error")
    expect(result.errorKind).toBe("unknown")
  })
})
