import type { LlmConfig } from "@/stores/wiki-store"
import { streamChat, combineAbortSignals, DEFAULT_LLM_REQUEST_TIMEOUT_MS, type ChatMessage } from "@/lib/llm-client"
import { isRichChapterTitle, resolveChapterTitle } from "./chapter-typography"
import { toErrorMessage } from "@/lib/utils"

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

/**
 * 标题来源（RV-001）：内容自带 / 模型生成 / 回退「第N章」/ 未启用。
 *
 * 「未启用」= novelConfig.autoGenerateChapterTitle 为假或没有章号——此时零额外 LLM 调用。
 */
export type ChapterTitleSource = "content" | "generated" | "fallback" | "disabled"

export interface EnsureChapterTitleOptions {
  /** 章节号；缺失时无法拼「第N章」，按 disabled 处理（不猜章号）。 */
  chapterNumber?: number
  llmConfig: LlmConfig
  /**
   * `novelConfig.autoGenerateChapterTitle` 真值。
   *
   * 必填且不在此处兜默认：本函数是配置的唯一消费者，再默认成 `true` 就会把
   * 「用户关了标题生成」重新变成恒真（旧缺口 RV-001）。
   */
  autoGenerateChapterTitle: boolean
  signal?: AbortSignal
  /** 测试注入；缺省走真实 `generateChapterTitle`。 */
  generateTitle?: typeof generateChapterTitle
}

export interface EnsureChapterTitleResult {
  /** 交付正文：无标题路径已补 `# 标题`，其余原样。 */
  content: string
  /** 解析/生成的标题；`disabled` 时为空串。 */
  title: string
  source: ChapterTitleSource
  /** `fallback` 时的失败原因（供调用方提示，不上抛）。 */
  error?: string
}

/** 正文开头的 H1 行（含其后换行），补标题前先摘掉，避免出现两个 H1。 */
const LEADING_H1_RE = /^\s*#[ \t]+[^\n]*(?:\r?\n)+/

function withTitleHeading(content: string, title: string): string {
  const body = content.replace(LEADING_H1_RE, "").trimStart()
  return body ? `# ${title}\n\n${body}` : `# ${title}`
}

/**
 * 无标题路径补标题（RV-001 真接线）。
 *
 * 纪律：
 * - 只在 `autoGenerateChapterTitle` 为真、有章号、且正文里没有「富标题」时才多跑一次 LLM；
 * - **任何失败都降级到「第N章」并原样交付正文**——标题是附加信息，绝不阻断正文生成；
 * - 纯包装：真正的 LLM 调用与清理逻辑仍在 `generateChapterTitle`，本函数不复制提示词。
 */
export async function ensureChapterTitle(
  content: string,
  options: EnsureChapterTitleOptions,
): Promise<EnsureChapterTitleResult> {
  const chapterNumber = options.chapterNumber
  if (!options.autoGenerateChapterTitle || !chapterNumber || chapterNumber <= 0) {
    return { content, title: "", source: "disabled" }
  }

  const existing = resolveChapterTitle(content)
  if (existing && isRichChapterTitle(existing)) {
    return { content, title: existing, source: "content" }
  }

  const generate = options.generateTitle ?? generateChapterTitle
  try {
    const generated = (await generate(content, chapterNumber, options.llmConfig, options.signal)).trim()
    if (!generated) throw new Error("标题生成返回空串")
    return { content: withTitleHeading(content, generated), title: generated, source: "generated" }
  } catch (error) {
    // 额外一次 LLM 调用失败（超时/中断/上游报错）→ 降级「第N章」，正文照常交付。
    const fallback = `第${chapterNumber}章`
    return {
      content: withTitleHeading(content, fallback),
      title: fallback,
      source: "fallback",
      error: toErrorMessage(error),
    }
  }
}
