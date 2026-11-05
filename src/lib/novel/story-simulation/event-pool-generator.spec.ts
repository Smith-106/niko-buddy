import { describe, expect, it, vi } from "vitest"
import type { LlmConfig } from "@/stores/wiki-store"
import {
  generateDynamicEventPool,
  pickStagedEvent,
  stringArrayToStagedPool,
  type StagedEvent,
  type StagedEventPool,
} from "./event-pool-generator"

vi.mock("@/lib/llm-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/llm-client")>()
  return {
    ...actual,
      streamChat: vi.fn(),
    
  }
})

const mockLlmConfig: LlmConfig = {
  provider: "openai",
  apiKey: "test-key",
  model: "test-model",
  ollamaUrl: "",
  customEndpoint: "",
  maxContextSize: 4096,
}

const mockInput = {
  llmConfig: mockLlmConfig,
  worldRules: "这是一个玄幻世界，有修仙者和妖兽。",
  characters: ["张三", "李四"],
}

describe("generateDynamicEventPool", () => {
  it("正常返回四阶段 JSON 对象时应解析为 StagedEventPool", async () => {
    const { streamChat } = await import("@/lib/llm-client")

    const mockResponse = {
      setup: ["起阶段事件1", "起阶段事件2", "起阶段事件3"],
      rising: ["承阶段事件1", "承阶段事件2", "承阶段事件3"],
      climax: ["转阶段事件1", "转阶段事件2", "转阶段事件3"],
      resolution: ["合阶段事件1", "合阶段事件2", "合阶段事件3"],
    }

    vi.mocked(streamChat).mockImplementationOnce(
      (_config, _messages, callbacks) => {
        callbacks.onToken(JSON.stringify(mockResponse))
        callbacks.onDone()
        return Promise.resolve()
      },
    )

    const result = await generateDynamicEventPool(mockInput)

    expect(result.all).toHaveLength(12)
    expect(result.byStage.setup).toHaveLength(3)
    expect(result.byStage.rising).toHaveLength(3)
    expect(result.byStage.climax).toHaveLength(3)
    expect(result.byStage.resolution).toHaveLength(3)
    expect(result.byStage.setup[0].text).toBe("起阶段事件1")
    expect(result.byStage.setup[0].stage).toBe("setup")
    expect(result.byStage.rising[0].stage).toBe("rising")
    expect(result.byStage.climax[0].stage).toBe("climax")
    expect(result.byStage.resolution[0].stage).toBe("resolution")
  })

  it("LLM 返回字符串数组时应自动转换为 StagedEventPool", async () => {
    const { streamChat } = await import("@/lib/llm-client")

    vi.mocked(streamChat).mockImplementationOnce(
      (_config, _messages, callbacks) => {
        callbacks.onToken(
          JSON.stringify([
            "一阵妖风吹过，带来了远方妖兽的嘶吼。",
            "天空中出现了一道罕见的霞光，似乎预示着宝物出世。",
            "一位神秘的修仙者出现在城镇边缘。",
            "后续事件4",
            "后续事件5",
            "后续事件6",
            "后续事件7",
            "后续事件8",
          ]),
        )
        callbacks.onDone()
        return Promise.resolve()
      },
    )

    const result = await generateDynamicEventPool(mockInput)

    expect(result.all).toHaveLength(8)
    expect(result.byStage.setup.length).toBeGreaterThan(0)
    expect(result.byStage.rising.length).toBeGreaterThan(0)
  })

  it("LLM 返回非 JSON 时应返回空池", async () => {
    const { streamChat } = await import("@/lib/llm-client")

    vi.mocked(streamChat).mockImplementationOnce(
      (_config, _messages, callbacks) => {
        callbacks.onToken("这不是一个 JSON 数组，只是一段普通文本。")
        callbacks.onDone()
        return Promise.resolve()
      },
    )

    const result = await generateDynamicEventPool(mockInput)

    expect(result.all).toEqual([])
    expect(result.byStage.setup).toEqual([])
    expect(result.byStage.rising).toEqual([])
    expect(result.byStage.climax).toEqual([])
    expect(result.byStage.resolution).toEqual([])
  })

  it("LLM 抛错时应返回空池", async () => {
    const { streamChat } = await import("@/lib/llm-client")

    vi.mocked(streamChat).mockImplementationOnce(
      (_config, _messages, callbacks) => {
        callbacks.onError(new Error("网络连接失败"))
        return Promise.resolve()
      },
    )

    const result = await generateDynamicEventPool(mockInput)

    expect(result.all).toEqual([])
  })

  it("部分阶段为空时应回退到全局池分配", async () => {
    const { streamChat } = await import("@/lib/llm-client")

    const mockResponse = {
      setup: ["起阶段事件1"],
      rising: [],
      climax: [],
      resolution: [],
    }

    vi.mocked(streamChat).mockImplementationOnce(
      (_config, _messages, callbacks) => {
        callbacks.onToken(JSON.stringify(mockResponse))
        callbacks.onDone()
        return Promise.resolve()
      },
    )

    const result = await generateDynamicEventPool(mockInput)

    expect(result.all).toHaveLength(1)
  })
})

describe("stringArrayToStagedPool", () => {
  it("空数组返回空池", () => {
    const result = stringArrayToStagedPool([])
    expect(result.all).toEqual([])
    expect(result.byStage.setup).toEqual([])
    expect(result.byStage.rising).toEqual([])
    expect(result.byStage.climax).toEqual([])
    expect(result.byStage.resolution).toEqual([])
  })

  it("8个事件按阶段分配", () => {
    const events = ["e1", "e2", "e3", "e4", "e5", "e6", "e7", "e8"]
    const result = stringArrayToStagedPool(events)
    expect(result.all).toHaveLength(8)
    expect(result.byStage.setup[0].text).toBe("e1")
    expect(result.byStage.setup[0].stage).toBe("setup")
  })
})

// ── 覆盖加深（增补：原有用例保留不动）─────────────────────────────────────────
// 目标：LLM 返回「四阶段键齐全但内容不合格」时的四条兜底路径，以及解析失败时
// 对非 Error 抛出物的降级文案。这些都是脏数据防线，行为必须可观察。

/** 让 streamChat 吐出一段原始文本（不解析），模拟 LLM 的畸形输出。 */
async function respondWith(raw: string): Promise<void> {
  const { streamChat } = await import("@/lib/llm-client")
  vi.mocked(streamChat).mockImplementationOnce((_config, _messages, callbacks) => {
    callbacks.onToken(raw)
    callbacks.onDone()
    return Promise.resolve()
  })
}

describe("generateDynamicEventPool · 脏数据兜底（增补）", () => {
  it("四阶段键齐全但全为空数组 → 返回空池（不产出空阶段池假对象）", async () => {
    await respondWith(
      JSON.stringify({ setup: [], rising: [], climax: [], resolution: [] }),
    )
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const result = await generateDynamicEventPool(mockInput)
    expect(result.all).toEqual([])
    expect(result.byStage.setup).toEqual([])
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("事件池为空"),
    )
    warn.mockRestore()
  })

  it("阶段数组里混入非字符串项 → 只保留字符串项", async () => {
    await respondWith(
      JSON.stringify({
        setup: [123, null, "有效事件"],
        rising: ["承1"],
        climax: ["转1"],
        resolution: ["合1"],
      }),
    )
    const result = await generateDynamicEventPool(mockInput)
    expect(result.all).toHaveLength(4)
    expect(result.all.every((e) => typeof e.text === "string")).toBe(true)
    expect(result.byStage.setup.map((e) => e.text)).toEqual(["有效事件"])
    expect(result.byStage.rising[0].text).toBe("承1")
  })

  it("返回数组但含非字符串项 → 走「格式无法解析」兜底，返回空池", async () => {
    await respondWith(JSON.stringify(["合法事件", 42]))
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const result = await generateDynamicEventPool(mockInput)
    expect(result.all).toEqual([])
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("无法解析"),
    )
    warn.mockRestore()
  })

  it("streamChat 以非 Error 拒绝 → 降级为空池并落 String(err) 文案", async () => {
    const { streamChat } = await import("@/lib/llm-client")
    vi.mocked(streamChat).mockImplementationOnce(() => Promise.reject("连接被重置"))
    const error = vi.spyOn(console, "error").mockImplementation(() => {})
    const result = await generateDynamicEventPool(mockInput)
    expect(result.all).toEqual([])
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining("[event-pool-generator]"),
      "连接被重置",
    )
    error.mockRestore()
  })
})

describe("pickStagedEvent · 池结构异常（增补）", () => {
  it("byStage 缺少当前阶段的键 → 回退全局池而不是抛错", () => {
    const stray: StagedEvent = { id: "x1", text: "孤立事件", stage: "rising" }
    // 模拟反序列化/手写配置里 byStage 不完整（Record 类型之外的运行时事实）。
    const malformed = { byStage: {} as StagedEventPool["byStage"], all: [stray] }
    const result = pickStagedEvent(malformed, new Set<string>(), 0, 4)
    expect(result?.id).toBe("x1")
    expect(result?.text).toBe("孤立事件")
  })
})
