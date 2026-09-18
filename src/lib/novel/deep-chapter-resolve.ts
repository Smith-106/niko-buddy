/**
 * deep-chapter-resolve — 解析/缓存辅助子模块（arch-risk W4 god-object 拆分）。
 *
 * 从 deep-chapter-generation.ts 抽出的纯解析函数：resolveCurrentChapterLengthSpec/
 * resolveWritingConfig/applyCachePrefix。主文件只做编排。
 */

import type { LlmConfig } from "@/stores/wiki-store"
import type { ChatMessage } from "@/lib/llm-client"
import { useWikiStore } from "@/stores/wiki-store"
import { resolveChapterLengthSpec, type ChapterLengthSpec } from "./deep-chapter-prompts"

export function resolveCurrentChapterLengthSpec(novelConfig: ReturnType<typeof useWikiStore.getState>["novelConfig"]): ChapterLengthSpec {
  return resolveChapterLengthSpec(novelConfig?.chapterTargetChars)
}

export function resolveWritingConfig(llmConfig: LlmConfig): LlmConfig {
  // 写作模型已移除，始终使用 AI 会话当前模型。
  // llmConfig 已在 chat-panel.tsx 中通过 effectiveChatLlmConfig 正确解析，
  // 不再通过 resolveNovelModel 重新解析，避免二次解析使用不同 API 端点/密钥
  return llmConfig
}

/**
 * 把以 cachePrefix 开头的 user 字符串消息拆成 [前缀块(cacheControl), 余下块]，
 * 让 provider 在稳定上下文前缀上打缓存断点。其余消息原样返回。
 * 注：Anthropic/MiniMax 会据此发出 cache_control；OpenAI/DeepSeek 端纯文本块会被
 * 折叠回与原字符串逐字节一致的内容，不影响其自动前缀缓存。
 */
export function applyCachePrefix(messages: ChatMessage[], cachePrefix?: string): ChatMessage[] {
  /* v8 ignore next */
  if (!cachePrefix) return messages
  return messages.map((message) => {
    /* v8 ignore next */
    if (
      message.role === "user" &&
      typeof message.content === "string" &&
      message.content.startsWith(cachePrefix)
    ) {
      const rest = message.content.slice(cachePrefix.length)
      return {
        role: message.role,
        content: [
          { type: "text" as const, text: cachePrefix, cacheControl: true },
          ...(rest ? [{ type: "text" as const, text: rest }] : []),
        ],
      }
    }
    return message
  })
}

