import type { LlmConfig } from "@/stores/wiki-store"
import { streamChat, combineAbortSignals, DEFAULT_LLM_REQUEST_TIMEOUT_MS, type ChatMessage } from "@/lib/llm-client"

/**
 * 使用 LLM 为章节生成标题。
 *
 * @param content 章节正文内容
 * @param chapterNumber 章节号
 * @param llmConfig LLM 配置（使用当前会话模型）
 * @param signal AbortSignal 用于取消请求
 * @returns 生成的完整标题，格式为 "第X章 标题文字"
 *
 * 设计说明：
 * - 使用当前会话模型，保证风格一致性
 * - 失败时抛出错误，由调用方决定降级策略（回退到"第X章"）
 * - 温度设为 0.7，兼顾创意和稳定性
 */
export async function generateChapterTitle(
  content: string,
  chapterNumber: number,
  llmConfig: LlmConfig,
  signal?: AbortSignal,
): Promise<string> {
  // 截取内容的前 3000 字符用于标题生成，避免 token 浪费
  const contentPreview = content.length > 3000 ? content.slice(0, 3000) + "..." : content

  const prompt = `请为下面的小说章节内容生成一个简洁有力的章节标题。

要求：
1. 只输出标题本身，不要任何解释、前缀、后缀或引号
2. 标题长度控制在 4-12 个字之间
3. 要能概括本章核心内容或关键冲突
4. 要有文学性，符合小说风格
5. 不要包含"第${chapterNumber}章"字样，我会自己加

章节内容：
${contentPreview}

请直接输出标题：`

  const messages: ChatMessage[] = [
    {
      role: "user",
      content: prompt,
    },
  ]

  const tokens: string[] = []
  let streamError: Error | null = null

  await streamChat(
    llmConfig,
    messages,
    {
      onToken: (t) => tokens.push(t),
      onDone: () => {},
      onError: (e) => {
        streamError = e
      },
    },
    combineAbortSignals(signal, AbortSignal.timeout(DEFAULT_LLM_REQUEST_TIMEOUT_MS)),
    {
      temperature: 0.7,
      max_tokens: 100,
    },
  )

  if (streamError) {
    throw streamError as Error
  }

  let title = tokens.join("").trim()

  // 清理：去除可能的引号、书名号、前缀等
  title = title.replace(/^["'《「“]+/, "").replace(/["'》」”]+$/, "")
  title = title.replace(/^第\s*\d+\s*章[：:\s]*/, "") // 去掉模型可能加的"第X章："前缀
  title = title.replace(/^标题[：:\s]*/, "")
  title = title.trim()

  // 如果生成结果为空，回退到默认标题
  if (!title) {
    title = `第${chapterNumber}章`
  } else {
    title = `第${chapterNumber}章 ${title}`
  }

  return title
}
