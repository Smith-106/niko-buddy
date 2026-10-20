import { getCopyableAssistantContent } from "@/lib/chat-copy-content"
import { canContinueUnfinishedDeepChapter } from "@/lib/chat/resume"
import { convertLatexToUnicode } from "@/lib/latex-to-unicode"
import type { DisplayMessage } from "@/stores/chat-store"

export const TERMINAL_ASSISTANT_STATUS_RE = /^(?:已停止生成。?|出错[:：])/u
export const CHAPTER_DRAFT_HEADING_RE = /^\s*#?\s*(?:第\s*\d+\s*章[^\n]*|Chapter\s+\d+[^\n]*)/iu

// EC-02 (odyssey-ui): detect terminal error/stop status so the bubble can
// render with a destructive variant instead of looking like a normal reply.
export function isTerminalAssistantError(content: string): boolean {
  const visible = getCopyableAssistantContent(content).trim()
  return TERMINAL_ASSISTANT_STATUS_RE.test(visible)
}

export const MANAGED_DEEP_CHAPTER_DRAFT_RE = /<!--\s*niko-buddy-deep-chapter-draft:([\s\S]*?)\s*-->/i

export const MANAGED_CONTEXT_USAGE_RE = /<!--\s*niko-buddy-context-usage:([\s\S]*?)\s*-->/i

export type ManagedDeepChapterDraftStatus = "pending" | "ready" | "accepted" | "rejected" | "superseded"

export function getManagedDeepChapterDraftStatus(content: string): ManagedDeepChapterDraftStatus | null {
  const match = content.match(MANAGED_DEEP_CHAPTER_DRAFT_RE)
  if (!match?.[1]) return null
  try {
    const parsed = JSON.parse(decodeURIComponent(match[1])) as {
      conversationId?: unknown
      draftStatus?: unknown
    }
    if (
      typeof parsed?.conversationId === "string"
      && typeof parsed?.draftStatus === "string"
      && ["pending", "ready", "accepted", "rejected", "superseded"].includes(parsed.draftStatus)
    ) {
      return parsed.draftStatus as ManagedDeepChapterDraftStatus
    }
    return null
  } catch {
    return null
  }
}

/**
 * Wave 5 (v2.5.0): 解析 niko-buddy-context-usage 标记 → 上下文用量快照。
 * 缺省/损坏标记返回 null（不渲染 ring，优雅降级）。
 */
export function getContextUsageFromMessage(content: string): import("@/lib/context-usage").ContextUsage | null {
  const match = content.match(MANAGED_CONTEXT_USAGE_RE)
  if (!match?.[1]) return null
  try {
    const parsed = JSON.parse(decodeURIComponent(match[1])) as {
      memoryChars?: unknown
      retrievalChars?: unknown
      graphChars?: unknown
      bodyChars?: unknown
      otherChars?: unknown
      maxCtx?: unknown
    }
    if (
      typeof parsed?.memoryChars === "number"
      && typeof parsed?.retrievalChars === "number"
      && typeof parsed?.graphChars === "number"
      && typeof parsed?.bodyChars === "number"
      && typeof parsed?.otherChars === "number"
      && typeof parsed?.maxCtx === "number"
    ) {
      return {
        memoryChars: parsed.memoryChars,
        retrievalChars: parsed.retrievalChars,
        graphChars: parsed.graphChars,
        bodyChars: parsed.bodyChars,
        otherChars: parsed.otherChars,
        maxCtx: parsed.maxCtx,
      }
    }
    return null
  } catch {
    return null
  }
}

export function canOperateOnDeepChapterDraft(message: DisplayMessage): boolean {
  const draftStatus = getManagedDeepChapterDraftStatus(message.content)
  if (!draftStatus) return false
  const visibleContent = getCopyableAssistantContent(message.content).trim()
  if (!visibleContent) return false
  if (TERMINAL_ASSISTANT_STATUS_RE.test(visibleContent)) return false
  if (canContinueUnfinishedDeepChapter(message.content)) return false

  const heading = visibleContent.match(CHAPTER_DRAFT_HEADING_RE)?.[0]
  if (!heading) return false

  return visibleContent.slice(heading.length).trim().length >= 120
}

/**
 * 检测文本是否主要是LLM英文思考内容（应隐藏）
 * 特征：主要是英文，包含典型推理词汇，中文字符极少
 */
export function isLlmEnglishThinking(text: string): boolean {
  const trimmed = text.trim()
  /* v8 ignore next */
  if (!trimmed) return false

  // 统计中文字符数
  const chineseChars = (trimmed.match(/[\u4e00-\u9fff]/g) || []).length
  const totalChars = trimmed.length
  const chineseRatio = chineseChars / Math.max(totalChars, 1)

  // 如果中文字符占比超过15%，认为是中文内容（工作流信息），保留
  if (chineseRatio > 0.15) return false

  // 检测典型的LLM英文思考关键词
  const thinkingKeywords = [
    "thinking process",
    "let's think",
    "let me think",
    "analyze",
    "let's write",
    "wait,",
    "word count",
    "constraints",
    "note:",
    "check:",
    "strategy",
    "i need to",
    "i should",
    "first,",
    "okay,",
    "so,",
    "now,",
    "the user",
    "based on",
    "according to",
  ]
  const lower = trimmed.toLowerCase()
  const keywordCount = thinkingKeywords.filter((kw) => lower.includes(kw)).length

  // 如果包含2个以上思考关键词且中文很少，判定为LLM英文思考
  return keywordCount >= 2
}

/**
 * 检测一行是否是工作流阶段标题
 */
export function isWorkflowStageHeader(line: string): boolean {
  const trimmed = line.trim()
  // 匹配 ## 阶段X... 格式
  if (/^##\s*阶段/.test(trimmed)) return true
  // 匹配 "阶段X：" 或 "阶段X:" 开头的行（即使没有##）
  if (/^阶段\s*[\d.]+\s*[：:]/.test(trimmed)) return true
  return false
}

/**
 * 过滤思考块内容，保留中文工作流阶段信息，隐藏LLM英文思考
 */
export function filterThinkingContent(thinking: string): string | null {
  const lines = thinking.split("\n")
  const resultLines: string[] = []
  let currentStageHeader: string | null = null
  let currentStageContent: string[] = []

  const flushStage = () => {
    if (currentStageHeader) {
      resultLines.push(currentStageHeader)
      const contentText = currentStageContent.join("\n").trim()
      if (contentText) {
        // 检查内容是否是LLM英文思考
        if (!isLlmEnglishThinking(contentText)) {
          resultLines.push(...currentStageContent)
        }
      }
      resultLines.push("")
    } else if (currentStageContent.length > 0) {
      // 没有阶段标题的独立内容块
      const blockText = currentStageContent.join("\n").trim()
      if (blockText && !isLlmEnglishThinking(blockText)) {
        resultLines.push(...currentStageContent)
        resultLines.push("")
      }
    }
    currentStageHeader = null
    currentStageContent = []
  }

  for (const line of lines) {
    if (isWorkflowStageHeader(line)) {
      // 新的阶段开始，先flush之前的
      flushStage()
      currentStageHeader = line
    } else if (currentStageHeader) {
      // 当前正在收集阶段内容
      currentStageContent.push(line)
    } else {
      // 不在阶段内的内容，按段落处理
      currentStageContent.push(line)
      // 空行表示段落结束
      if (!line.trim()) {
        flushStage()
      }
    }
  }
  // flush最后一个阶段
  flushStage()

  const result = resultLines.join("\n").trim()
  return result || null
}

/**
 * Separate <think>...</think> blocks from the main answer.
 * Handles multiple think blocks and partial (unclosed) thinking during streaming.
 * 保留工作流阶段提示（中文），过滤LLM英文思考内容。
 */
export function separateThinking(text: string): { thinking: string | null; answer: string } {
  // Match complete <think>...</think> and <thinking>...</thinking> blocks
  const thinkRegex = /<think(?:ing)?>([\s\S]*?)<\/think(?:ing)?>/gi
  const thinkParts: string[] = []
  let answer = text

  let match: RegExpExecArray | null
  while ((match = thinkRegex.exec(text)) !== null) {
    thinkParts.push(match[1].trim())
  }
  answer = answer.replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, "").trim()

  // Handle unclosed <think> or <thinking> tag (streaming in progress)
  const unclosedMatch = answer.match(/<think(?:ing)?>([\s\S]*)$/i)
  if (unclosedMatch) {
    thinkParts.push(unclosedMatch[1].trim())
    answer = answer.replace(/<think(?:ing)?>[\s\S]*$/i, "").trim()
  }

  // 处理只有结尾 </think> 标签的情况（没有开头标签）
  const firstCloseIndex = answer.search(/<\/think(?:ing)?>/i)
  if (firstCloseIndex >= 0) {
    const beforeClose = answer.slice(0, firstCloseIndex)
    /* v8 ignore next */
    if (!/<think(?:ing)?>/i.test(beforeClose)) {
      const thinkingContent = beforeClose.trim()
      if (thinkingContent) {
        thinkParts.push(thinkingContent)
      }
      answer = answer.replace(/^[\s\S]*?<\/think(?:ing)?>\s*/i, "")
    }
  }

  const rawThinking = thinkParts.length > 0 ? thinkParts.join("\n\n") : null
  const filteredThinking = rawThinking ? filterThinkingContent(rawThinking) : null

  return { thinking: filteredThinking, answer: answer.trim() }
}

/**
 * Process content to create clickable links:
 * - [[wikilinks]] → markdown links with wikilink: protocol
 */
export function processContent(text: string): string {
  let result = text

  // Wrap bare \begin{...}...\end{...} blocks with $$ for remark-math
  result = result.replace(
    /(?<!\$\$\s*)(\\begin\{[^}]+\}[\s\S]*?\\end\{[^}]+\})(?!\s*\$\$)/g,
    (_match, block: string) => `$$\n${block}\n$$`,
  )

  // Only apply Unicode conversion to text outside of math delimiters
  // Split on $$...$$ and $...$ blocks, only convert non-math parts
  const parts = result.split(/(\$\$[\s\S]*?\$\$|\$[^$\n]+?\$)/g)
  result = parts
    .map((part) => {
      if (part.startsWith("$")) return part // preserve math
      return convertLatexToUnicode(part)
    })
    .join("")

  // Fix malformed wikilinks like [[name] (missing closing bracket)
  result = result.replace(/\[\[([^\]]+)\](?!\])/g, "[[$1]]")

  // Convert [[wikilinks]] to markdown links
  result = result.replace(
    /\[\[([^\]|]+?)(?:\|([^\]]+?))?\]\]/g,
    (_match, pageName: string, displayText?: string) => {
      const display = displayText?.trim() || pageName.trim()
      return `[${display}](wikilink:${pageName.trim()})`
    }
  )

  return result
}
