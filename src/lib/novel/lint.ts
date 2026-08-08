import { DEFAULT_LLM_REQUEST_TIMEOUT_MS, combineAbortSignals, streamChat, type StreamCallbacks } from "@/lib/llm-client"
import i18n from "@/i18n"
import type { ChatMessage } from "@/lib/llm-providers"
import { useWikiStore, type LlmConfig, type NovelConfig } from "@/stores/wiki-store"
import { getOutputLanguage, buildLanguageReminder } from "@/lib/output-language"
import { validateSeverity, logger } from "@/lib/utils"
import { contextPackToPrompt, buildContextPack, type ContextPack } from "./context-engine"
import { resolveNovelModel } from "./model-resolver"
import { hasUsableLlm } from "@/lib/has-usable-llm"
import { sliceChapterForReview } from "./chapter-window"

export interface NovelLintResult {
  severity: "error" | "warning" | "info"
  type: string
  message: string
  evidence: string
  relatedMemory: string
  suggestion: string
}

const NOVEL_LINT_DIMENSIONS = [
  "是否违背总大纲",
  "是否违背分卷大纲",
  "是否违背章节目标",
  "本章必须完成项是否已完成",
  "本章避免违背项是否存在违背",
  "下一章推进建议是否被忽略或反向推进",
  "是否人设崩坏",
  "是否人物动机不一致",
  "是否时间线错误",
  "是否地点错误",
  "是否能力体系崩坏",
  "是否伏笔遗忘",
  "是否提前泄露秘密",
  "是否角色知道了不该知道的信息",
  "是否新增未登记设定",
  "是否剧情水文",
  "是否缺少章节钩子",
]

export function buildNovelLintPrompt(pack: ContextPack, chapterContent: string): string {
  return `${contextPackToPrompt(pack)}

${i18n.t("novel.lint.lintInstruction", { defaultValue: "请对以下章节进行连贯性检查，逐一核对以下维度：" })}
${NOVEL_LINT_DIMENSIONS.map((key, i) => `${i + 1}. ${key}`).join("\n")}

${i18n.t("novel.lint.lintOutputFormat", { defaultValue: "请严格按照 JSON 数组格式输出检查结果。每个问题包含以下字段：severity（error/warning/info）、type（问题类型）、message（问题描述）、evidence（正文证据）、relatedMemory（相关记忆引用）、suggestion（修改建议）。如果没有发现问题，输出空数组 []。不要输出任何其他内容。" })}

${i18n.t("novel.lint.chapterContent", { defaultValue: "章节正文：" })}
${sliceChapterForReview(chapterContent)}`
}

export async function runNovelLint(
  projectPath: string,
  chapterContent: string,
  chapterNumber?: number,
  /**
   * ISS-20260709-023 (DC-7) 渐进式 DI: store 字段注入。缺省回退 useWikiStore
   * 保持向后兼容。
   */
  options: { llmConfig?: LlmConfig; novelConfig?: NovelConfig; novelMode?: boolean; /** ISS-20260724-004 (ROOT-C): optional caller signal for cascade-cancel */ signal?: AbortSignal } = {},
): Promise<NovelLintResult[]> {
  const llmConfig = resolveNovelModel(
    options.llmConfig ?? useWikiStore.getState().llmConfig,
    options.novelConfig ?? useWikiStore.getState().novelConfig,
    "lint",
  )
  if (!hasUsableLlm(llmConfig)) return []

  const novelMode = options.novelMode ?? useWikiStore.getState().novelMode
  if (!novelMode) return []

  const contextPack = await buildContextPack(
    projectPath,
    `连贯性检查第${chapterNumber || "?"}章`,
    chapterNumber,
  )

  const outputLang = getOutputLanguage()
  const langReminder = buildLanguageReminder(outputLang)

  const systemPrompt = `你是一个专业的小说连贯性检查编辑。你的任务是逐一检查章节是否存在连贯性、人设、时间线、伏笔等方面的问题。
请严格按照 JSON 数组格式输出检查结果，不要输出任何其他内容。
${langReminder}`

  const userPrompt = buildNovelLintPrompt(contextPack, chapterContent)

  try {
    const messages: ChatMessage[] = [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ]

    let result = ""
    const callbacks: StreamCallbacks = {
      onToken: (token: string) => {
        result += token
      },
      onDone: () => {},
      onError: (error: Error) => {
        logger.error("Novel Lint", "Stream error", { error: error instanceof Error ? error.message : String(error) })
      },
    }

    // ISS-20260724-004 (ROOT-C): merge caller signal with timeout to prevent orphaned LLM requests
    const lintSignal = options.signal
      ? combineAbortSignals(options.signal, AbortSignal.timeout(DEFAULT_LLM_REQUEST_TIMEOUT_MS))
      : AbortSignal.timeout(DEFAULT_LLM_REQUEST_TIMEOUT_MS)
    await streamChat(llmConfig, messages, callbacks, lintSignal)

    const jsonMatch = result.match(/\[[\s\S]*\]/)
    if (!jsonMatch) return []

    const parsed = JSON.parse(jsonMatch[0])
    if (!Array.isArray(parsed)) return []

    return parsed.map((item: Record<string, unknown>) => ({
      severity: validateSeverity(item.severity),
      type: String(item.type || "unknown"),
      message: String(item.message || ""),
      evidence: String(item.evidence || ""),
      relatedMemory: String(item.relatedMemory || ""),
      suggestion: String(item.suggestion || ""),
    }))
  } catch (err) {
    logger.error("Novel Lint", "Failed", { error: err instanceof Error ? err.message : String(err) })
    return []
  }
}
