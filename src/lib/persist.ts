import { readFile, writeFileAtomic, createDirectory } from "@/commands/fs"
import { withProjectLock } from "@/lib/project-mutex"
import type { ReviewItem } from "@/stores/review-store"
import type { DisplayMessage, Conversation } from "@/stores/chat-store"
import { normalizePath } from "@/lib/path-utils"

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

async function ensureDir(projectPath: string): Promise<void> {
  await createDirectory(`${projectPath}/.qmai`).catch(() => {})
  await createDirectory(`${projectPath}/.qmai/chats`).catch(() => {})
}

export async function saveReviewItems(projectPath: string, items: ReviewItem[]): Promise<void> {
  const pp = normalizePath(projectPath)
  await ensureDir(pp)
  await writeFileAtomic(`${pp}/.qmai/review.json`, JSON.stringify(items, null, 2))
}

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

function describePersistError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function writeVerifiedJsonArray<T>(
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
    throw new Error(`${label} 写入后回读失败（${path}）：${describePersistError(error)}`)
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    throw new Error(`${label} 写入后不是有效 JSON（${path}）：${describePersistError(error)}`)
  }

  if (!verify(parsed)) {
    throw new Error(`${label} 写入后校验失败（${path}）`)
  }
}

function matchesConversationSnapshot(parsed: unknown, conversations: Conversation[]): boolean {
  return Array.isArray(parsed)
    && parsed.length === conversations.length
    && parsed.every((item, index) => (
      typeof item === "object"
      && item !== null
      && (item as Conversation).id === conversations[index]?.id
      && typeof (item as Conversation).title === "string"
    ))
}

function matchesMessageSnapshot(parsed: unknown, messages: DisplayMessage[]): boolean {
  return Array.isArray(parsed)
    && parsed.length === messages.length
    && parsed.every((item, index) => (
      typeof item === "object"
      && item !== null
      && (item as DisplayMessage).id === messages[index]?.id
      && (item as DisplayMessage).conversationId === messages[index]?.conversationId
      && (item as DisplayMessage).role === messages[index]?.role
    ))
}

export async function saveChatHistory(
  projectPath: string,
  conversations: Conversation[],
  messages: DisplayMessage[],
  maxMessages?: number
): Promise<void> {
  const pp = normalizePath(projectPath)
  await withProjectLock(`${pp}::chat-persist`, async () => {
    await ensureDir(pp)

    await writeVerifiedJsonArray(
      `${pp}/.qmai/conversations.json`,
      conversations,
      "聊天会话索引",
      (parsed) => matchesConversationSnapshot(parsed, conversations),
    )

    const byConversation = new Map<string, DisplayMessage[]>()
    for (const msg of messages) {
      const list = byConversation.get(msg.conversationId) ?? []
      list.push(msg)
      byConversation.set(msg.conversationId, list)
    }

    for (const [convId, msgs] of byConversation) {
      const toSave = msgs.slice(-(maxMessages || 100))
      await writeVerifiedJsonArray(
        `${pp}/.qmai/chats/${convId}.json`,
        toSave,
        `聊天消息文件 ${convId}`,
        (parsed) => matchesMessageSnapshot(parsed, toSave),
      )
    }
  })
}

export async function loadChatHistory(projectPath: string): Promise<PersistedChatData> {
  const pp = normalizePath(projectPath)
  try {
    // Try new format: separate files per conversation
    const convContent = await readFile(`${pp}/.qmai/conversations.json`)
    const conversations = safeParseArray<Conversation>(convContent, "conversations")

    const allMessages: DisplayMessage[] = []
    for (const conv of conversations) {
      try {
        const msgContent = await readFile(`${pp}/.qmai/chats/${conv.id}.json`)
        const msgs = safeParseArray<DisplayMessage>(msgContent, "messages")
        allMessages.push(...msgs)
      } catch {
        // Conversation file missing, skip
      }
    }

    return { conversations, messages: allMessages }
  } catch {
    // Fall back to old format
    try {
      const content = await readFile(`${pp}/.qmai/chat-history.json`)
      const parsed = JSON.parse(content)

      if (Array.isArray(parsed)) {
        // Very old format: flat array
        const legacyMessages = parsed as DisplayMessage[]
        const defaultConv: Conversation = {
          id: "default",
          title: "Previous Conversations",
          createdAt: legacyMessages[0]?.timestamp ?? Date.now(),
          updatedAt: legacyMessages[legacyMessages.length - 1]?.timestamp ?? Date.now(),
          deAiMode: false,
        }
        const migratedMessages = legacyMessages.map((m) => ({
          ...m,
          conversationId: "default",
        }))
        return { conversations: [defaultConv], messages: migratedMessages }
      }

      // Old combined format
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const data = parsed as PersistedChatData
        return data
      }
      console.warn("persist: 聊天历史数据格式无效")
      return { conversations: [], messages: [] }
    } catch {
      return { conversations: [], messages: [] }
    }
  }
}
