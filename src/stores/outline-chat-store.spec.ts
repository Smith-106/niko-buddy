// SPDX-License-Identifier: MIT
// outline-chat-store 全口径覆盖：会话/消息/流式/磁盘持久化
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { Mock } from "vitest"

// 可变的 wiki project 引用（vi.hoisted 允许工厂读取）
const mockWiki = vi.hoisted(() => ({
  project: null as { path: string } | null,
}))

vi.mock("@/stores/wiki-store", () => ({
  useWikiStore: {
    getState: () => mockWiki,
  },
}))

vi.mock("@/commands/fs", () => ({
  readFile: vi.fn(),
  writeFile: vi.fn(),
  createDirectory: vi.fn(),
}))

import { useOutlineChatStore } from "./outline-chat-store"
import { readFile, writeFile, createDirectory } from "@/commands/fs"

const DISK_PATH = "E:/Novel/.qmai/outline-chats.json"
const PARENT_DIR = "E:/Novel/.qmai"

/** 等待 fire-and-forget 的 saveToDisk 异步链（createDirectory → writeFile）完成 */
async function flushAsync(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0))
}

beforeEach(() => {
  mockWiki.project = { path: "E:\\Novel" } // 反斜杠路径 → normalizePath 转正斜杠
  ;(readFile as Mock).mockReset()
  ;(writeFile as Mock).mockReset()
  ;(createDirectory as Mock).mockReset()
  ;(readFile as Mock).mockResolvedValue('{"conversations":[],"activeConversationId":null}')
  ;(writeFile as Mock).mockResolvedValue(undefined)
  ;(createDirectory as Mock).mockResolvedValue(undefined)
  useOutlineChatStore.setState({
    conversations: [],
    activeConversationId: null,
    streamingContent: "",
    isStreaming: false,
    loaded: false,
  })
})

describe("outline chat store — 初始状态", () => {
  it("默认字段正确", () => {
    const s = useOutlineChatStore.getState()
    expect(s.conversations).toEqual([])
    expect(s.activeConversationId).toBeNull()
    expect(s.streamingContent).toBe("")
    expect(s.isStreaming).toBe(false)
    expect(s.loaded).toBe(false)
  })
})

describe("outline chat store — 会话管理", () => {
  it("createConversation 创建会话、设为活跃、写入磁盘", async () => {
    const id = useOutlineChatStore.getState().createConversation()
    await flushAsync()
    const s = useOutlineChatStore.getState()
    expect(id).toMatch(/^[0-9a-f-]{36}$/) // uuid
    expect(s.conversations).toHaveLength(1)
    expect(s.conversations[0]!.id).toBe(id)
    expect(s.conversations[0]!.title).toMatch(/^大纲对话 \d{2}:\d{2}$/)
    expect(s.conversations[0]!.createdAt).toBeGreaterThan(0)
    expect(s.conversations[0]!.messages).toEqual([])
    expect(s.activeConversationId).toBe(id)
    // 磁盘持久化
    expect(createDirectory).toHaveBeenCalledWith(PARENT_DIR)
    expect(writeFile).toHaveBeenCalledTimes(1)
    const [path, content] = (writeFile as Mock).mock.calls[0]!
    expect(path).toBe(DISK_PATH)
    expect(JSON.parse(content as string).conversations[0].id).toBe(id)
  })

  it("createConversation 新会话置顶", () => {
    useOutlineChatStore.getState().createConversation()
    useOutlineChatStore.getState().createConversation()
    const convs = useOutlineChatStore.getState().conversations
    expect(convs).toHaveLength(2)
    expect(convs[0]!.createdAt).toBeGreaterThanOrEqual(convs[1]!.createdAt)
  })

  it("setActiveConversation 设置/清空活跃会话", () => {
    const id = useOutlineChatStore.getState().createConversation()
    useOutlineChatStore.getState().setActiveConversation(null)
    expect(useOutlineChatStore.getState().activeConversationId).toBeNull()
    useOutlineChatStore.getState().setActiveConversation(id)
    expect(useOutlineChatStore.getState().activeConversationId).toBe(id)
  })

  it("addMessage 追加到指定会话并持久化，不影响其他会话", async () => {
    const id1 = useOutlineChatStore.getState().createConversation()
    const id2 = useOutlineChatStore.getState().createConversation()
    useOutlineChatStore.getState().addMessage(id2, { id: "m1", role: "user", content: "你好" })
    await flushAsync()
    const conv2 = useOutlineChatStore.getState().conversations.find((c) => c.id === id2)!
    expect(conv2.messages).toHaveLength(1)
    expect(conv2.messages[0]!.content).toBe("你好")
    const conv1 = useOutlineChatStore.getState().conversations.find((c) => c.id === id1)!
    expect(conv1.messages).toEqual([])
    expect(writeFile).toHaveBeenCalled()
  })

  it("deleteConversation 删除活跃会话时清空活跃 ID 并持久化", async () => {
    const id = useOutlineChatStore.getState().createConversation()
    await flushAsync()
    ;(writeFile as Mock).mockClear()
    useOutlineChatStore.getState().deleteConversation(id)
    await flushAsync()
    const s = useOutlineChatStore.getState()
    expect(s.conversations).toEqual([])
    expect(s.activeConversationId).toBeNull()
    expect(writeFile).toHaveBeenCalled()
  })

  it("deleteConversation 删除非活跃会话时保留活跃 ID", async () => {
    const id1 = useOutlineChatStore.getState().createConversation()
    const id2 = useOutlineChatStore.getState().createConversation() // active = id2
    await flushAsync()
    ;(writeFile as Mock).mockClear()
    useOutlineChatStore.getState().deleteConversation(id1)
    await flushAsync()
    const s = useOutlineChatStore.getState()
    expect(s.conversations).toHaveLength(1)
    expect(s.activeConversationId).toBe(id2)
  })

  it("removeLastMessage 移除会话最后一条消息", () => {
    const id = useOutlineChatStore.getState().createConversation()
    useOutlineChatStore.getState().addMessage(id, { id: "a", role: "user", content: "A" })
    useOutlineChatStore.getState().addMessage(id, { id: "b", role: "assistant", content: "B" })
    useOutlineChatStore.getState().removeLastMessage(id)
    const msgs = useOutlineChatStore.getState().conversations[0]!.messages
    expect(msgs).toHaveLength(1)
    expect(msgs[0]!.content).toBe("A")
  })

  it("removeLastMessage 空会话调用 slice(0,-1) 保持为空", () => {
    const id = useOutlineChatStore.getState().createConversation()
    useOutlineChatStore.getState().removeLastMessage(id)
    expect(useOutlineChatStore.getState().conversations[0]!.messages).toEqual([])
  })

  it("removeLastMessage 多会话时仅影响目标会话（map else 分支）", () => {
    const id1 = useOutlineChatStore.getState().createConversation()
    const id2 = useOutlineChatStore.getState().createConversation()
    useOutlineChatStore.getState().addMessage(id2, { id: "m1", role: "user", content: "A" })
    useOutlineChatStore.getState().addMessage(id2, { id: "m2", role: "user", content: "B" })
    useOutlineChatStore.getState().removeLastMessage(id2)
    const conv1 = useOutlineChatStore.getState().conversations.find((c) => c.id === id1)!
    const conv2 = useOutlineChatStore.getState().conversations.find((c) => c.id === id2)!
    expect(conv1.messages).toEqual([])
    expect(conv2.messages).toHaveLength(1)
    expect(conv2.messages[0]!.content).toBe("A")
  })
})

describe("outline chat store — replaceLastAssistant", () => {
  it("最后一条是 assistant 时替换内容与 sources，并按首条用户消息派生标题", () => {
    const id = useOutlineChatStore.getState().createConversation()
    useOutlineChatStore.getState().addMessage(id, { id: "u", role: "user", content: "帮我写大纲" })
    useOutlineChatStore.getState().addMessage(id, { id: "a1", role: "assistant", content: "旧回答" })
    useOutlineChatStore.getState().replaceLastAssistant(id, "新回答", ["src1.md"])
    const conv = useOutlineChatStore.getState().conversations[0]!
    expect(conv.messages).toHaveLength(2)
    const last = conv.messages[1]!
    expect(last.content).toBe("新回答")
    expect(last.sources).toEqual(["src1.md"])
    // 标题 = 首条用户消息前 20 字
    expect(conv.title).toBe("帮我写大纲")
  })

  it("首条用户消息超过 20 字时标题截断加省略号", () => {
    const id = useOutlineChatStore.getState().createConversation()
    const long = "一二三四五六七八九十一二三四五六七八九十一二三四五六七八九十"
    useOutlineChatStore.getState().addMessage(id, { id: "u", role: "user", content: long })
    useOutlineChatStore.getState().replaceLastAssistant(id, "回答")
    const conv = useOutlineChatStore.getState().conversations[0]!
    expect(conv.title).toBe(`${long.slice(0, 20)}...`)
  })

  it("最后一条不是 assistant 时追加新 assistant 消息", () => {
    const id = useOutlineChatStore.getState().createConversation()
    useOutlineChatStore.getState().addMessage(id, { id: "u", role: "user", content: "提问" })
    useOutlineChatStore.getState().replaceLastAssistant(id, "第一次回答")
    const conv = useOutlineChatStore.getState().conversations[0]!
    expect(conv.messages).toHaveLength(2)
    expect(conv.messages[1]!.role).toBe("assistant")
    expect(conv.messages[1]!.content).toBe("第一次回答")
    expect(conv.messages[1]!.id).toMatch(/^[0-9a-f-]{36}$/)
    // 再次调用：最后一条已是 assistant → 替换
    useOutlineChatStore.getState().replaceLastAssistant(id, "第二次回答")
    const conv2 = useOutlineChatStore.getState().conversations[0]!
    expect(conv2.messages).toHaveLength(2)
    expect(conv2.messages[1]!.content).toBe("第二次回答")
  })

  it("空会话直接追加 assistant（lastIdx < 0 分支）", () => {
    const id = useOutlineChatStore.getState().createConversation()
    useOutlineChatStore.getState().replaceLastAssistant(id, "直接回答")
    const conv = useOutlineChatStore.getState().conversations[0]!
    expect(conv.messages).toHaveLength(1)
    expect(conv.messages[0]!.role).toBe("assistant")
    // 无用户消息 → 标题保持原样
    expect(conv.title).toMatch(/^大纲对话 /)
  })

  it("多会话时 replaceLastAssistant 仅影响目标会话（map 提前返回分支）", async () => {
    const id1 = useOutlineChatStore.getState().createConversation()
    const id2 = useOutlineChatStore.getState().createConversation()
    await flushAsync()
    useOutlineChatStore.getState().addMessage(id2, { id: "m1", role: "user", content: "目标会话消息" })
    useOutlineChatStore.getState().replaceLastAssistant(id2, "目标回答")
    await flushAsync()
    const conv1 = useOutlineChatStore.getState().conversations.find((c) => c.id === id1)!
    const conv2 = useOutlineChatStore.getState().conversations.find((c) => c.id === id2)!
    expect(conv1.messages).toEqual([]) // 未命中 → return c
    expect(conv2.messages).toHaveLength(2)
    expect(conv2.messages[1]!.content).toBe("目标回答")
  })
})

describe("outline chat store — 流式状态", () => {
  it("setStreamingContent / setIsStreaming", () => {
    useOutlineChatStore.getState().setStreamingContent("正在生成…")
    useOutlineChatStore.getState().setIsStreaming(true)
    const s = useOutlineChatStore.getState()
    expect(s.streamingContent).toBe("正在生成…")
    expect(s.isStreaming).toBe(true)
  })
})

describe("outline chat store — 磁盘加载", () => {
  it("无项目时 loadFromDisk 直接返回，loaded 不变", async () => {
    mockWiki.project = null
    await useOutlineChatStore.getState().loadFromDisk()
    expect(useOutlineChatStore.getState().loaded).toBe(false)
    expect(readFile).not.toHaveBeenCalled()
  })

  it("读取成功时恢复会话与活跃 ID", async () => {
    ;(readFile as Mock).mockResolvedValue(
      JSON.stringify({
        conversations: [{ id: "c1", title: "对话", createdAt: 1, messages: [{ id: "m1", role: "user", content: "hi" }] }],
        activeConversationId: "c1",
      }),
    )
    await useOutlineChatStore.getState().loadFromDisk()
    const s = useOutlineChatStore.getState()
    expect(s.loaded).toBe(true)
    expect(s.conversations).toHaveLength(1)
    expect(s.conversations[0]!.id).toBe("c1")
    expect(s.activeConversationId).toBe("c1")
  })

  it("读取结果缺字段时 ?? 兜底为空数组/null", async () => {
    ;(readFile as Mock).mockResolvedValue(JSON.stringify({}))
    await useOutlineChatStore.getState().loadFromDisk()
    const s = useOutlineChatStore.getState()
    expect(s.loaded).toBe(true)
    expect(s.conversations).toEqual([])
    expect(s.activeConversationId).toBeNull()
  })

  it("JSON 损坏时进入 catch，loaded=true 空状态", async () => {
    ;(readFile as Mock).mockResolvedValue("not json {{{")
    await useOutlineChatStore.getState().loadFromDisk()
    const s = useOutlineChatStore.getState()
    expect(s.loaded).toBe(true)
    expect(s.conversations).toEqual([])
    expect(s.activeConversationId).toBeNull()
  })

  it("readFile 拒绝时进入 catch，loaded=true", async () => {
    ;(readFile as Mock).mockRejectedValue(new Error("EACCES"))
    await useOutlineChatStore.getState().loadFromDisk()
    expect(useOutlineChatStore.getState().loaded).toBe(true)
  })
})

describe("outline chat store — 磁盘保存", () => {
  it("无项目时 saveToDisk 直接返回", async () => {
    mockWiki.project = null
    await useOutlineChatStore.getState().saveToDisk()
    expect(createDirectory).not.toHaveBeenCalled()
    expect(writeFile).not.toHaveBeenCalled()
  })

  it("createDirectory 失败时错误被吞掉（内存状态保留）", async () => {
    ;(createDirectory as Mock).mockRejectedValue(new Error("EACCES"))
    await expect(useOutlineChatStore.getState().saveToDisk()).resolves.toBeUndefined()
    expect(writeFile).not.toHaveBeenCalled()
  })

  it("writeFile 失败时错误被吞掉", async () => {
    ;(writeFile as Mock).mockRejectedValue(new Error("ENOSPC"))
    await expect(useOutlineChatStore.getState().saveToDisk()).resolves.toBeUndefined()
  })

  it("saveToDisk 写出完整 conversations + activeConversationId", async () => {
    useOutlineChatStore.getState().createConversation()
    await useOutlineChatStore.getState().saveToDisk()
    const [path, content] = (writeFile as Mock).mock.calls[0]!
    expect(path).toBe(DISK_PATH)
    const payload = JSON.parse(content as string)
    expect(payload.conversations).toHaveLength(1)
    expect(typeof payload.activeConversationId).toBe("string")
  })
})
