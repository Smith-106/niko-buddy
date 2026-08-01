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
  /** Append an incremental token to the streaming buffer. */
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

  startStreaming: (conversationId) =>
    set((prev) => ({
      streamingContents: { ...prev.streamingContents, [conversationId]: "" },
    })),

  appendStreamToken: (token, conversationId) =>
    set((prev) => ({
      streamingContents: {
        ...prev.streamingContents,
        [conversationId]: (prev.streamingContents[conversationId] ?? "") + token,
      },
    })),

  setStreamingContent: (content, conversationId) =>
    set((prev) => ({
      streamingContents: { ...prev.streamingContents, [conversationId]: content },
    })),

  finalizeStream: (content, references, targetConvId) =>
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
    }),

  clearStreaming: (conversationId) =>
    set((prev) => ({
      streamingContents: withoutKey(prev.streamingContents, conversationId),
    })),

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

  getStreamingContent: (conversationId) => get().streamingContents[conversationId] ?? "",

  isAnyStreaming: () => Object.keys(get().streamingContents).length > 0,
}))

/** Converts display messages to the LLM wire format for API submission. */
export function chatMessagesToLLM(messages: DisplayMessage[]): ChatMessage[] {
  return messages.map((m) => ({
    role: m.role,
    content: m.content,
  }))
}
