// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Niko Studio Contributors
// Outline chat store — persistent conversation state for the outline planning panel.

import { create } from "zustand"
import { readFile, writeFile, createDirectory } from "@/commands/fs"
import { normalizePath } from "@/lib/path-utils"
import { useWikiStore } from "@/stores/wiki-store"

/** A single message within an outline conversation. */
export interface OutlineChatMessage {
  id: string
  role: "user" | "assistant"
  content: string
  sources?: string[]
}

/**
 * A self-contained outline conversation, persisted to disk as JSON
 * alongside the active wiki project.
 */
export interface OutlineChatConversation {
  id: string
  title: string
  createdAt: number
  messages: OutlineChatMessage[]
}

/** Internal state shape for the outline chat store. */
interface OutlineChatState {
  conversations: OutlineChatConversation[]
  activeConversationId: string | null
  streamingContent: string
  isStreaming: boolean
  loaded: boolean

  createConversation: () => string
  setActiveConversation: (id: string | null) => void
  addMessage: (convId: string, msg: OutlineChatMessage) => void
  replaceLastAssistant: (convId: string, content: string, sources?: string[]) => void
  removeLastMessage: (convId: string) => void
  deleteConversation: (id: string) => void
  setStreamingContent: (content: string) => void
  setIsStreaming: (value: boolean) => void
  loadFromDisk: () => Promise<void>
  saveToDisk: () => Promise<void>
}

/**
 * Resolves the on-disk storage path for outline chats from the currently
 * loaded wiki project. Returns `null` when no project is open.
 */
function resolveStoragePath(): string | null {
  const project = useWikiStore.getState().project
  if (!project?.path) return null
  return `${normalizePath(project.path)}/.qmai/outline-chats.json`
}

/**
 * Derives a human-readable conversation title from the first user message.
 * Falls back to the current timestamp when no user message is present.
 */
function deriveTitle(messages: OutlineChatMessage[], fallback: string): string {
  const firstUser = messages.find((m) => m.role === "user")
  if (firstUser) {
    const snippet = firstUser.content.slice(0, 20)
    return firstUser.content.length > 20 ? `${snippet}...` : snippet
  }
  return fallback
}

/**
 * Zustand store for outline-specific conversations. Conversations are
 * persisted to `<project>/.qmai/outline-chats.json` so they survive
 * app restarts. Streaming state is intentionally excluded from disk.
 */
export const useOutlineChatStore = create<OutlineChatState>((set, get) => ({
  conversations: [],
  activeConversationId: null,
  streamingContent: "",
  isStreaming: false,
  loaded: false,

  createConversation: () => {
    const id = crypto.randomUUID()
    const timestamp = new Date().toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })
    const conv: OutlineChatConversation = {
      id,
      title: `大纲对话 ${timestamp}`,
      createdAt: Date.now(),
      messages: [],
    }
    set((prev) => ({
      conversations: [conv, ...prev.conversations],
      activeConversationId: id,
    }))
    void get().saveToDisk()
    return id
  },

  setActiveConversation: (convId) => set({ activeConversationId: convId }),

  addMessage: (convId, msg) => {
    set((prev) => ({
      conversations: prev.conversations.map((c) =>
        c.id === convId ? { ...c, messages: [...c.messages, msg] } : c
      ),
    }))
    void get().saveToDisk()
  },

  replaceLastAssistant: (convId, content, sources) => {
    set((prev) => ({
      conversations: prev.conversations.map((c) => {
        if (c.id !== convId) return c
        const msgs = [...c.messages]
        const lastIdx = msgs.length - 1
        if (lastIdx >= 0 && msgs[lastIdx].role === "assistant") {
          msgs[lastIdx] = { ...msgs[lastIdx], content, sources }
        } else {
          msgs.push({ id: crypto.randomUUID(), role: "assistant", content, sources })
        }
        const title = deriveTitle(msgs, c.title)
        return { ...c, messages: msgs, title }
      }),
    }))
    void get().saveToDisk()
  },

  removeLastMessage: (convId) => {
    set((prev) => ({
      conversations: prev.conversations.map((c) =>
        c.id === convId ? { ...c, messages: c.messages.slice(0, -1) } : c
      ),
    }))
    void get().saveToDisk()
  },

  deleteConversation: (convId) => {
    set((prev) => ({
      conversations: prev.conversations.filter((c) => c.id !== convId),
      activeConversationId: prev.activeConversationId === convId ? null : prev.activeConversationId,
    }))
    void get().saveToDisk()
  },

  setStreamingContent: (content) => set({ streamingContent: content }),
  setIsStreaming: (active) => set({ isStreaming: active }),

  loadFromDisk: async () => {
    const diskPath = getStoragePath()
    if (!diskPath) return
    try {
      const raw = await readFile(diskPath)
      const parsed = JSON.parse(raw) as {
        conversations: OutlineChatConversation[]
        activeConversationId: string | null
      }
      set({
        conversations: parsed.conversations ?? [],
        activeConversationId: parsed.activeConversationId ?? null,
        loaded: true,
      })
    } catch {
      // Corrupt or missing file — mark loaded with empty state.
      set({ loaded: true })
    }
  },

  saveToDisk: async () => {
    const diskPath = getStoragePath()
    if (!diskPath) return
    const { conversations, activeConversationId } = get()
    try {
      const parentDir = diskPath.replace(/[/\\][^/\\]+$/, "")
      await createDirectory(parentDir)
      await writeFile(diskPath, JSON.stringify({ conversations, activeConversationId }, null, 2))
    } catch {
      // Persistence errors are swallowed — chat remains in memory.
    }
  },
}))

/** Alias kept for backward-compatibility with the original helper name. */
function getStoragePath(): string | null {
  return resolveStoragePath()
}
