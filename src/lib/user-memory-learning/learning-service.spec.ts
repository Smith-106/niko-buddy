import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { LlmConfig } from "@/stores/wiki-store"
import { streamChat } from "@/lib/llm-client"
import { loadGlobalUserMemoryConfig, saveGlobalUserMemoryConfig } from "./store"
import {
  enqueueUserMemoryLearning,
  learnUserMemoryFromMessage,
  learnUserMemoryFromMessages,
  resetUserMemoryLearningQueueForTests,
} from "./learning-service"

vi.mock("@/lib/llm-client", () => ({ streamChat: vi.fn() }))

const streamChatMock = vi.mocked(streamChat)

class MemoryStorage implements Pick<Storage, "getItem" | "setItem"> {
  private values = new Map<string, string>()
  getItem(key: string) { return this.values.get(key) ?? null }
  setItem(key: string, value: string) { this.values.set(key, value) }
}

const llmConfig = { provider: "openai", model: "test" } as LlmConfig

describe("user memory learning service", () => {
  let storage: MemoryStorage

  beforeEach(() => {
    storage = new MemoryStorage()
    resetUserMemoryLearningQueueForTests()
  })

  it("关闭自动学习时不调用提取模型", async () => {
    const config = { ...loadGlobalUserMemoryConfig(storage), autoLearn: false }
    saveGlobalUserMemoryConfig(config, storage)
    const runExtractor = vi.fn()

    const result = await learnUserMemoryFromMessage({ message: "回答简洁一些", llmConfig }, { storage, runExtractor })

    expect(result.status).toBe("disabled")
    expect(runExtractor).not.toHaveBeenCalled()
  })

  it("相同消息哈希只分析一次", async () => {
    const runExtractor = vi.fn(async () => JSON.stringify({ memories: [] }))

    const first = await learnUserMemoryFromMessage({ message: "回答时先给结论", llmConfig }, { storage, runExtractor })
    const second = await learnUserMemoryFromMessage({ message: "回答时先给结论", llmConfig }, { storage, runExtractor })

    expect(first.status).toBe("learned")
    expect(second.status).toBe("unchanged")
    expect(runExtractor).toHaveBeenCalledTimes(1)
  })

  it("成功提取后保存规则且失败不抛出", async () => {
    const learned = await learnUserMemoryFromMessage({ message: "续写要重视前文承接", llmConfig }, {
      storage,
      runExtractor: async () => JSON.stringify({ memories: [{
        rule: "续写时重视前文剧情承接。",
        category: "workflow_preference",
        surfaces: ["chapter-writing"],
        confidence: 0.9,
        evidence_summary: "用户明确强调承接",
      }] }),
    })
    const failed = await learnUserMemoryFromMessage({ message: "换一种表达方式", llmConfig }, {
      storage,
      runExtractor: async () => { throw new Error("network") },
    })

    expect(learned.status).toBe("learned")
    expect(loadGlobalUserMemoryConfig(storage).rules[0]?.rule).toContain("剧情承接")
    expect(failed.status).toBe("failed")
  })

  it("批量消息只调用一次提取器并记录每条消息哈希", async () => {
    const runExtractor = vi.fn(async () => JSON.stringify({ memories: [{
      rule: "回答时先给结论。",
      category: "interaction_preference",
      surfaces: ["all"],
      confidence: 0.9,
      evidence_summary: "两条消息共同确认",
    }] }))

    const result = await learnUserMemoryFromMessages([
      { message: "以后回答时请先给结论。", llmConfig, surface: "ai-chat" },
      { message: "我习惯先看结论，再看依据。", llmConfig, surface: "ai-chat" },
    ], { storage, runExtractor })

    expect(result.status).toBe("learned")
    expect(runExtractor).toHaveBeenCalledTimes(1)
    expect(loadGlobalUserMemoryConfig(storage).analyzedSourceHashes).toHaveLength(2)
  })

  it("达到每日预算后不再调用提取器", async () => {
    const config = { ...loadGlobalUserMemoryConfig(storage), dailyLearningLimit: 1 }
    saveGlobalUserMemoryConfig(config, storage)
    const runExtractor = vi.fn(async () => JSON.stringify({ memories: [] }))

    const first = await learnUserMemoryFromMessage({ message: "以后回答时请先给结论。", llmConfig }, { storage, runExtractor })
    const second = await learnUserMemoryFromMessage({ message: "以后回答时请保持简洁。", llmConfig }, { storage, runExtractor })

    expect(first.status).toBe("learned")
    expect(second.status).toBe("budget_exhausted")
    expect(runExtractor).toHaveBeenCalledTimes(1)
  })

  it("仅手动记忆模式不调用自动提取器", async () => {
    saveGlobalUserMemoryConfig({ ...loadGlobalUserMemoryConfig(storage), onlyManual: true }, storage)
    const runExtractor = vi.fn()

    const result = await learnUserMemoryFromMessage({ message: "以后回答时请保持简洁。", llmConfig }, { storage, runExtractor })

    expect(result.status).toBe("disabled")
    expect(runExtractor).not.toHaveBeenCalled()
  })

  it("写作偏好归入作品层，明确本次会话的偏好归入会话层", async () => {
    await learnUserMemoryFromMessage({
      message: "写作时一直保持幽默风格。", llmConfig, projectKey: "p1", sessionKey: "s1",
    }, {
      storage,
      runExtractor: async () => JSON.stringify({ memories: [{
        rule: "写作时保持幽默风格。", category: "writing_preference", surfaces: ["chapter-writing"], confidence: 0.9, evidence_summary: "写作偏好",
      }] }),
    })
    await learnUserMemoryFromMessage({
      message: "当前会话回答时先给结论。", llmConfig, projectKey: "p1", sessionKey: "s1",
    }, {
      storage,
      runExtractor: async () => JSON.stringify({ memories: [{
        rule: "回答时先给结论。", category: "interaction_preference", surfaces: ["ai-chat"], confidence: 0.9, evidence_summary: "本次会话偏好",
      }] }),
    })

    const rules = loadGlobalUserMemoryConfig(storage).rules
    expect(rules.find((rule) => rule.category === "writing_preference")).toMatchObject({ scope: "project", projectKey: "p1" })
    expect(rules.find((rule) => rule.category === "interaction_preference")).toMatchObject({ scope: "session", projectKey: "p1", sessionKey: "s1" })
  })

  it("批量消息的项目键/会话键不一致时回退 global（不抬成单项目层）", async () => {
    const result = await learnUserMemoryFromMessages([
      { message: "以后回答时请先给结论。", llmConfig, projectKey: "p1", sessionKey: "s1" },
      { message: "写作时一直保持幽默风格。", llmConfig, projectKey: "p2", sessionKey: "s2" },
    ], {
      storage,
      runExtractor: async () => JSON.stringify({ memories: [{
        rule: "回答时先给结论。", category: "interaction_preference", surfaces: ["ai-chat"], confidence: 0.9, evidence_summary: "跨项目批次",
      }] }),
    })

    expect(result).toMatchObject({ status: "learned", added: 1 })
    expect(loadGlobalUserMemoryConfig(storage).rules[0]).toMatchObject({ scope: "global", projectKey: null, sessionKey: null })
  })

  it("显式 scope=session 且各消息同一会话键 → 会话层（无需会话关键词）", async () => {
    await learnUserMemoryFromMessage({
      message: "回答时先给出结论。", llmConfig, projectKey: "p1", sessionKey: "s9", scope: "session",
    }, {
      storage,
      runExtractor: async () => JSON.stringify({ memories: [{
        rule: "回答时先给出结论。", category: "interaction_preference", surfaces: ["ai-chat"], confidence: 0.9, evidence_summary: "显式会话层级",
      }] }),
    })

    expect(loadGlobalUserMemoryConfig(storage).rules[0]).toMatchObject({ scope: "session", projectKey: "p1", sessionKey: "s9" })
  })

  it("显式 scope=project 且各消息同一项目键 → 作品层且不携带会话键", async () => {
    await learnUserMemoryFromMessage({
      message: "回答时先给出结论。", llmConfig, projectKey: "p9", scope: "project",
    }, {
      storage,
      runExtractor: async () => JSON.stringify({ memories: [{
        rule: "回答时先给出结论。", category: "interaction_preference", surfaces: ["ai-chat"], confidence: 0.9, evidence_summary: "显式作品层级",
      }] }),
    })

    expect(loadGlobalUserMemoryConfig(storage).rules[0]).toMatchObject({ scope: "project", projectKey: "p9", sessionKey: null })
  })
})

describe("user memory learning service 增补：默认提取器与入队批量", () => {
  let storage: MemoryStorage

  function stubWindowStorage(target: MemoryStorage): void {
    ;(globalThis as unknown as { window?: unknown }).window = {
      localStorage: target,
      dispatchEvent: () => false,
    }
  }

  function unstubWindow(): void {
    delete (globalThis as unknown as { window?: unknown }).window
  }

  const memoryPayload = (rule: string) => JSON.stringify({ memories: [{
    rule, category: "interaction_preference", surfaces: ["ai-chat"], confidence: 0.9, evidence_summary: "测试摘要",
  }] })

  function mockEmptyExtraction(): void {
    streamChatMock.mockImplementation(async (_config, messages, callbacks) => {
      callbacks.onToken(memoryPayload("回答时先给结论。"))
      callbacks.onDone()
      void messages
    })
  }

  beforeEach(() => {
    storage = new MemoryStorage()
    resetUserMemoryLearningQueueForTests()
    streamChatMock.mockReset()
    vi.useFakeTimers()
  })

  afterEach(() => {
    unstubWindow()
    vi.useRealTimers()
    resetUserMemoryLearningQueueForTests()
  })

  it("默认提取器经 streamChat 累积分片 token 并学习成功", async () => {
    streamChatMock.mockImplementation(async (_config, messages, callbacks) => {
      expect(JSON.stringify(messages)).toContain("以后回答时请先给结论。")
      callbacks.onToken('{"memories":[{')
      callbacks.onToken('"rule":"回答时先给结论。","category":"interaction_preference",')
      callbacks.onToken('"surfaces":["ai-chat"],"confidence":0.9,"evidence_summary":"测试摘要"}]}')
      callbacks.onDone()
    })

    const result = await learnUserMemoryFromMessage(
      { message: "以后回答时请先给结论。", llmConfig },
      { storage },
    )

    expect(streamChatMock).toHaveBeenCalledTimes(1)
    expect(result).toMatchObject({ status: "learned", added: 1 })
    expect(loadGlobalUserMemoryConfig(storage).rules[0]?.rule).toContain("先给结论")
  })

  it("默认提取器 onError 时返回 failed 而不抛出", async () => {
    streamChatMock.mockImplementation(async (_config, _messages, callbacks) => {
      callbacks.onError(new Error("boom"))
    })

    const result = await learnUserMemoryFromMessage(
      { message: "以后回答时请先给结论。", llmConfig },
      { storage },
    )

    expect(result).toMatchObject({ status: "failed", added: 0 })
    expect(loadGlobalUserMemoryConfig(storage).rules).toHaveLength(0)
  })

  it("过短消息直接 ignored 且不调用提取器", async () => {
    const runExtractor = vi.fn()

    const result = await learnUserMemoryFromMessage({ message: "好的", llmConfig }, { storage, runExtractor })

    expect(result).toMatchObject({ status: "ignored", added: 0 })
    expect(runExtractor).not.toHaveBeenCalled()
  })

  it("并发相同消息只调用一次提取器（inFlight 去重）", async () => {
    // 用可控闸门而不是「让出 N 轮事件循环」：后者在 4-worker 争抢下轮数可能不够，
    // 会退化成「先行者已结束、后来者重新提取」的假红。闸门保证断言时先行者必然在飞行中。
    vi.useRealTimers()
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const runExtractor = vi.fn(async () => {
      await gate
      return memoryPayload("回答时先给结论。")
    })

    const first = learnUserMemoryFromMessage({ message: "以后回答时请先给结论。", llmConfig }, { storage, runExtractor })
    const second = learnUserMemoryFromMessage({ message: "以后回答时请先给结论。", llmConfig }, { storage, runExtractor })
    // 等先行者真正进入提取器（被闸门挡住，不会结束）。
    // 多等一会儿只会让去重判定更严：先行者还在飞行中时，去重若失效就会多出一次调用。
    // finally 释放闸门很关键——inFlight 是模块级状态，测试若中途失败而不释放，
    // 后续用例会继承一条永不完成的 inFlight 记录。
    try {
      await vi.waitFor(() => expect(runExtractor).toHaveBeenCalledTimes(1))
      await new Promise<void>((resolve) => setTimeout(resolve, 20))
      expect(runExtractor).toHaveBeenCalledTimes(1)
    } finally {
      release()
    }

    const [firstResult, secondResult] = await Promise.all([first, second])
    expect(runExtractor).toHaveBeenCalledTimes(1)
    expect(firstResult.status).toBe("learned")
    expect(secondResult.status).toBe("learned")
  })

  it("非候选消息入队直接返回且不建定时器", () => {
    enqueueUserMemoryLearning({ message: "好的", llmConfig })

    expect(vi.getTimerCount()).toBe(0)
  })

  it("无 window 环境（runtimeStorage 回退 null）时入队仍按默认配置建定时器", () => {
    // 强制无 window：runtimeStorage 的 typeof window === "undefined" 分支回退 null，
    // 存储不可用不应阻断入队（loadGlobalUserMemoryConfig(null) → 默认启用配置）。
    delete (globalThis as { window?: unknown }).window
    expect(typeof (globalThis as { window?: unknown }).window).toBe("undefined")

    enqueueUserMemoryLearning({ message: "以后回答时请先给结论。", llmConfig })

    expect(vi.getTimerCount()).toBe(1)
  })

  it("reset 清空待刷批次的定时器（不留悬挂 timer）", () => {
    stubWindowStorage(storage)

    enqueueUserMemoryLearning({ message: "以后回答时请先给结论。", llmConfig })
    expect(vi.getTimerCount()).toBe(1)

    resetUserMemoryLearningQueueForTests()

    expect(vi.getTimerCount()).toBe(0)
  })

  it("localStorage 访问抛错（隐私模式）时回退 null，入队不抛错", () => {
    ;(globalThis as unknown as { window?: unknown }).window = {
      get localStorage(): unknown {
        throw new Error("storage disabled")
      },
    }

    enqueueUserMemoryLearning({ message: "以后回答时请先给结论。", llmConfig })

    expect(vi.getTimerCount()).toBe(1)
  })

  it("失能配置下入队直接返回且不建定时器", () => {
    saveGlobalUserMemoryConfig({ ...loadGlobalUserMemoryConfig(storage), autoLearn: false }, storage)
    stubWindowStorage(storage)

    enqueueUserMemoryLearning({ message: "以后回答时请先给结论。", llmConfig })

    expect(vi.getTimerCount()).toBe(0)
  })

  it("单条入队 1.5s 后批量刷出并经默认提取器学习", async () => {
    stubWindowStorage(storage)
    mockEmptyExtraction()

    enqueueUserMemoryLearning({ message: "以后回答时请先给结论。", llmConfig })
    expect(vi.getTimerCount()).toBe(1)

    await vi.advanceTimersByTimeAsync(1600)
    // 假时钟推进只触发定时器；后续 subtle 摘要与存储收尾需真事件循环，用 waitFor 轮询。
    vi.useRealTimers()
    await vi.waitFor(() => {
      expect(loadGlobalUserMemoryConfig(storage).analyzedSourceHashes).toHaveLength(1)
    })
    expect(loadGlobalUserMemoryConfig(storage).rules).toHaveLength(1)
  })

  it("达到 batchSize 立即刷出且不留定时器", async () => {
    saveGlobalUserMemoryConfig({ ...loadGlobalUserMemoryConfig(storage), batchSize: 1 }, storage)
    stubWindowStorage(storage)
    mockEmptyExtraction()

    enqueueUserMemoryLearning({ message: "以后回答时请先给结论。", llmConfig })
    expect(vi.getTimerCount()).toBe(0)
    vi.useRealTimers()
    await vi.waitFor(() => {
      expect(loadGlobalUserMemoryConfig(storage).analyzedSourceHashes).toHaveLength(1)
    })
  })

  it("同 key 第二次入队清除旧定时器后合并刷出两条", async () => {
    stubWindowStorage(storage)
    mockEmptyExtraction()

    enqueueUserMemoryLearning({ message: "以后回答时请先给结论。", llmConfig })
    expect(vi.getTimerCount()).toBe(1)
    await vi.advanceTimersByTimeAsync(500)
    enqueueUserMemoryLearning({ message: "写作时一直保持幽默风格。", llmConfig })
    expect(vi.getTimerCount()).toBe(1)
    await vi.advanceTimersByTimeAsync(1600)
    vi.useRealTimers()
    await vi.waitFor(() => {
      expect(loadGlobalUserMemoryConfig(storage).analyzedSourceHashes).toHaveLength(2)
    })
  })
})
