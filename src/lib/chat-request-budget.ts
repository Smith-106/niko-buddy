/**
 * Utilities for managing LLM chat message size against token budgets.
 * Implements character-based trimming strategies to keep conversation history
 * within configurable limits while preserving user intent.
 * MIT licensed implementation.
 */

import type { ChatMessage, ContentBlock } from "./llm-providers"
import {
  estimateMessagesTokens,
  estimateScaffoldTokens,
  tokensToCharBudget,
} from "./token-estimator"

/** Marker string inserted when history is truncated due to budget constraints */
const HISTORY_TRUNCATED_MARKER = "[history truncated]\n" as const

/**
 * Calculates character count for a single content value.
 * Handles both string and array of content blocks.
 */
function contentLength(content: ChatMessage["content"]): number {
  if (typeof content === "string") return content.length
  return content.reduce((sum, block) => {
    if (block.type === "text") return sum + block.text.length
    return sum + block.dataBase64.length
  }, 0)
}

/**
 * Calculates total characters in a chat message.
 */
function messageLength(message: ChatMessage): number {
  return contentLength(message.content)
}

/**
 * Sums all characters across multiple messages.
 */
function totalLength(messages: ChatMessage[]): number {
  return messages.reduce((sum, message) => sum + messageLength(message), 0)
}

/**
 * Truncates text to fit within maxChars, preserving the tail.
 * Inserts truncation marker when necessary.
 */
function clampTail(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  if (maxChars <= HISTORY_TRUNCATED_MARKER.length) {
    return HISTORY_TRUNCATED_MARKER.slice(0, maxChars)
  }
  return (
    HISTORY_TRUNCATED_MARKER +
    text.slice(-(maxChars - HISTORY_TRUNCATED_MARKER.length))
  )
}

/**
 * Trims content (string or blocks) to fit within character budget.
 * Preserves most recent content by trimming from the beginning.
 */
function trimContent(
  content: ChatMessage["content"],
  maxChars: number,
): ChatMessage["content"] {
  if (typeof content === "string") return clampTail(content, maxChars)

  let remaining = maxChars
  const reversed: ContentBlock[] = []
  for (let i = content.length - 1; i >= 0; i -= 1) {
    const block = content[i]
    if (!block) continue
    if (block.type !== "text") {
      const len = block.dataBase64.length
      if (len <= remaining) {
        reversed.push(block)
        remaining -= len
      }
      continue
    }

    const text = clampTail(block.text, remaining)
    if (text.length > 0) {
      reversed.push({ ...block, text })
      remaining -= text.length
    }
    if (remaining <= 0) break
  }

  return reversed.reverse()
}

/**
 * Checks if a message at given index is part of leading system messages.
 */
function isLeadingSystemMessage(
  messages: ChatMessage[],
  index: number,
): boolean {
  return (
    messages[index]?.role === "system" &&
    messages.slice(0, index).every((message) => message.role === "system")
  )
}

/**
 * Creates a copy of a message with trimmed content.
 */
function trimMessage(message: ChatMessage, maxChars: number): ChatMessage {
  return {
    ...message,
    content: trimContent(message.content, Math.max(0, maxChars)),
  }
}

/**
 * Trims chat messages to fit within a **token** budget before sending to LLM.
 * Preserves the most recent user message (carrying latest intent) by trimming
 * older messages first. Uses a multi-pass strategy: drop old messages, then
 * truncate remaining content as needed.
 *
 * 参数是 token 预算，不是字符预算。调用方（runner）传的是
 * `maxContextSize × 0.75`，那是 token 数；旧实现把 token 数当字符数比较，
 * 中文场景因 1 字符 ≈ 1 token 碰巧接近，英文场景则浪费约 4 倍上下文。
 *
 * 实现方式：先用校准估算器算出真实 token 量，超预算时按本文本的实际
 * tokens/char 比率折算成字符预算，再复用既有的字符裁剪机制（它已经处理了
 * 「保留最新用户消息」「插截断标记」「块数组裁剪」等细节）。折算后复检，
 * 仍未达标就按实际超限比例再压一次。
 *
 * @param messages - Array of chat messages in conversation order
 * @param maxTokens - Maximum total token budget allowed
 * @returns Trimmed message array that fits within budget
 */
export function trimChatMessagesToTokenBudget(
  messages: import("@/lib/llm-providers").ChatMessage[],
  maxTokens: number,
): import("@/lib/llm-providers").ChatMessage[] {
  if (messages.length === 0) return messages
  if (!Number.isFinite(maxTokens) || maxTokens <= 0) return messages

  const currentTokens = estimateMessagesTokens(messages)
  if (currentTokens <= maxTokens) return messages

  // 第一轮：按实际 tokens/char 比率折算字符预算
  let charBudget = tokensToCharBudget(messages, maxTokens)
  let next = trimChatMessagesToBudget(messages, charBudget)

  // 第二轮：字符裁剪的粒度不完全对齐 token 估算（例如截断标记本身也占 token），
  // 复检一次，仍未达标就按剩余比例继续压。最多两轮，避免无限循环。
  let remainingTokens = estimateMessagesTokens(next)
  if (remainingTokens > maxTokens) {
    charBudget = Math.max(1, Math.floor(charBudget * (maxTokens / remainingTokens)))
    next = trimChatMessagesToBudget(next, charBudget)
    remainingTokens = estimateMessagesTokens(next)
  }

  return next
}

export function trimChatMessagesToBudget(
  messages: ChatMessage[],
  maxChars: number,
): ChatMessage[] {
  if (messages.length === 0) return messages
  if (!Number.isFinite(maxChars) || maxChars <= 0) return messages
  if (totalLength(messages) <= maxChars) return messages

  let next = [...messages]

  const canDrop = (
    message: ChatMessage,
    index: number,
  ): boolean =>
    index !== next.length - 1 &&
    !isLeadingSystemMessage(next, index) &&
    message.role !== "system"

  // Pass 1: Drop oldest non-system, non-essential messages
  while (totalLength(next) > maxChars) {
    const droppableIndices = next
      .map((message, index) => ({ message, index }))
      .filter(({ message, index }) => canDrop(message, index))

    if (droppableIndices.length <= 1) break
    next = next.filter(
      (_message, index) => index !== droppableIndices[0]?.index,
    )
  }

  if (totalLength(next) <= maxChars) return next

  // Pass 2: Trim content of older messages
  for (
    let i = 0;
    i < next.length - 1 && totalLength(next) > maxChars;
    i += 1
  ) {
    if (isLeadingSystemMessage(next, i) || next[i]?.role === "system") continue
    const excess = totalLength(next) - maxChars
    const current = next[i]
    /* v8 ignore next */
    if (!current) continue
    const targetLength = Math.max(0, messageLength(current) - excess)
    next[i] = trimMessage(current, targetLength)
  }

  if (totalLength(next) <= maxChars) return next

  // Pass 3: Final pass for any remaining excess
  for (
    let i = 0;
    i < next.length - 1 && totalLength(next) > maxChars;
    i += 1
  ) {
    const current = next[i]
    /* v8 ignore next */
    if (!current) continue
    const excess = totalLength(next) - maxChars
    const targetLength = Math.max(0, messageLength(current) - excess)
    next[i] = trimMessage(current, targetLength)
  }

  return next
}

/**
 * v3 agent 兼容：估算消息 token 总量。
 *
 * 口径已从「字符数 / 3」改为按字符脚本分类校准（见 token-estimator.ts）。
 * 旧口径对中文低估约 2.6 倍，导致预算按低估值放行而实际发送量翻倍。
 */
export function estimateChatMessagesTokens(messages: import("@/lib/llm-providers").ChatMessage[]): number {
  return estimateMessagesTokens(messages)
}

export function estimateRequestScaffoldTokens(tools: unknown): number {
  return estimateScaffoldTokens(tools)
}
