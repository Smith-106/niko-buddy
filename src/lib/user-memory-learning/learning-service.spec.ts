import { beforeEach, describe, expect, it, vi } from "vitest"
import type { LlmConfig } from "@/stores/wiki-store"
import { loadGlobalUserMemoryConfig, saveGlobalUserMemoryConfig } from "./store"
import {
  learnUserMemoryFromMessage,
  learnUserMemoryFromMessages,
  resetUserMemoryLearningQueueForTests,
} from "./learning-service"

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
})
