import { streamChat, extractJsonArraySpan, type StreamCallbacks } from "@/lib/llm-client"
import i18n from "@/i18n"
import type { ChatMessage } from "@/lib/llm-providers"
import { useWikiStore, type LlmConfig, type NovelConfig } from "@/stores/wiki-store"
import { getOutputLanguage, buildLanguageReminder } from "@/lib/output-language"
import { validateSeverity, logger } from "@/lib/utils"
import { contextPackToPrompt, buildContextPack, type ContextPack } from "./context-engine"
import { buildCharacterAuraContext } from "./character-aura"
import { resolveNovelModel } from "./model-resolver"
import { slopScore, classifySlop, slopReportToText } from "./mechanical-slop-detector"
import { hasUsableLlm } from "@/lib/has-usable-llm"

export interface NovelReviewResult {
  severity: "error" | "warning" | "info"
  type: string
  message: string
  evidence: string
  relatedMemory: string
  suggestion: string
}

/**
 * F-003 (ISS-20260705-020): error class for malformed review JSON. The
 * 18-dim review path parses the model's final JSON array with an unguarded
 * JSON.parse — a truncated or code-fence-leaking response threw a bare
 * SyntaxError indistinguishable from a transport failure. Wrapping it lets
 * callers tell a parse failure (re-ask the model / surface "invalid JSON")
 * from a runtime/stream failure.
 */
export class ReviewParseError extends Error {
  readonly raw: string
  readonly parseMessage: string
  constructor(raw: string, parseMessage: string) {
    super(`Novel review JSON parse failed: ${parseMessage}`)
    this.name = "ReviewParseError"
    this.raw = raw
    this.parseMessage = parseMessage
  }
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}

export interface NovelReviewCallbacks {
  onThinking?: (content: string) => void
}

export interface ReviewChapterOptions extends NovelReviewCallbacks {
  /**
   * 复用调用方已构建好的上下文包，避免审稿内部重复 buildContextPack
   * （含一次重复的检索 / 向量 / 图谱计算）。深度章节生成会把阶段1建好的
   * contextPack 传进来。未提供时回退到内部自行构建。
   */
  contextPack?: ContextPack
  /**
   * 轻量审查模式：只审查角色一致性相关维度（人设、动机、记忆库、认知、秘密），
   * 用于返修后复审，降低 token 消耗。默认 false 走全量审查。
   */
  characterOnly?: boolean
  /**
   * ISS-20260709-023 (DC-7) 渐进式 DI: 可选 store 字段注入。传入时直接
   * 使用, 不再读 useWikiStore.getState()；缺省时回退到 store 保持向后兼容。
   * 逐步消除 lib 层对 useWikiStore 的直接耦合, 使函数可脱离 UI store 独立测试。
   */
  llmConfig?: LlmConfig
  novelConfig?: NovelConfig
  novelMode?: boolean
}

/** 角色一致性相关的审查维度，用于 characterOnly 轻量审查模式 */
const CHARACTER_REVIEW_DIMENSIONS = [
  "是否人设崩坏",
  "是否人物动机不一致",
  "是否角色脱离记忆库设定",
  "是否提前泄露秘密",
  "是否角色知道了不该知道的信息",
]

const REVIEW_DIMENSIONS = [
  "是否违背总大纲",
  "是否违背分卷大纲",
  "是否违背章节目标",
  "本章必须完成项是否已完成",
  "本章避免违背项是否存在违背",
  "下一章推进建议是否被忽略或反向推进",
  "是否人设崩坏",
  "是否人物动机不一致",
  "是否角色脱离记忆库设定",
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

const REVIEW_STAGES = [
  "阶段1：审查任务识别",
  "阶段2：上下文检索",
  "阶段3：章节目标对齐",
  "阶段4：事实与记忆核对",
  "阶段5：逐维度审查",
  "阶段6：阻断判定",
  "阶段7：二次复核",
]

const REVIEW_CHUNK_SIZE = 8000
const REVIEW_MAX_CHUNKS = 3
// F-4/PAT-G2: throttle thinking render flushes — only invoke when content grew
// by at least ONUPDATE_FLUSH_CHARS since the last push. Mirrors
// deep-chapter-generation.ts:162 ONUPDATE_FLUSH_CHARS to keep streaming O(n)
// instead of O(n²) per-token re-render. A final flush before return/error
// ensures the caller never sees a stale truncated view.
const REVIEW_ONUPDATE_FLUSH_CHARS = 256

/**
 * 把超长章节分段用于审查。章节 ≤ 8000 字时返回单段；
 * 超过时按 8000 字一段切分，最多 3 段（覆盖 24000 字）。
 *
 * ISS-20260711-001: 超出 24000 字的部分**截断**而非追加到最后一段。
 * 之前 `chunks[REVIEW_MAX_CHUNKS - 1] += content.slice(totalCovered)` 会让第 3 段
 * 膨胀到任意长度（超长 UAT 稿可达 25 万字 → 第 3 段 24 万字），LLM 在如此
 * 长的输入上要么 token 上限截断要么直接放弃 JSON 输出，导致 review chunk parse
 * 失败 → fix-loop 死循环 → watchdog paused。审查只需覆盖足够正文即可，丢掉
 * 远超 24000 字的尾部比让 LLM 输出崩成非 JSON 更安全。
 */
function splitChapterForReview(content: string): string[] {
  if (content.length <= REVIEW_CHUNK_SIZE) return [content]
  const chunks: string[] = []
  for (let i = 0; i < content.length && chunks.length < REVIEW_MAX_CHUNKS; i += REVIEW_CHUNK_SIZE) {
    chunks.push(content.slice(i, i + REVIEW_CHUNK_SIZE))
  }
  return chunks
}

export function buildReviewPrompt(pack: ContextPack, chapterContent: string, characterOnly = false): string {
  const dimensions = characterOnly ? CHARACTER_REVIEW_DIMENSIONS : REVIEW_DIMENSIONS
  const modeTitle = characterOnly ? "角色一致性专项审查" : "阶段式深度审查工作流"
  const modeStages = characterOnly
    ? ["阶段1：角色提取", "阶段2：记忆库对照", "阶段3：脱离判定", "阶段4：二次复核"]
    : REVIEW_STAGES
  return `${contextPackToPrompt(pack)}

${modeTitle}：
${modeStages.map((stage) => `- ${stage}：必须使用高级 thinking，先分析证据，再给结论。`).join("\n")}

${characterOnly ? "角色一致性专项审查要求：" : "阶段要求："}
${characterOnly
  ? [
      "1. 角色提取：从本章正文中提取所有出现的角色名（含别名、昵称），列出角色清单。",
      "2. 记忆库对照：逐个角色对照上下文中的角色光环/灵魂、人物状态、角色认知状态字段，标注命中状态。",
      "3. 脱离判定：角色行为若违背光环设定、人物状态、认知状态、大纲人物小传，视为脱离记忆库，按严重程度标为 error 或 warning。",
      "4. 二次复核：删除没有正文证据或没有记忆/大纲依据的主观评价，补上遗漏的阻断问题。",
    ].join("\n")
  : [
      "1. 审查任务识别：确认目标章节、章纲节点、正文范围、是否缺少必要上下文。",
      "2. 上下文检索：结合大纲、节点、上一章结尾、下一章建议、记忆库、人物信息、伏笔、时间线、角色认知状态。",
      "3. 章节目标对齐：判断正文是否完成本章必须推进项，是否偏离章纲或反向推进。",
      "4. 事实与记忆核对：逐项对照已登记设定、人物认知、伏笔状态、历史事件和相关检索结果。",
      "5. 逐维度审查：每个维度都必须有 pass 或 issue，不要只检查明显错误。",
      "6. 阻断判定：把会影响正式章节保存、后续生成、主线事实或人物一致性的问题标为 error。",
      "7. 二次复核：删除没有正文证据或没有记忆/大纲依据的主观评价，补上遗漏的阻断问题。",
    ].join("\n")}

${i18n.t("novel.reviewPrompt.reviewChapterInstruction")}
${dimensions.map((key, i) => `${i + 1}. ${i18n.t(key)}`).join("\n")}

${characterOnly ? "" : `${i18n.t("novel.reviewPrompt.specialChecksTitle")}
- ${i18n.t("novel.reviewPrompt.specialChecks.mustDo")}
- ${i18n.t("novel.reviewPrompt.specialChecks.mustAvoid")}
- ${i18n.t("novel.reviewPrompt.specialChecks.nextChapterAdvice")}

`}

角色命中记忆库检查（必须执行）：
1. 角色提取：先从本章正文中提取所有出现的角色名（含别名、昵称），列出角色清单。
2. 记忆库对照：逐个角色对照上下文中的"角色光环/灵魂"、"人物状态"、"角色认知状态"字段：
   - 标注该角色是否命中记忆库（已注入光环 / 仅有状态 / 完全缺失）。
   - 若角色已命中记忆库，检查正文行为是否符合光环设定（说话方式、心智模型、决策启发式、价值观反模式、诚实边界）。
   - 若角色未命中记忆库但在大纲/人物小传中存在，标注"未命中但应命中"。
3. 脱离判定：角色行为若违背光环设定、人物状态、认知状态（知道/不知道什么）、大纲人物小传，视为"脱离记忆库"，按严重程度标为 error 或 warning。
4. 输出要求：在审查 JSON 中，角色相关问题 type 使用 "character_consistency"，relatedMemory 必须引用对应的光环/状态/认知/大纲原文。

${i18n.t("novel.reviewPrompt.chapterContent")}
${chapterContent.slice(0, 8000)}

${i18n.t("novel.reviewPrompt.outputFormat")}
[
  {
    "severity": "error|warning|info",
    "type": "character_consistency|timeline|foreshadowing|setting|plot|style",
    "message": "问题描述",
    "evidence": "正文片段",
    "relatedMemory": "相关记忆引用",
    "suggestion": "修改建议"
  }
]

${i18n.t("novel.reviewPrompt.emptyArrayFallback")}`
}

export async function reviewChapter(
  projectPath: string,
  chapterContent: string,
  chapterNumber?: number,
  options: ReviewChapterOptions = {},
  signal?: AbortSignal,
): Promise<NovelReviewResult[]> {
  if (signal?.aborted) throw new Error("已停止生成")
  // ISS-20260709-023 (DC-7) 渐进式 DI: 注入优先, 缺省回退 store（向后兼容）
  const llmConfig = resolveNovelModel(
    options.llmConfig ?? useWikiStore.getState().llmConfig,
    options.novelConfig ?? useWikiStore.getState().novelConfig,
    "review",
  )
  if (!hasUsableLlm(llmConfig)) return []

  const novelMode = options.novelMode ?? useWikiStore.getState().novelMode
  if (!novelMode) return []

  // A19 机械层零 LLM 前置门控 (借鉴点 #1, PLN-20260716-mechanical-regex-audit):
  // LLM 审查前先跑机械 slopScore, penalty>=8 (block) 直接返回 anti_ai error 跳过
  // LLM 审查 (机械层先于语义层, 省 token + 防 LLM 自我纵容 slop)。slop 属 Anti-AI(P1),
  // 不覆盖 Consistency(P0) — 一致性仍由 LLM 审查维度管, 机械 slop 只管 AI 味。
  // 5-8 (warn) / <5 (clean) 暂不注入 LLM (最小侵入, detector 已暴露
  // slopReportToText 供未来 prompt 注入); >=8 阻断已覆盖最高 ROI 省流场景。
  const slopReport = slopScore(chapterContent)
  if (classifySlop(slopReport) === "block") {
    return [{
      severity: "error" as const,
      type: "anti_ai",
      message: `机械 slop 阻断: ${slopReportToText(slopReport)}`,
      evidence: `penalty ${slopReport.slopPenalty.toFixed(1)}/10 (机械正则检测, 零 LLM)`,
      relatedMemory: "",
      suggestion: "降低 AI 味: 删总结腔/解释腔, 打破机械句式, 具体化情绪替代概述",
    }]
  }

  // 复用调用方已构建的 contextPack；没有才自行构建。
  const baseContextPack = options.contextPack ?? await buildContextPack(
    projectPath,
    `审稿第${chapterNumber || "?"}章`,
    chapterNumber,
  )

  // 审查前用初稿正文重新匹配角色光环，补齐初稿中新出现的角色。
  // 阶段1构建 contextPack 时 matchingText 不含初稿正文，配角/新角色登场时光环不会被注入，
  // 这里把 chapterContent 加入 matchingText 重新匹配，确保审查阶段能看到初稿新角色的完整光环。
  let contextPack = baseContextPack
  try {
    const draftCharacterAuras = await buildCharacterAuraContext(projectPath, baseContextPack.task, {
      matchingText: [
        baseContextPack.chapterGoal,
        baseContextPack.outline,
        baseContextPack.characterStates,
        baseContextPack.cognitionStates,
        chapterContent,
      ].filter(Boolean).join("\n\n"),
    })
    if (draftCharacterAuras && draftCharacterAuras !== baseContextPack.characterAuras) {
      contextPack = { ...baseContextPack, characterAuras: draftCharacterAuras }
    }
  } catch (err) {
    // F-16 (CWE-532): message-only to avoid leaking provider request details.
    logger.error("Novel Review", "重新匹配角色光环失败，沿用阶段1的光环", { error: err instanceof Error ? err.message : String(err) })
  }

  if (signal?.aborted) throw new Error("已停止生成")
  const outputLang = getOutputLanguage()
  const langReminder = buildLanguageReminder(outputLang)
  // 审稿 reasoning 档位可配置（默认 high）；下调可省审稿推理 Token。
  // ISS-20260709-023 (DC-7) 渐进式 DI: 注入优先, 缺省回退 store。
  const reviewReasoningEffort = options.novelConfig?.reviewReasoningEffort ?? useWikiStore.getState().novelConfig.reviewReasoningEffort ?? "high"

  const systemPrompt = `你是一个专业的小说审稿编辑。你的任务是检查章节内容是否存在连贯性问题。
请在一次回复里先完成分阶段审查分析，再在最后只输出最终审查 JSON 数组，JSON 之外不要有多余内容。
${langReminder}`

  // 章节超长时分段审查，合并所有段的审查结果
  const chunks = splitChapterForReview(chapterContent)
  const stageThinking = new Map<string, string>()

  try {
    // 并行审查所有分段，缩短超长章节审查时延
    const chunkResults = await Promise.all(chunks.map(async (chunk, i) => {
      if (signal?.aborted) throw new Error("已停止生成")
      const chunkContent = chunks.length > 1
        ? `【第${i + 1}段/共${chunks.length}段】\n${chunk}`
        : chunk
      const userPrompt = buildReviewPrompt(contextPack, chunkContent, options.characterOnly)
      const stageTitle = chunks.length > 1
        ? (options.characterOnly ? `角色一致性审查（第${i + 1}/${chunks.length}段）` : `深度审查（第${i + 1}/${chunks.length}段）`)
        : (options.characterOnly ? "角色一致性审查" : "深度审查")

      const parsed = await runReviewStage(
        llmConfig,
        systemPrompt,
        [
          userPrompt,
          "",
          "请在同一次回复中依次完成阶段1-7和上方全部审查维度：",
          "- 先逐阶段、逐维度列出已核对依据与结论（每个维度给出 pass 或 issue）。",
          "- 再做阶段7二次复核：删除没有正文证据或没有上下文 / 记忆 / 大纲依据的主观评价，补上遗漏的阻断问题。",
          "",
          "最终审查 JSON：",
          "在完成上述全部分析之后，最后只输出最终 JSON 数组，不要输出解释、标题或 markdown。",
        ].join("\n"),
        stageTitle,
        options,
        stageThinking,
        signal,
        reviewReasoningEffort,
        0,
        i,
      )

      // ISS-20260711-001: parse now happens inside runReviewStage (with retry),
      // so `parsed` is already a raw findings array. `ReviewParseError`
      // (F-003) still propagates from a SyntaxError after retries exhaust.
      return (parsed as Record<string, unknown>[]).map((item) => ({
        severity: validateSeverity(item.severity),
        type: String(item.type || "unknown"),
        message: String(item.message || ""),
        evidence: String(item.evidence || ""),
        relatedMemory: String(item.relatedMemory || ""),
        suggestion: String(item.suggestion || ""),
      }))
    }))

    return chunkResults.flat()
  } catch (err) {
    // F-16 (CWE-532): message-only; the full error is still propagated via
    // toError(err) for the caller, so the stderr log only needs the message.
    logger.error("Novel Review", "Failed", { error: err instanceof Error ? err.message : String(err) })
    throw toError(err)
  }
}

/**
 * Parse a single review-chunk LLM response into a raw findings array.
 *
 * ISS-20260711-001 (PAT-G2 twin recurrence #9): previously `extractJsonArray`
 * returned null on a non-JSON response (token-truncated / format-drifted
 * output) and the caller threw immediately with zero retry. The throw
 * happened *after* `runReviewStage` returned, so its streamError-only retry
 * never covered a parse/null-JSON failure — a single malformed chunk drove
 * the whole review (and thus the fix-loop) into watchdog `paused`. Hoisting
 * the parse here lets `runReviewStage` treat a null-JSON / parse failure the
 * same as a stream failure and re-ask the model.
 *
 * `ReviewParseError` (F-003 / ISS-20260705-020) is still thrown for
 * `SyntaxError` so callers keep distinguishing malformed-JSON from
 * runtime failures.
 */
function parseReviewChunkResult(result: string, chunkIndex: number): unknown[] {
  const jsonMatch = extractJsonArray(result)
  if (!jsonMatch) {
    throw new Error(
      `[Novel Review] Chunk ${chunkIndex + 1} did not return a JSON array. Output preview: ${result.slice(0, 200)}`,
    )
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(jsonMatch)
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new ReviewParseError(jsonMatch, error.message)
    }
    throw error
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`[Novel Review] Chunk ${chunkIndex + 1} returned a non-array JSON payload.`)
  }
  return parsed
}

/**
 * 从单次审稿回复里取出最终 JSON 数组 span。优先取“最后一个”完整数组：
 * 单次调用里模型可能先输出分析文字再给 JSON，贪婪匹配第一个 `[` 到最后一个
 * `]` 容易把分析里的方括号一起吞掉，这里从末尾的 `]` 向前找配平的 `[`。
 *
 * 实现已提升到 @/lib/llm-client extractJsonArraySpan（PAT-G2 same-name dedup，
 * 与 character-llm-recognizer / scene-breakdown 共享）。
 */
function extractJsonArray(text: string): string | null {
  return extractJsonArraySpan(text)
}

async function runReviewStage(
  llmConfig: ReturnType<typeof resolveNovelModel>,
  systemPrompt: string,
  userPrompt: string,
  stageTitle: string,
  callbacks: NovelReviewCallbacks,
  stageThinking: Map<string, string>,
  signal?: AbortSignal,
  reasoningMode: "low" | "medium" | "high" = "high",
  retryCount = 0,
  chunkIndex = 0,
): Promise<unknown[]> {
  publishReviewStageThinking(stageThinking, callbacks, stageTitle, "正在分析...")
  const messages: ChatMessage[] = [
    { role: "system", content: systemPrompt },
    { role: "user", content: userPrompt },
  ]

  let result = ""
  let reasoning = ""
  let streamError: Error | null = null
  // F-4/PAT-G2: track last pushed combined length to throttle renderThinking.
  let lastPushedLen = 0
  const renderThinking = (force = false) => {
    const combined = reasoning
      ? `${reasoning}${result ? `\n\n${result}` : ""}`
      : result
    if (!force && combined.length - lastPushedLen < REVIEW_ONUPDATE_FLUSH_CHARS) return
    lastPushedLen = combined.length
    publishReviewStageThinking(stageThinking, callbacks, stageTitle, combined || "正在分析...")
  }
  const streamCallbacks: StreamCallbacks = {
    onToken: (token: string) => {
      result += token
      renderThinking()
    },
    // 审稿模型多为推理模型，分阶段分析走 reasoning 通道：捕获后用于 thinking 展示，
    // 但不计入 result，最终 JSON 只从 content（result）解析，避免分析文字污染 JSON。
    onReasoningToken: (token: string) => {
      reasoning += token
      renderThinking()
    },
    onDone: () => {},
    onError: (error: Error) => {
      // F-16 (CWE-532): message-only to avoid leaking provider request details.
      logger.error("Novel Review", "Stream error", { error: error instanceof Error ? error.message : String(error) })
      streamError = error
    },
  }

  const timeoutController = new AbortController()
  const timeoutId = setTimeout(() => timeoutController.abort(), 300000)

  const combinedSignal = signal
    ? combineSignals(signal, timeoutController.signal)
    : timeoutController.signal

  try {
    await streamChat(
      llmConfig,
      messages,
      streamCallbacks,
      combinedSignal,
      { reasoning: { mode: reasoningMode } },
    )
    clearTimeout(timeoutId)
    // F-4/PAT-G2: final flush so the caller's last thinking view reflects the
    // full content, not a throttle-stale truncated view.
    renderThinking(true)
    if (streamError) throw streamError

    // ISS-20260711-001: parse inside the try so a null-JSON / malformed-JSON
    // response retries via the same path as a stream failure (re-ask the
    // model up to 2×). Previously this parse lived in the caller *after*
    // runReviewStage returned, so parse failures had zero retry.
    const parsed = parseReviewChunkResult(result.trim(), chunkIndex)
    if (signal?.aborted) throw new Error("已停止生成")
    return parsed
  } catch (err) {
    clearTimeout(timeoutId)
    if (signal?.aborted) throw new Error("已停止生成")
    if (retryCount < 2) {
      logger.warn("Novel Review", `Stage "${stageTitle}" failed, retrying`, { retry: `${retryCount + 1}/2` })
      publishReviewStageThinking(stageThinking, callbacks, stageTitle, "网络波动，正在重试...")
      await new Promise(resolve => setTimeout(resolve, 2000))
      return runReviewStage(llmConfig, systemPrompt, userPrompt, stageTitle, callbacks, stageThinking, signal, reasoningMode, retryCount + 1, chunkIndex)
    }
    throw err
  }

  if (signal?.aborted) throw new Error("已停止生成")
}

function combineSignals(signalA: AbortSignal, signalB: AbortSignal): AbortSignal {
  const controller = new AbortController()
  const abort = () => controller.abort()
  for (const signal of [signalA, signalB]) {
    // 信号在组合前就已经中止时（例如用户在审稿开始前点了停止），
    // addEventListener 不会再触发，必须立即同步中止组合信号。
    if (signal.aborted) {
      controller.abort()
      return controller.signal
    }
    signal.addEventListener("abort", abort, { once: true })
  }
  return controller.signal
}

function publishReviewStageThinking(
  stageThinking: Map<string, string>,
  callbacks: NovelReviewCallbacks,
  stageTitle: string,
  content: string,
): void {
  stageThinking.set(stageTitle, formatReviewStageThinking(stageTitle, content))
  callbacks.onThinking?.(Array.from(stageThinking.values()).join("\n\n"))
}

function formatReviewStageThinking(stageTitle: string, content: string): string {
  return `## ${stageTitle}\n${content.trim()}`
}
