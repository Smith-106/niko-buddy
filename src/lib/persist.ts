/**
 * Persistent storage for chat history and review items.
 * Writes verified JSON snapshots to `.qmai/` with per-conversation
 * message files and backward-compatible legacy format migration.
 * MIT License — independently implemented.
 */

import { readFile, writeFileAtomic, createDirectory } from "@/commands/fs"
import { withProjectLock } from "@/lib/project-mutex"
import type { ReviewItem } from "@/stores/review-store"
import type { DisplayMessage, Conversation } from "@/stores/chat-store"
import { normalizePath } from "@/lib/path-utils"

/** Safely parse a JSON string into an array, returning [] on failure. */
function safeParseArray<T>(content: string, fieldName: string = "items"): T[] {
  try {
    const parsed = JSON.parse(content)
    if (!Array.isArray(parsed)) {
      console.warn(`persist: 解析数据不是数组，字段: ${fieldName}`)
      return []
    }
    return parsed as T[]
  } catch (err) {
    console.error(`persist: JSON 解析失败，字段: ${fieldName}`, err)
    return []
  }
}

/** Ensure the `.qmai/` and `.qmai/chats/` directories exist. */
async function ensureStorageDirs(projectPath: string): Promise<void> {
  await createDirectory(`${projectPath}/.qmai`).catch(() => {})
  await createDirectory(`${projectPath}/.qmai/chats`).catch(() => {})
}

/** Save review items as a JSON array to `.qmai/review.json`. */
export async function saveReviewItems(projectPath: string, items: ReviewItem[]): Promise<void> {
  const pp = normalizePath(projectPath)
  await ensureStorageDirs(pp)
  await writeFileAtomic(`${pp}/.qmai/review.json`, JSON.stringify(items, null, 2))
}

/** Load review items from `.qmai/review.json`, returning [] on any error. */
export async function loadReviewItems(projectPath: string): Promise<ReviewItem[]> {
  const pp = normalizePath(projectPath)
  try {
    const content = await readFile(`${pp}/.qmai/review.json`)
    return safeParseArray<ReviewItem>(content, "reviewItems")
  } catch {
    return []
  }
}

interface PersistedChatData {
  conversations: Conversation[]
  messages: DisplayMessage[]
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Write a JSON array to disk and verify it by re-reading and parsing.
 * Throws if the write-then-read cycle fails.
 */
async function writeAndVerifyJsonArray<T>(
  path: string,
  items: T[],
  label: string,
  verify: (parsed: unknown) => boolean,
): Promise<void> {
  await writeFileAtomic(path, JSON.stringify(items, null, 2))

  let raw: string
  try {
    raw = await readFile(path)
  } catch (error) {
    throw new Error(`${label} 写入后回读失败（${path}）：${errorText(error)}`)
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    throw new Error(`${label} 写入后不是有效 JSON（${path}）：${errorText(error)}`)
  }

  if (!verify(parsed)) {
    throw new Error(`${label} 写入后校验失败（${path}）`)
  }
}

/** Verify a parsed conversation snapshot matches the expected shape. */
function verifyConversationSnapshot(parsed: unknown, expected: Conversation[]): boolean {
  return Array.isArray(parsed)
    && parsed.length === expected.length
    && parsed.every((item, i) => (
      typeof item === "object"
      && item !== null
      && (item as Conversation).id === expected[i]?.id
      && typeof (item as Conversation).title === "string"
    ))
}

/** Verify a parsed message array matches the expected shape. */
function verifyMessageSnapshot(parsed: unknown, expected: DisplayMessage[]): boolean {
  return Array.isArray(parsed)
    && parsed.length === expected.length
    && parsed.every((item, i) => (
      typeof item === "object"
      && item !== null
      && (item as DisplayMessage).id === expected[i]?.id
      && (item as DisplayMessage).conversationId === expected[i]?.conversationId
      && (item as DisplayMessage).role === expected[i]?.role
    ))
}

/**
 * Save chat history: a conversations index file plus per-conversation
 * message files. Serialized under a project-scoped lock to prevent
 * overlapping writes from corrupting state.
 */
export async function saveChatHistory(
  projectPath: string,
  conversations: Conversation[],
  messages: DisplayMessage[],
  maxMessages?: number
): Promise<void> {
  const pp = normalizePath(projectPath)
  await withProjectLock(`${pp}::chat-persist`, async () => {
    await ensureStorageDirs(pp)

    await writeAndVerifyJsonArray(
      `${pp}/.qmai/conversations.json`,
      conversations,
      "聊天会话索引",
      (parsed) => verifyConversationSnapshot(parsed, conversations),
    )

    const grouped = new Map<string, DisplayMessage[]>()
    for (const msg of messages) {
      const list = grouped.get(msg.conversationId) ?? []
      list.push(msg)
      grouped.set(msg.conversationId, list)
    }

    for (const [convId, msgs] of grouped) {
      const trimmed = msgs.slice(-(maxMessages || 100))
      await writeAndVerifyJsonArray(
        `${pp}/.qmai/chats/${convId}.json`,
        trimmed,
        `聊天消息文件 ${convId}`,
        (parsed) => verifyMessageSnapshot(parsed, trimmed),
      )
    }
  })
}

/**
 * Load chat history from disk. Tries the new per-conversation format first;
 * falls back to legacy combined format and flat-array format for backward
 * compatibility.
 */
export async function loadChatHistory(projectPath: string): Promise<PersistedChatData> {
  const pp = normalizePath(projectPath)
  try {
    const convContent = await readFile(`${pp}/.qmai/conversations.json`)
    const conversations = safeParseArray<Conversation>(convContent, "conversations")

    const allMessages: DisplayMessage[] = []
    for (const conv of conversations) {
      try {
        const msgContent = await readFile(`${pp}/.qmai/chats/${conv.id}.json`)
        const msgs = safeParseArray<DisplayMessage>(msgContent, "messages")
        allMessages.push(...msgs)
      } catch {
        // Missing conversation file — skip.
      }
    }

    return { conversations, messages: allMessages }
  } catch {
    // Legacy format fallback.
    try {
      const content = await readFile(`${pp}/.qmai/chat-history.json`)
      const parsed = JSON.parse(content)

      if (Array.isArray(parsed)) {
        const legacy = parsed as DisplayMessage[]
        const defaultConv: Conversation = {
          id: "default",
          title: "Previous Conversations",
          createdAt: legacy[0]?.timestamp ?? Date.now(),
          updatedAt: legacy[legacy.length - 1]?.timestamp ?? Date.now(),
          deAiMode: false,
        }
        const migrated = legacy.map((m) => ({ ...m, conversationId: "default" }))
        return { conversations: [defaultConv], messages: migrated }
      }

      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as PersistedChatData
      }

      console.warn("persist: 聊天历史数据格式无效")
      return { conversations: [], messages: [] }
    } catch {
      return { conversations: [], messages: [] }
    }
  }
}
