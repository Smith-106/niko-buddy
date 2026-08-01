/**
 * chat-store 单元测试
 * 覆盖：state 初始值、所有 action 行为、streaming 生命周期、helper 函数
 */
import { describe, expect, it, beforeEach, vi } from "vitest"

// Mock i18n — chat-store 使用 i18n.t("chat.newConversation") 生成新会话标题
vi.mock("@/i18n", () => ({
  default: {
    t: (key: string) => {
      if (key === "chat.newConversation") return "新对话"
      return key
    },
  },
}))

// 每个测试前重置 store，防止跨测试状态污染
import { useChatStore } from "../chat-store"
import type { DisplayMessage, Conversation } from "../chat-store"

function resetStore(): void {
  useChatStore.setState({
    conversations: [],
    activeConversationId: null,
    messages: [],
    streamingContents: {},
    mode: "chat",
    ingestSource: null,
    maxHistoryMessages: 20,
  })
}

/** 快速创建一个活跃会话，返回其 ID */
function createActiveConv(): string {
  return useChatStore.getState().createConversation()
}

/** 构造一条 DisplayMessage */
function makeMessage(overrides: Partial<DisplayMessage> = {}): DisplayMessage {
  return {
    id: "msg-test",
    role: "user",
    content: "hello",
    timestamp: Date.now(),
    conversationId: "conv-1",
    ...overrides,
  }
}

beforeEach(() => {
  resetStore()
})

// ─── 初始值 ──────────────────────────────────────────────────────────────────

describe("chat-store 初始值", () => {
  it("所有 state 字段具有正确的默认值", () => {
    const s = useChatStore.getState()
    expect(s.conversations).toEqual([])
    expect(s.activeConversationId).toBeNull()
    expect(s.messages).toEqual([])
    expect(s.streamingContents).toEqual({})
    expect(s.mode).toBe("chat")
    expect(s.ingestSource).toBeNull()
    expect(s.maxHistoryMessages).toBe(20)
  })
})

// ─── 会话管理 ────────────────────────────────────────────────────────────────

describe("createConversation", () => {
  it("创建新会话并设为活跃，返回会话 ID", () => {
    const id = createActiveConv()
    const s = useChatStore.getState()
    expect(id).toMatch(/^conv_/)
    expect(s.conversations).toHaveLength(1)
    expect(s.activeConversationId).toBe(id)
    expect(s.conversations[0]!.title).toBe("新对话")
    expect(s.conversations[0]!.deAiMode).toBe(false)
    expect(s.conversations[0]!.inputDraft).toBe("")
  })

  it("新会话插入到列表最前面", () => {
    const id1 = createActiveConv()
    const id2 = createActiveConv()
    const s = useChatStore.getState()
    expect(s.conversations[0]!.id).toBe(id2)
    expect(s.conversations[1]!.id).toBe(id1)
  })
})

describe("deleteConversation", () => {
  it("删除指定会话及其消息和流式状态", () => {
    const id = createActiveConv()
    useChatStore.getState().addMessage("user", "hi")
    useChatStore.getState().startStreaming(id)

    useChatStore.getState().deleteConversation(id)

    const s = useChatStore.getState()
    expect(s.conversations).toHaveLength(0)
    expect(s.messages).toHaveLength(0)
    expect(s.activeConversationId).toBeNull()
    expect(s.streamingContents).toEqual({})
  })

  it("删除活跃会话后自动切换到剩余第一个会话", () => {
    const id1 = createActiveConv()
    const id2 = createActiveConv() // id2 is active
    useChatStore.getState().deleteConversation(id2)
    expect(useChatStore.getState().activeConversationId).toBe(id1)
  })

  it("删除非活跃会话不影响活跃 ID", () => {
    const id1 = createActiveConv()
    createActiveConv() // id2 is active
    useChatStore.getState().deleteConversation(id1)
    expect(useChatStore.getState().conversations).toHaveLength(1)
    // activeConversationId is still id2
  })
})

describe("setActiveConversation", () => {
  it("设置活跃会话 ID", () => {
    const id = createActiveConv()
    useChatStore.getState().setActiveConversation(null)
    expect(useChatStore.getState().activeConversationId).toBeNull()
    useChatStore.getState().setActiveConversation(id)
    expect(useChatStore.getState().activeConversationId).toBe(id)
  })
})

describe("renameConversation", () => {
  it("更新会话标题和 updatedAt", async () => {
    const id = createActiveConv()
    const before = useChatStore.getState().conversations[0]!.updatedAt
    // 确保时间戳有差异
    await new Promise((r) => setTimeout(r, 2))
    useChatStore.getState().renameConversation(id, "新标题")
    const conv = useChatStore.getState().conversations.find((c) => c.id === id)!
    expect(conv.title).toBe("新标题")
    expect(conv.updatedAt).toBeGreaterThanOrEqual(before)
  })
})

describe("setConversationDeAiMode", () => {
  it("更新 deAiMode 标志", () => {
    const id = createActiveConv()
    useChatStore.getState().setConversationDeAiMode(id, true)
    expect(useChatStore.getState().conversations[0]!.deAiMode).toBe(true)
  })
})

describe("setConversationInputDraft", () => {
  it("更新输入草稿", () => {
    const id = createActiveConv()
    useChatStore.getState().setConversationInputDraft(id, "草稿内容")
    expect(useChatStore.getState().conversations[0]!.inputDraft).toBe("草稿内容")
  })
})

// ─── 消息管理 ────────────────────────────────────────────────────────────────

describe("addMessage", () => {
  it("无活跃会话时不添加消息", () => {
    useChatStore.getState().addMessage("user", "hi")
    expect(useChatStore.getState().messages).toHaveLength(0)
  })

  it("有活跃会话时添加消息并更新 updatedAt", () => {
    const id = createActiveConv()
    useChatStore.getState().addMessage("user", "你好")
    const s = useChatStore.getState()
    expect(s.messages).toHaveLength(1)
    expect(s.messages[0]!.role).toBe("user")
    expect(s.messages[0]!.content).toBe("你好")
    expect(s.messages[0]!.conversationId).toBe(id)
  })

  it("第一条用户消息自动设为会话标题（截取前50字符）", () => {
    createActiveConv()
    const longContent = "这是一段很长很长的内容".repeat(10)
    useChatStore.getState().addMessage("user", longContent)
    const conv = useChatStore.getState().conversations[0]!
    expect(conv.title).toBe(longContent.slice(0, 50))
  })

  it("非第一条用户消息不改变标题文字，只更新 updatedAt", () => {
    createActiveConv()
    useChatStore.getState().addMessage("user", "第一条消息")
    const titleAfter1 = useChatStore.getState().conversations[0]!.title
    useChatStore.getState().addMessage("user", "第二条消息")
    const titleAfter2 = useChatStore.getState().conversations[0]!.title
    expect(titleAfter2).toBe(titleAfter1)
  })
})

describe("setMessages / setConversations", () => {
  it("直接替换消息列表", () => {
    const msgs: DisplayMessage[] = [makeMessage({ id: "m1" }), makeMessage({ id: "m2" })]
    useChatStore.getState().setMessages(msgs)
    expect(useChatStore.getState().messages).toEqual(msgs)
  })

  it("直接替换会话列表", () => {
    const convs: Conversation[] = [{
      id: "c1", title: "会话1", createdAt: 1, updatedAt: 1, deAiMode: false,
    }]
    useChatStore.getState().setConversations(convs)
    expect(useChatStore.getState().conversations).toEqual(convs)
  })
})

describe("clearMessages", () => {
  it("只清除当前活跃会话的消息", () => {
    const id1 = createActiveConv()
    const id2 = createActiveConv()
    useChatStore.setState({ activeConversationId: id1 })
    useChatStore.getState().addMessage("user", "msg1")
    useChatStore.setState({ activeConversationId: id2 })
    useChatStore.getState().addMessage("user", "msg2")

    // 清除 id2 的消息
    useChatStore.getState().clearMessages()
    const s = useChatStore.getState()
    expect(s.messages.filter((m) => m.conversationId === id2)).toHaveLength(0)
    expect(s.messages.filter((m) => m.conversationId === id1)).toHaveLength(1)
  })
})

describe("setMaxHistoryMessages", () => {
  it("更新 maxHistoryMessages", () => {
    useChatStore.getState().setMaxHistoryMessages(50)
    expect(useChatStore.getState().maxHistoryMessages).toBe(50)
  })
})

describe("removeLastAssistantMessage", () => {
  it("移除当前会话最后一条 assistant 消息", () => {
    createActiveConv()
    useChatStore.getState().addMessage("user", "问题")
    useChatStore.getState().addMessage("assistant", "回答1")
    useChatStore.getState().addMessage("assistant", "回答2")

    useChatStore.getState().removeLastAssistantMessage()
    const msgs = useChatStore.getState().messages
    expect(msgs).toHaveLength(2) // user + assistant (回答1)
    expect(msgs.find((m) => m.content === "回答2")).toBeUndefined()
  })

  it("无活跃会话时不操作", () => {
    useChatStore.getState().removeLastAssistantMessage()
    expect(useChatStore.getState().messages).toHaveLength(0)
  })

  it("无 assistant 消息时不操作", () => {
    createActiveConv()
    useChatStore.getState().addMessage("user", "只有用户消息")
    useChatStore.getState().removeLastAssistantMessage()
    expect(useChatStore.getState().messages).toHaveLength(1)
  })
})

describe("markLastAssistantDiscarded", () => {
  it("将最后一条 assistant 消息标记为 discarded 并清空内容", () => {
    createActiveConv()
    useChatStore.getState().addMessage("assistant", "待废弃内容")

    useChatStore.getState().markLastAssistantDiscarded()
    const msg = useChatStore.getState().messages[0]!
    expect(msg.discarded).toBe(true)
    expect(msg.content).toBe("")
  })

  it("无活跃会话时不操作", () => {
    useChatStore.getState().markLastAssistantDiscarded()
    expect(useChatStore.getState().messages).toHaveLength(0)
  })
})

// ─── 流式状态 ────────────────────────────────────────────────────────────────

describe("streaming 生命周期", () => {
  it("startStreaming → appendStreamToken → 内容累加", () => {
    const convId = createActiveConv()
    useChatStore.getState().startStreaming(convId)
    expect(useChatStore.getState().streamingContents[convId]).toBe("")

    useChatStore.getState().appendStreamToken("你好", convId)
    useChatStore.getState().appendStreamToken("世界", convId)
    expect(useChatStore.getState().streamingContents[convId]).toBe("你好世界")
  })

  it("setStreamingContent 整体替换指定会话的流式内容", () => {
    const convId = createActiveConv()
    useChatStore.getState().startStreaming(convId)
    useChatStore.getState().appendStreamToken("旧内容", convId)
    useChatStore.getState().setStreamingContent("新内容", convId)
    expect(useChatStore.getState().streamingContents[convId]).toBe("新内容")
  })

  it("finalizeStream 将内容保存为 assistant 消息并清理流式状态", () => {
    const convId = createActiveConv()
    useChatStore.getState().startStreaming(convId)
    const refs = [{ title: "page1", path: "/wiki/page1" }]
    useChatStore.getState().finalizeStream("最终回答", refs, convId)

    const s = useChatStore.getState()
    expect(s.streamingContents).not.toHaveProperty(convId)
    const lastMsg = s.messages[s.messages.length - 1]!
    expect(lastMsg.role).toBe("assistant")
    expect(lastMsg.content).toBe("最终回答")
    expect(lastMsg.references).toEqual(refs)
    expect(lastMsg.conversationId).toBe(convId)
  })

  it("finalizeStream 无目标会话时不操作", () => {
    useChatStore.setState({ activeConversationId: null })
    useChatStore.getState().finalizeStream("内容")
    expect(useChatStore.getState().messages).toHaveLength(0)
  })

  it("clearStreaming 清理指定会话的流式状态", () => {
    const convId = createActiveConv()
    useChatStore.getState().startStreaming(convId)
    useChatStore.getState().appendStreamToken("some", convId)
    useChatStore.getState().clearStreaming(convId)
    expect(useChatStore.getState().streamingContents).not.toHaveProperty(convId)
  })
})

// ─── 模式切换 ────────────────────────────────────────────────────────────────

describe("setMode / setIngestSource", () => {
  it("切换 chat/ingest 模式", () => {
    useChatStore.getState().setMode("ingest")
    expect(useChatStore.getState().mode).toBe("ingest")
  })

  it("设置 ingest 来源路径", () => {
    useChatStore.getState().setIngestSource("/path/to/file.md")
    expect(useChatStore.getState().ingestSource).toBe("/path/to/file.md")
  })
})

// ─── Helper 函数 ─────────────────────────────────────────────────────────────

describe("getActiveMessages", () => {
  it("无活跃会话时返回空数组", () => {
    expect(useChatStore.getState().getActiveMessages()).toEqual([])
  })

  it("只返回当前活跃会话的消息", () => {
    const id1 = createActiveConv()
    const id2 = createActiveConv()
    useChatStore.setState({ activeConversationId: id1 })
    useChatStore.getState().addMessage("user", "msg1")
    useChatStore.setState({ activeConversationId: id2 })
    useChatStore.getState().addMessage("user", "msg2")

    useChatStore.setState({ activeConversationId: id1 })
    const active = useChatStore.getState().getActiveMessages()
    expect(active).toHaveLength(1)
    expect(active[0]!.content).toBe("msg1")
  })
})

describe("isConversationStreaming / getStreamingContent / isAnyStreaming", () => {
  it("isConversationStreaming 正确反映流式状态", () => {
    const convId = createActiveConv()
    expect(useChatStore.getState().isConversationStreaming(convId)).toBe(false)
    useChatStore.getState().startStreaming(convId)
    expect(useChatStore.getState().isConversationStreaming(convId)).toBe(true)
  })

  it("getStreamingContent 返回对应内容，不存在时返回空字符串", () => {
    const convId = createActiveConv()
    expect(useChatStore.getState().getStreamingContent(convId)).toBe("")
    useChatStore.getState().startStreaming(convId)
    useChatStore.getState().appendStreamToken("token", convId)
    expect(useChatStore.getState().getStreamingContent(convId)).toBe("token")
  })

  it("isAnyStreaming 有任何流式会话时返回 true", () => {
    expect(useChatStore.getState().isAnyStreaming()).toBe(false)
    const convId = createActiveConv()
    useChatStore.getState().startStreaming(convId)
    expect(useChatStore.getState().isAnyStreaming()).toBe(true)
  })
})

// ─── chatMessagesToLLM ───────────────────────────────────────────────────────

describe("chatMessagesToLLM", () => {
  it("将 DisplayMessage[] 转换为 ChatMessage[]（仅 role + content）", async () => {
    const { chatMessagesToLLM } = await import("../chat-store")
    const msgs: DisplayMessage[] = [
      makeMessage({ id: "1", role: "user", content: "问题" }),
      makeMessage({ id: "2", role: "assistant", content: "回答" }),
    ]
    const result = chatMessagesToLLM(msgs)
    expect(result).toEqual([
      { role: "user", content: "问题" },
      { role: "assistant", content: "回答" },
    ])
  })
})
