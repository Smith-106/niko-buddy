// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Niko Studio Contributors
// Chat store — conversation management, streaming state and message history.

import { create } from "zustand"
import type { ChatMessage } from "@/lib/llm-client"
import i18n from "@/i18n"

/** A persisted conversation record with metadata and UI state. */
export interface Conversation {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  deAiMode: boolean
  inputDraft?: string
}

/** Source page cited by an assistant response (snapshot at creation time). */
export interface MessageReference {
  title: string
  path: string
}

/** A displayable message bound to a specific conversation. */
export interface DisplayMessage {
  id: string
  role: "user" | "assistant" | "system"
  content: string
  timestamp: number
  conversationId: string
  references?: MessageReference[]  // pages cited in this response, saved at creation time
  discarded?: boolean
}

/** Internal state shape for the chat store. */
interface ChatState {
  conversations: Conversation[]
  activeConversationId: string | null
  messages: DisplayMessage[]
  /** Per-conversation streaming content buffer, keyed by conversation ID. */
  streamingContents: Record<string, string>
  mode: "chat" | "ingest"
  ingestSource: string | null
  maxHistoryMessages: number

  // Conversation management
  createConversation: () => string
  deleteConversation: (id: string) => void
  setActiveConversation: (id: string | null) => void
  renameConversation: (id: string, title: string) => void
  setConversationDeAiMode: (id: string, deAiMode: boolean) => void
  setConversationInputDraft: (id: string, draft: string) => void

  // Message management
  addMessage: (role: DisplayMessage["role"], content: string) => void
  setMessages: (messages: DisplayMessage[]) => void
  setConversations: (conversations: Conversation[]) => void
  /** Begin streaming generation for the given conversation. */
  startStreaming: (conversationId: string) => void
  /** Append an incremental token (32ms/1KB batched; use flushStreamTokens in tests). */
  appendStreamToken: (token: string, conversationId: string) => void
  /** Replace the entire streaming buffer (used by deep mode batch updates). */
  setStreamingContent: (content: string, conversationId: string) => void
  /** Finalise streaming: persist content as an assistant message. */
  finalizeStream: (content: string, references?: MessageReference[] | undefined, targetConvId?: string) => void
  /** Discard streaming state without persisting (stop button). */
  clearStreaming: (conversationId: string) => void
  setMode: (mode: ChatState["mode"]) => void
  setIngestSource: (path: string | null) => void
  clearMessages: () => void
  setMaxHistoryMessages: (n: number) => void
  removeLastAssistantMessage: () => void  // for regenerate: remove last assistant reply
  markLastAssistantDiscarded: () => void   // for novel draft discard

  // Helpers
  getActiveMessages: () => DisplayMessage[]
  isConversationStreaming: (conversationId: string) => boolean
  getStreamingContent: (conversationId: string) => string
  /** Whether any conversation is currently streaming. */
  isAnyStreaming: () => boolean
}

/** Monotonic counter for generating unique message identifiers. */
let msgSeq = 0

/** Mints the next unique message ID. */
function nextMsgId(): string {
  msgSeq += 1
  return String(msgSeq)
}

/** Generates a collision-resistant conversation identifier. */
function makeConversationId(): string {
  return `conv_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
}

/**
 * Removes a key from a `Record<string, V>` immutably, returning the
 * remaining entries. Used to clean up streaming state per conversation.
 */
function withoutKey<V>(record: Record<string, V>, key: string): Record<string, V> {
  const { [key]: _removed, ...rest } = record
  return rest
}

// P0-3：流式 token 批刷。每 token 一次 set 会触发全量对象扩散 + O(n²)
// 拼接；此处先缓冲，32ms 或 1KB 阈值到达后一次 set 合并。startStreaming
// 仍同步建键（handleRegenerate / auto-save 的守卫依赖同步可见性）。
const STREAM_FLUSH_MS = 32
const STREAM_FLUSH_CHARS = 1024
const pendingStreamTokens: Record<string, string> = {}
let pendingStreamChars = 0
let streamFlushTimer: ReturnType<typeof setTimeout> | null = null

function dropPendingStreamTokens(conversationId: string): void {
  if (pendingStreamTokens[conversationId] !== undefined) {
    pendingStreamChars -= pendingStreamTokens[conversationId]!.length
    delete pendingStreamTokens[conversationId]
  }
  if (Object.keys(pendingStreamTokens).length === 0 && streamFlushTimer !== null) {
    clearTimeout(streamFlushTimer)
    streamFlushTimer = null
  }
}

/** Flush buffered stream tokens into state (single set). Tests call this explicitly. */
export function flushStreamTokens(conversationId?: string): void {
  const ids = conversationId !== undefined ? [conversationId] : Object.keys(pendingStreamTokens)
  if (ids.length === 0) return
  useChatStore.setState((prev) => {
    const next = { ...prev.streamingContents }
    for (const id of ids) {
      const pending = pendingStreamTokens[id]
      if (pending === undefined) continue
      next[id] = (next[id] ?? "") + pending
      pendingStreamChars -= pending.length
      delete pendingStreamTokens[id]
    }
    return { streamingContents: next }
  })
  if (Object.keys(pendingStreamTokens).length === 0 && streamFlushTimer !== null) {
    clearTimeout(streamFlushTimer)
    streamFlushTimer = null
  }
}

function scheduleStreamFlush(): void {
  if (streamFlushTimer !== null || pendingStreamChars >= STREAM_FLUSH_CHARS) {
    if (pendingStreamChars >= STREAM_FLUSH_CHARS) flushStreamTokens()
    return
  }
  streamFlushTimer = setTimeout(() => {
    streamFlushTimer = null
    flushStreamTokens()
  }, STREAM_FLUSH_MS)
}

/**
 * Core chat Zustand store. Manages multi-conversation state,
 * streaming generation buffers, and message history. Supports
 * concurrent streaming across conversations via per-ID buffers.
 */
export const useChatStore = create<ChatState>((set, get) => ({
  conversations: [],
  activeConversationId: null,
  messages: [],
  streamingContents: {},
  mode: "chat",
  ingestSource: null,
  maxHistoryMessages: 20,

  createConversation: () => {
    const convId = makeConversationId()
    const now = Date.now()
    const newConv: Conversation = {
      id: convId,
      title: i18n.t("chat.newConversation"),
      createdAt: now,
      updatedAt: now,
      deAiMode: false,
      inputDraft: "",
    }
    set((prev) => ({
      conversations: [newConv, ...prev.conversations],
      activeConversationId: convId,
    }))
    return convId
  },

  deleteConversation: (convId) =>
    set((prev) => {
      const remaining = prev.conversations.filter((c) => c.id !== convId)
      const newActiveId =
        prev.activeConversationId === convId
          ? (remaining[0]?.id ?? null)
          : prev.activeConversationId
      return {
        conversations: remaining,
        messages: prev.messages.filter((m) => m.conversationId !== convId),
        activeConversationId: newActiveId,
        streamingContents: withoutKey(prev.streamingContents, convId),
      }
    }),

  setActiveConversation: (convId) => set({ activeConversationId: convId }),

  renameConversation: (convId, title) =>
    set((prev) => ({
      conversations: prev.conversations.map((c) =>
        c.id === convId ? { ...c, title, updatedAt: Date.now() } : c
      ),
    })),

  setConversationDeAiMode: (convId, deAiMode) =>
    set((prev) => ({
      conversations: prev.conversations.map((c) =>
        c.id === convId ? { ...c, deAiMode, updatedAt: Date.now() } : c
      ),
    })),

  setConversationInputDraft: (convId, draft) =>
    set((prev) => ({
      conversations: prev.conversations.map((c) =>
        c.id === convId ? { ...c, inputDraft: draft } : c
      ),
    })),

  addMessage: (role, content) =>
    set((prev) => {
      const { activeConversationId, conversations } = prev
      if (!activeConversationId) return prev

      const msg: DisplayMessage = {
        id: nextMsgId(),
        role,
        content,
        timestamp: Date.now(),
        conversationId: activeConversationId,
      }

      // Auto-title from the first user message (first 50 chars).
      const existingUserMsgs = prev.messages.filter(
        (m) => m.conversationId === activeConversationId && m.role === "user"
      )
      const updatedConvs =
        role === "user" && existingUserMsgs.length === 0
          ? conversations.map((c) =>
              c.id === activeConversationId
                ? { ...c, title: content.slice(0, 50), updatedAt: Date.now() }
                : c
            )
          : conversations.map((c) =>
              c.id === activeConversationId
                ? { ...c, updatedAt: Date.now() }
                : c
            )

      return {
        messages: [...prev.messages, msg],
        conversations: updatedConvs,
      }
    }),

  setMessages: (messages) => set({ messages }),
  setConversations: (conversations) => set({ conversations }),

  startStreaming: (conversationId) => {
    dropPendingStreamTokens(conversationId)
    set((prev) => ({
      streamingContents: { ...prev.streamingContents, [conversationId]: "" },
    }))
  },

  appendStreamToken: (token, conversationId) => {
    pendingStreamTokens[conversationId] = (pendingStreamTokens[conversationId] ?? "") + token
    pendingStreamChars += token.length
    scheduleStreamFlush()
  },

  setStreamingContent: (content, conversationId) => {
    // 显式整体替换优先：丢弃该会话缓冲（与旧“覆盖一切”语义一致）。
    dropPendingStreamTokens(conversationId)
    set((prev) => ({
      streamingContents: { ...prev.streamingContents, [conversationId]: content },
    }))
  },

  finalizeStream: (content, references, targetConvId) => {
    const st = get()
    dropPendingStreamTokens(targetConvId ?? st.activeConversationId ?? "")
    set((prev) => {
      const convId = targetConvId ?? prev.activeConversationId
      if (!convId) return {}

      const assistantMsg: DisplayMessage = {
        id: nextMsgId(),
        role: "assistant" as const,
        content,
        timestamp: Date.now(),
        conversationId: convId,
        references,
      }

      return {
        streamingContents: withoutKey(prev.streamingContents, convId),
        messages: [...prev.messages, assistantMsg],
        conversations: prev.conversations.map((c) =>
          c.id === convId ? { ...c, updatedAt: Date.now() } : c
        ),
      }
    })
  },

  clearStreaming: (conversationId) => {
    dropPendingStreamTokens(conversationId)
    set((prev) => ({
      streamingContents: withoutKey(prev.streamingContents, conversationId),
    }))
  },

  setMode: (mode) => set({ mode }),
  setIngestSource: (source) => set({ ingestSource: source }),

  clearMessages: () =>
    set((prev) => ({
      messages: prev.messages.filter(
        (m) => m.conversationId !== prev.activeConversationId
      ),
    })),

  setMaxHistoryMessages: (limit) => set({ maxHistoryMessages: limit }),

  removeLastAssistantMessage: () =>
    set((prev) => {
      const activeId = prev.activeConversationId
      if (!activeId) return prev
      const convMsgs = prev.messages.filter((m) => m.conversationId === activeId)
      const lastIdx = [...convMsgs].reverse().findIndex((m) => m.role === "assistant")
      if (lastIdx === -1) return prev
      const target = convMsgs[convMsgs.length - 1 - lastIdx]
      return { messages: prev.messages.filter((m) => m.id !== target.id) }
    }),

  markLastAssistantDiscarded: () =>
    set((prev) => {
      const activeId = prev.activeConversationId
      if (!activeId) return prev
      const convMsgs = prev.messages.filter((m) => m.conversationId === activeId)
      const lastIdx = [...convMsgs].reverse().findIndex((m) => m.role === "assistant")
      if (lastIdx === -1) return prev
      const target = convMsgs[convMsgs.length - 1 - lastIdx]
      return {
        messages: prev.messages.map((m) =>
          m.id === target.id ? { ...m, discarded: true, content: "" } : m
        ),
      }
    }),

  getActiveMessages: () => {
    const { messages, activeConversationId } = get()
    return activeConversationId
      ? messages.filter((m) => m.conversationId === activeConversationId)
      : []
  },

  isConversationStreaming: (conversationId) => conversationId in get().streamingContents,

  getStreamingContent: (conversationId) =>
    (get().streamingContents[conversationId] ?? "") + (pendingStreamTokens[conversationId] ?? ""),

  isAnyStreaming: () =>
    Object.keys(get().streamingContents).length > 0 || Object.keys(pendingStreamTokens).length > 0,
}))

/** Converts display messages to the LLM wire format for API submission. */
export function chatMessagesToLLM(messages: DisplayMessage[]): ChatMessage[] {
  return messages.map((m) => ({
    role: m.role,
    content: m.content,
  }))
}
