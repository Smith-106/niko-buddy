import { describe, expect, it, vi, beforeEach } from "vitest"
import type { LlmConfig } from "@/stores/wiki-store"
import type { AgentChatMessage, NovelAgent, SimulationState } from "./types"
import { interviewAgent } from "./agent-interview"

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

function makeAgent(overrides: Partial<NovelAgent> = {}): NovelAgent {
  return {
    characterId: "char_1",
    name: "张三",
    profile: "宗门弟子",
    aura: null,
    cognition: { knows: ["入门考核通过"], doesNotKnow: ["长老的阴谋"] },
    soul: "勇敢之魂",
    currentGoal: "拜入宗门",
    emotionalState: "平静",
    knownFacts: new Set(["入门考核通过"]),
    relationships: new Map(),
    powerLevel: "",
    memory: {
      observedEvents: [],
      knownSecrets: new Set<string>(),
      sentiments: new Map<string, number>(),
      recentDecisions: [],
      rumorCredibility: 0.5,
    },
    knowledgeScope: ["入门考核通过"],
    personality: ["勇敢", "直率"],
    speakingStyle: "短促有力",
    ...overrides,
  }
}

function makeState(agents: NovelAgent[] = []): SimulationState {
  const map = new Map<string, NovelAgent>()
  for (const a of agents) map.set(a.characterId, a)
  return {
    currentRound: 0,
    timelineEvents: [],
    activeAgents: map,
    worldState: {},
    directorEnabled: false,
    nextNodeInjectionMap: new Map(),
  }
}

async function mockedStreamChat() {
  return (await import("@/lib/llm-client")).streamChat
}

function mockSuccess(tokens: string[], reasoningTokens: string[] = []) {
  return async (
    _config: unknown,
    _messages: unknown,
    callbacks: {
      onToken: (t: string) => void
      onReasoningToken?: (t: string) => void
      onDone: () => void
    },
  ) => {
    for (const t of tokens) callbacks.onToken(t)
    for (const r of reasoningTokens) callbacks.onReasoningToken?.(r)
    callbacks.onDone()
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.restoreAllMocks()
})

describe("interviewAgent 新会话", () => {
  it("流式 token 拼出全文并写入会话（user + agent 两条消息）", async () => {
    const streamChat = await mockedStreamChat()
    vi.mocked(streamChat).mockImplementationOnce(mockSuccess(["你好", "呀"], ["思考中"]) as never)

    const onToken = vi.fn()
    const onDone = vi.fn()
    const { fullText, session } = await interviewAgent({
      llmConfig: mockLlmConfig,
      agent: makeAgent(),
      simulationState: makeState(),
      userPrompt: "你是谁？",
      onToken,
      onDone,
    })

    expect(fullText).toBe("你好呀")
    expect(onToken).toHaveBeenNthCalledWith(1, "你好")
    expect(onToken).toHaveBeenNthCalledWith(2, "呀")
    expect(session.agentId).toBe("char_1")
    expect(session.agentName).toBe("张三")
    expect(session.messages).toHaveLength(2)
    expect(session.messages[0]).toMatchObject({ role: "user", content: "你是谁？" })
    expect(session.messages[1]).toMatchObject({
      role: "agent",
      agentId: "char_1",
      agentName: "张三",
      content: "你好呀",
      reasoning_content: "思考中",
    })
    expect(session.messages[0].id.startsWith("msg_")).toBe(true)
    expect(session.messages[1].id.startsWith("msg_")).toBe(true)
    expect(session.messages[0].id).not.toBe(session.messages[1].id)
    expect(onDone).toHaveBeenCalledWith("你好呀", session)
  })

  it("系统提示词包含角色名、性格、说话风格与核心规则", async () => {
    const streamChat = await mockedStreamChat()
    let sentMessages: { role: string; content: string }[] = []
    vi.mocked(streamChat).mockImplementationOnce((async (
      _c: unknown,
      messages: typeof sentMessages,
      callbacks: { onToken: (t: string) => void; onDone: () => void },
    ) => {
      sentMessages = messages
      callbacks.onToken("ok")
      callbacks.onDone()
    }) as never)

    await interviewAgent({
      llmConfig: mockLlmConfig,
      agent: makeAgent(),
      simulationState: makeState(),
      userPrompt: "hi",
    })

    const system = sentMessages[0]
    expect(system.role).toBe("system")
    expect(system.content).toContain("张三")
    expect(system.content).toContain("勇敢、直率")
    expect(system.content).toContain("短促有力")
    expect(system.content).toContain("不知道")
    expect(system.content).not.toContain("undefined")
  })

  it("无性格无说话风格时系统提示词不含对应行", async () => {
    const streamChat = await mockedStreamChat()
    let sentMessages: { role: string; content: string }[] = []
    vi.mocked(streamChat).mockImplementationOnce((async (
      _c: unknown,
      messages: typeof sentMessages,
      callbacks: { onToken: (t: string) => void; onDone: () => void },
    ) => {
      sentMessages = messages
      callbacks.onToken("ok")
      callbacks.onDone()
    }) as never)

    await interviewAgent({
      llmConfig: mockLlmConfig,
      agent: makeAgent({ personality: [], speakingStyle: "" }),
      simulationState: makeState(),
      userPrompt: "hi",
    })

    expect(sentMessages[0].content).not.toContain("你的性格：")
    expect(sentMessages[0].content).not.toContain("你的说话风格：")
  })

  it("新会话首条 user 消息注入背景上下文并附带 ready 占位", async () => {
    const streamChat = await mockedStreamChat()
    let sentMessages: { role: string; content: string }[] = []
    vi.mocked(streamChat).mockImplementationOnce((async (
      _c: unknown,
      messages: typeof sentMessages,
      callbacks: { onToken: (t: string) => void; onDone: () => void },
    ) => {
      sentMessages = messages
      callbacks.onToken("ok")
      callbacks.onDone()
    }) as never)

    await interviewAgent({
      llmConfig: mockLlmConfig,
      agent: makeAgent(),
      simulationState: makeState(),
      userPrompt: "今天过得如何？",
    })

    // system + context user + ready assistant + 当前提问
    expect(sentMessages).toHaveLength(4)
    expect(sentMessages[1].role).toBe("user")
    expect(sentMessages[1].content).toContain("姓名：张三")
    expect(sentMessages[1].content).toContain("档案：宗门弟子")
    expect(sentMessages[1].content).toContain("角色灵魂：勇敢之魂")
    expect(sentMessages[1].content).toContain("入门考核通过")
    expect(sentMessages[1].content).toContain("长老的阴谋")
    expect(sentMessages[1].content).toContain("当前目标：拜入宗门")
    expect(sentMessages[1].content).toContain("情绪状态：平静")
    expect(sentMessages[2]).toEqual({ role: "assistant", content: "我准备好了，请问吧。" })
    expect(sentMessages[3]).toEqual({ role: "user", content: "今天过得如何？" })
  })

  it("无档案无灵魂时上下文不输出对应行", async () => {
    const streamChat = await mockedStreamChat()
    let sentMessages: { role: string; content: string }[] = []
    vi.mocked(streamChat).mockImplementationOnce((async (
      _c: unknown,
      messages: typeof sentMessages,
      callbacks: { onToken: (t: string) => void; onDone: () => void },
    ) => {
      sentMessages = messages
      callbacks.onToken("ok")
      callbacks.onDone()
    }) as never)

    await interviewAgent({
      llmConfig: mockLlmConfig,
      agent: makeAgent({ profile: "", soul: "" }),
      simulationState: makeState(),
      userPrompt: "hi",
    })

    expect(sentMessages[1].content).not.toContain("档案：")
    expect(sentMessages[1].content).not.toContain("角色灵魂：")
  })

  it("knowledgeScope 为空时显示信息有限，超过 20 条只取最后 20 条", async () => {
    const streamChat = await mockedStreamChat()
    const seen: string[] = []
    const captureImpl = (async (
      _c: unknown,
      messages: { role: string; content: string }[],
      callbacks: { onToken: (t: string) => void; onDone: () => void },
    ) => {
      seen.push(messages[1].content)
      callbacks.onToken("ok")
      callbacks.onDone()
    }) as never
    vi.mocked(streamChat).mockImplementationOnce(captureImpl)
    vi.mocked(streamChat).mockImplementationOnce(captureImpl)

    await interviewAgent({
      llmConfig: mockLlmConfig,
      agent: makeAgent({ knowledgeScope: [] }),
      simulationState: makeState(),
      userPrompt: "hi",
    })
    expect(seen[0]).toContain("目前你了解的信息有限")

    const many = Array.from({ length: 25 }, (_, i) => `知识${i}`)
    await interviewAgent({
      llmConfig: mockLlmConfig,
      agent: makeAgent({ knowledgeScope: many }),
      simulationState: makeState(),
      userPrompt: "hi",
    })
    expect(seen[1]).toContain("知识24")
    expect(seen[1]).toContain("知识5")
    expect(seen[1]).not.toContain("知识4\n")
  })

  it("无 doesNotKnow 时不输出禁止提及节", async () => {
    const streamChat = await mockedStreamChat()
    let sentMessages: { role: string; content: string }[] = []
    vi.mocked(streamChat).mockImplementationOnce((async (
      _c: unknown,
      messages: typeof sentMessages,
      callbacks: { onToken: (t: string) => void; onDone: () => void },
    ) => {
      sentMessages = messages
      callbacks.onToken("ok")
      callbacks.onDone()
    }) as never)

    await interviewAgent({
      llmConfig: mockLlmConfig,
      agent: makeAgent({ cognition: { knows: ["a"], doesNotKnow: [] } }),
      simulationState: makeState(),
      userPrompt: "hi",
    })
    expect(sentMessages[1].content).not.toContain("绝对不知道")

    vi.mocked(streamChat).mockImplementationOnce((async (
      _c: unknown,
      messages: typeof sentMessages,
      callbacks: { onToken: (t: string) => void; onDone: () => void },
    ) => {
      sentMessages = messages
      callbacks.onToken("ok")
      callbacks.onDone()
    }) as never)
    await interviewAgent({
      llmConfig: mockLlmConfig,
      agent: makeAgent({ cognition: null }),
      simulationState: makeState(),
      userPrompt: "hi",
    })
    expect(sentMessages[1].content).not.toContain("绝对不知道")
  })

  it("情感阈值映射：好感/敌意/不错/不满/中立 + 跳过自己 + 未知角色回退 id", async () => {
    const streamChat = await mockedStreamChat()
    let sentMessages: { role: string; content: string }[] = []
    vi.mocked(streamChat).mockImplementationOnce((async (
      _c: unknown,
      messages: typeof sentMessages,
      callbacks: { onToken: (t: string) => void; onDone: () => void },
    ) => {
      sentMessages = messages
      callbacks.onToken("ok")
      callbacks.onDone()
    }) as never)

    const other = makeAgent({ characterId: "char_2", name: "李四" })
    const agent = makeAgent({
      memory: {
        observedEvents: [],
        knownSecrets: new Set<string>(),
        sentiments: new Map([
          ["char_1", 999],
          ["char_2", 50],
          ["char_3", -50],
          ["char_4", 10],
          ["char_5", -10],
          ["char_6", 0],
        ]),
        recentDecisions: [],
        rumorCredibility: 0.5,
      },
    })
    await interviewAgent({
      llmConfig: mockLlmConfig,
      agent,
      simulationState: makeState([other]),
      userPrompt: "hi",
    })

    const ctx = sentMessages[1].content
    expect(ctx).toContain("对 李四：有好感（好感度 50）")
    expect(ctx).toContain("对 char_3：有敌意（好感度 -50）")
    expect(ctx).toContain("对 char_4：印象不错（好感度 10）")
    expect(ctx).toContain("对 char_5：有些不满（好感度 -10）")
    expect(ctx).toContain("对 char_6：态度中立（好感度 0）")
    expect(ctx).not.toContain("999")
  })

  it("无他人情感时显示无倾向；可见事件注入最近经历", async () => {
    const streamChat = await mockedStreamChat()
    let sentMessages: { role: string; content: string }[] = []
    vi.mocked(streamChat).mockImplementationOnce((async (
      _c: unknown,
      messages: typeof sentMessages,
      callbacks: { onToken: (t: string) => void; onDone: () => void },
    ) => {
      sentMessages = messages
      callbacks.onToken("ok")
      callbacks.onDone()
    }) as never)

    await interviewAgent({
      llmConfig: mockLlmConfig,
      agent: makeAgent(),
      simulationState: makeState(),
      userPrompt: "hi",
    })
    expect(sentMessages[1].content).toContain("没有特别的情感倾向")
    expect(sentMessages[1].content).not.toContain("最近经历")

    vi.mocked(streamChat).mockImplementationOnce((async (
      _c: unknown,
      messages: typeof sentMessages,
      callbacks: { onToken: (t: string) => void; onDone: () => void },
    ) => {
      sentMessages = messages
      callbacks.onToken("ok")
      callbacks.onDone()
    }) as never)
    await interviewAgent({
      llmConfig: mockLlmConfig,
      agent: makeAgent(),
      simulationState: {
        ...makeState(),
        timelineEvents: [
          {
            id: "evt_1",
            round: 0,
            nodeIndex: 0,
            actorId: "char_1",
            actorName: "张三",
            actionType: "speak",
            content: "我来了",
            observableBy: ["char_1"],
            impacts: [],
            timestamp: "2024-01-01T00:00:00.000Z",
          },
        ],
      },
      userPrompt: "hi",
    })
    expect(sentMessages[1].content).toContain("最近经历")
    expect(sentMessages[1].content).toContain("我来了")
  })
})

describe("interviewAgent 多轮会话", () => {
  it("复用已有会话：不重复注入上下文，回放历史并追加新消息", async () => {
    const streamChat = await mockedStreamChat()
    let sentMessages: { role: string; content?: string; reasoning_content?: string }[] = []
    vi.mocked(streamChat).mockImplementationOnce((async (
      _c: unknown,
      messages: typeof sentMessages,
      callbacks: { onToken: (t: string) => void; onDone: () => void },
    ) => {
      sentMessages = messages
      callbacks.onToken("第二轮回复")
      callbacks.onDone()
    }) as never)

    const existing = {
      agentId: "char_1",
      agentName: "张三",
      messages: [
        { id: "msg_old_1", role: "user" as const, content: "第一问", timestamp: "2024-01-01T00:00:00.000Z" },
        {
          id: "msg_old_2",
          role: "agent" as const,
          agentId: "char_1",
          agentName: "张三",
          content: "第一答",
          reasoning_content: "旧思考",
          timestamp: "2024-01-01T00:00:01.000Z",
        },
        { id: "msg_old_3", role: "agent" as const, content: "无思考回复", timestamp: "2024-01-01T00:00:02.000Z" },
      ],
    }

    const { session } = await interviewAgent({
      llmConfig: mockLlmConfig,
      agent: makeAgent(),
      simulationState: makeState(),
      userPrompt: "第二问",
      session: existing,
    })

    // system + 历史3条 + 当前提问（无上下文注入）
    expect(sentMessages).toHaveLength(5)
    expect(sentMessages.map((m) => m.content).join("\n")).not.toContain("背景信息")
    expect(sentMessages[1]).toEqual({ role: "user", content: "第一问" })
    expect(sentMessages[2]).toEqual({
      role: "assistant",
      content: "第一答",
      reasoning_content: "旧思考",
    })
    expect(sentMessages[3]).toEqual({ role: "assistant", content: "无思考回复" })
    expect(sentMessages[4]).toEqual({ role: "user", content: "第二问" })

    // 原会话不被修改，新会话追加两条
    expect(existing.messages).toHaveLength(3)
    expect(session.messages).toHaveLength(5)
    expect(session.messages[3]).toMatchObject({ role: "user", content: "第二问" })
    expect(session.messages[4]).toMatchObject({ role: "agent", content: "第二轮回复" })
  })

  it("未知 role 的历史消息被跳过（防御分支）", async () => {
    const streamChat = await mockedStreamChat()
    let sentMessages: { role: string; content?: string }[] = []
    vi.mocked(streamChat).mockImplementationOnce((async (
      _c: unknown,
      messages: typeof sentMessages,
      callbacks: { onToken: (t: string) => void; onDone: () => void },
    ) => {
      sentMessages = messages
      callbacks.onToken("ok")
      callbacks.onDone()
    }) as never)

    await interviewAgent({
      llmConfig: mockLlmConfig,
      agent: makeAgent(),
      simulationState: makeState(),
      userPrompt: "新问题",
      session: {
        agentId: "char_1",
        agentName: "张三",
        messages: [
          {
            id: "msg_weird",
            role: "system",
            content: "脏数据",
            timestamp: "2024-01-01T00:00:00.000Z",
          } as unknown as AgentChatMessage,
        ],
      },
    })

    // system + 当前提问：脏历史未进入 LLM 消息
    expect(sentMessages).toHaveLength(2)
    expect(sentMessages.map((m) => m.content).join("\n")).not.toContain("脏数据")
  })

  it("无 reasoning 流时 reasoning_content 为空字符串", async () => {
    const streamChat = await mockedStreamChat()
    vi.mocked(streamChat).mockImplementationOnce(mockSuccess(["纯文本"]) as never)

    const { fullText, session } = await interviewAgent({
      llmConfig: mockLlmConfig,
      agent: makeAgent(),
      simulationState: makeState(),
      userPrompt: "hi",
    })
    expect(fullText).toBe("纯文本")
    expect(session.messages[1].reasoning_content).toBe("")
  })

  it("signal 透传给 streamChat", async () => {
    const streamChat = await mockedStreamChat()
    vi.mocked(streamChat).mockImplementationOnce(mockSuccess(["ok"]) as never)
    const controller = new AbortController()

    await interviewAgent({
      llmConfig: mockLlmConfig,
      agent: makeAgent(),
      simulationState: makeState(),
      userPrompt: "hi",
      signal: controller.signal,
    })

    expect(vi.mocked(streamChat).mock.calls[0][3]).toBe(controller.signal)
  })
})

describe("interviewAgent 错误处理", () => {
  it("流 onError 导致抛错并触发 onError 回调，onDone 不被调用", async () => {
    const streamChat = await mockedStreamChat()
    vi.mocked(streamChat).mockImplementationOnce((async (
      _c: unknown,
      _m: unknown,
      callbacks: { onError: (e: Error) => void },
    ) => {
      callbacks.onError(new Error("LLM 炸了"))
    }) as never)

    const onError = vi.fn()
    const onDone = vi.fn()
    await expect(
      interviewAgent({
        llmConfig: mockLlmConfig,
        agent: makeAgent(),
        simulationState: makeState(),
        userPrompt: "hi",
        onError,
        onDone,
      }),
    ).rejects.toThrow("LLM 炸了")
    expect(onError).toHaveBeenCalledTimes(1)
    expect(onError.mock.calls[0][0]).toBeInstanceOf(Error)
    expect(onDone).not.toHaveBeenCalled()
  })

  it("streamChat 直接抛错时透出并触发 onError", async () => {
    const streamChat = await mockedStreamChat()
    vi.mocked(streamChat).mockRejectedValueOnce(new Error("网络中断"))
    const onError = vi.fn()

    await expect(
      interviewAgent({
        llmConfig: mockLlmConfig,
        agent: makeAgent(),
        simulationState: makeState(),
        userPrompt: "hi",
        onError,
      }),
    ).rejects.toThrow("网络中断")
    expect(onError).toHaveBeenCalledTimes(1)
  })

  it("非 Error 抛值被包装为 Error", async () => {
    const streamChat = await mockedStreamChat()
    vi.mocked(streamChat).mockRejectedValueOnce("字符串失败")
    const onError = vi.fn()

    const err = await interviewAgent({
      llmConfig: mockLlmConfig,
      agent: makeAgent(),
      simulationState: makeState(),
      userPrompt: "hi",
      onError,
    }).catch((e) => e)
    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).toBe("字符串失败")
    expect(onError.mock.calls[0][0]).toBe(err)
  })
})
