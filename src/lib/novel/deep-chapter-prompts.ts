import type { NovelReviewResult } from "./review-adapter"
import { PER_MESSAGE_TOKEN_OVERHEAD, estimateTokens } from "@/lib/token-estimator"
import { buildGoldenThreeChapterDirective, type GoldenThreeChapterRequest } from "./golden-three-chapters"
import { CHINESE_NOVEL_DE_AI_RULES, buildStructuredDeAiRules } from "./de-ai-rules"
import { buildUserAwareDeAiPrompt, hasUserDeAiWeights } from "@/lib/user-memory/rules-weight"
import type { UserMemoryStore } from "@/lib/user-memory/types"

export const DEEP_CHAPTER_TARGET_CHARS = 3000
export const DEEP_CHAPTER_MIN_CHARS = 2200
export const DEEP_CHAPTER_DRAFT_MAX_CHARS = 3500
export const DEEP_CHAPTER_MAX_OUTPUT_TOKENS = 12000

/**
 * RV-04：章节计划原文的字符上限（按 Unicode **码点** 计，emoji 记 1 字）。
 *
 * 与 `run-chapter-workflow.ts` 的来源校验共用同一上限（20000）——来源侧与
 * 消费侧不能各说一套，否则一边截断、另一边仍把超长文本原样塞进提示词。
 *
 * 为什么必须有上限：阶段2/阶段3 都是**单条 user 消息**，`llm-client` 的
 * input-limit 重试靠 `trimChatMessagesToBudget` 裁剪，而该裁剪器 Pass1/2/3
 * 一律跳过最后一条消息（`canDrop` 排除 last）→ 对单条消息提示词是 no-op，
 * body 不变即 `onError`。阶段2/3 没有 try/catch，于是整次生成硬失败、无降级。
 * 所以计划必须在进入提示词之前就有界。
 */
export const PLAN_BLUEPRINT_MAX_CHARS = 20_000

/** 阶段提示词前置预估的安全比例（与 llm-client input-limit 重试的 0.85 同口径）。 */
export const STAGE_PROMPT_SAFETY_RATIO = 0.85

/**
 * 阶段提示词固定脚手架（阶段标记 + 硬性要求 + 输出协议等）的 token 估算。
 *
 * 这些文本不在 `fitStagePromptToWindow` 的入参里（它们在 builder 内部），但确实进
 * 请求体；不估就会系统性低估约 1500–2000 中文 token。
 */
export const STAGE_PROMPT_SCAFFOLD_TOKENS = 2000

/** 上下文压缩标记的字符预留（标记本身也占 token，不能算漏）。 */
const CONTEXT_COMPRESSION_MARKER_RESERVE_CHARS = 80

/** 计划截断标记的字符预留（标题行 + 完整性声明）。 */
const PLAN_TRUNCATION_MARKER_RESERVE_CHARS = 160

/** 章节生成字数规格：由设置中的“单章目标字数”推算（issue #8）。 */
export interface ChapterLengthSpec {
  targetChars: number
  minChars: number
  draftMaxChars: number
  maxOutputTokens: number
}

export const DEFAULT_CHAPTER_LENGTH_SPEC: ChapterLengthSpec = {
  targetChars: DEEP_CHAPTER_TARGET_CHARS,
  minChars: DEEP_CHAPTER_MIN_CHARS,
  draftMaxChars: DEEP_CHAPTER_DRAFT_MAX_CHARS,
  maxOutputTokens: DEEP_CHAPTER_MAX_OUTPUT_TOKENS,
}

export function resolveChapterLengthSpec(targetChars?: number): ChapterLengthSpec {
  const target = Number.isFinite(targetChars) && (targetChars as number) > 0
    ? Math.max(500, Math.min(20000, Math.round(targetChars as number)))
    : DEEP_CHAPTER_TARGET_CHARS
  if (target === DEEP_CHAPTER_TARGET_CHARS) return DEFAULT_CHAPTER_LENGTH_SPEC
  return {
    targetChars: target,
    // 与默认 2200/3000 保持同一比例，最低不少于 300 字
    minChars: Math.max(300, Math.round(target * (DEEP_CHAPTER_MIN_CHARS / DEEP_CHAPTER_TARGET_CHARS))),
    draftMaxChars: target + (DEEP_CHAPTER_DRAFT_MAX_CHARS - DEEP_CHAPTER_TARGET_CHARS),
    // 中文正文约 1-2 token/字，给草稿上限留足输出空间
    maxOutputTokens: Math.max(DEEP_CHAPTER_MAX_OUTPUT_TOKENS, Math.ceil((target + 500) * 2)),
  }
}

function chapterLengthBoundary(lengthSpec: ChapterLengthSpec): string {
  return `目标约 ${lengthSpec.targetChars} 字；低于 ${lengthSpec.minChars} 字视为正文初稿未完成。`
}

/**
 * 跨阶段稳定上下文前缀：把“完整大纲 + 上下文包”放在每个阶段提示词的最前面，
 * 且在同一次章节生成里逐字节相同。
 *
 * 任务书 / 初稿 / 扩写 / 返修 / 去AI味这几个阶段都由同一份 outline + contextPrompt
 * 拼出相同前缀，DeepSeek / OpenAI 的自动前缀缓存即可命中这段最大的内容，
 * 重复阶段按命中价计费（约 1/10），不再每阶段全价重发整段上下文。
 *
 * 因此阶段专属指令、写作任务书、初稿正文、审稿问题等“会变的内容”必须排在这段
 * 前缀之后，不能插到前面，否则会把公共前缀截断、缓存失效。
 */
export function buildStableContextPrefix(outline: string, contextPrompt: string): string {
  return [
    outline,
    "上下文：",
    contextPrompt,
  ].filter(Boolean).join("\n")
}

/**
 * 任务级自定义追加段（task customization）：extra 为空/空白时原样返回（字节等价），
 * 非空时在 prompt 尾部追加【任务自定义要求】段。
 */
export function appendTaskExtraSection(prompt: string, extraInstructions?: string): string {
  const trimmed = extraInstructions?.trim()
  if (!trimmed) return prompt
  return [
    prompt,
    "",
    "# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
    "# 【任务自定义要求】（用户配置，优先级高于风格建议，不得违背硬性输出协议）",
    "# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
    "",
    trimmed,
  ].join("\n")
}

/**
 * Unicode 码点计数（代理对记 1 个字）。
 *
 * 「N 字」对外必须按用户眼里的字计：一个 emoji 是 1 字，不是 2 个 UTF-16 码元。
 */
export function countCodePoints(text: string): number {
  if (!text) return 0
  let count = 0
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index)
    // 低代理：与前一位高代理合成一个码点，不重复计数。
    if (code >= 0xdc00 && code <= 0xdfff && index > 0) {
      const prev = text.charCodeAt(index - 1)
      if (prev >= 0xd800 && prev <= 0xdbff) continue
    }
    count += 1
  }
  return count
}

/**
 * 按码点安全截断：**绝不切坏代理对**（emoji 等补充平面字符）。
 *
 * 朴素的 `text.slice(0, n)` 可能把 U+1F600（`\uD83D\uDE00`）切成孤立高代理，
 * 这类字符串进 JSON/SSE 后是非法码点序列，上游可能直接 400，或在下游渲染成乱码。
 * 因此截断点落在代理对中间时整体丢弃该字符（宁可少 1 字，不产出半个字符）。
 */
export function truncateToCodePoints(text: string, maxCodePoints: number): string {
  if (!text) return ""
  if (!Number.isFinite(maxCodePoints)) return text
  const limit = Math.floor(maxCodePoints)
  if (limit <= 0) return ""
  // 快路径：码点数 ≤ UTF-16 长度，长度已不超限时必然无需截断。
  if (text.length <= limit) return text
  let index = 0
  let count = 0
  while (index < text.length && count < limit) {
    const code = text.charCodeAt(index)
    const isHighSurrogate = code >= 0xd800 && code <= 0xdbff
    const nextCode = index + 1 < text.length ? text.charCodeAt(index + 1) : 0
    const isSurrogatePair = isHighSurrogate && nextCode >= 0xdc00 && nextCode <= 0xdfff
    index += isSurrogatePair ? 2 : 1
    count += 1
  }
  return text.slice(0, index)
}

/**
 * F07（R04=a）+ RV-04：用户已确认的章节计划原文段。
 *
 * 计划是用户在会话层确认过的强制约束，**未超限时必须原样透传**：不做 trim/改写
 * （仅用 trim 判定“是否为空”），输出内嵌原文逐字节不变。
 *
 * RV-04 截断语义分层（这是本函数的核心）：
 *   - 未截断 → 保留原有的「必须原样执行，不得改写、合并或省略」强约束口径；
 *   - 已截断 → 标题行改为「已截断：原文 N 字，此处保留前 M 字；完整计划请查看计划面板」，
 *     并追加【计划完整性声明】把权威口径降级为「以下为计划前段，其余部分未包含；
 *     请勿据此推断未给出的内容」。
 * 绝不能让残缺文本继续挂着「必须原样执行」的权威口径——那会让模型把 2 万字之后的
 * 节拍当作「不存在」，或反过来自行脑补后当成已确认计划执行。
 *
 * 位置约束：调用方必须把它拼在 `buildStableContextPrefix` 之后 —— 计划逐章变化，
 * 若插到稳定前缀之前会截断各阶段共享的缓存前缀（见 buildStableContextPrefix 注释）。
 * 缺省/空白 → 返回 ""，由调用方的 filter(Boolean) 剔除（字节级零行为变更）。
 *
 * @param maxChars 保留的计划字符上限（码点计）。缺省 `PLAN_BLUEPRINT_MAX_CHARS`；
 *   阶段入口前置预估（`fitStagePromptToWindow`）超窗时会传更小的值二次压缩。
 */
export function planBlueprintSection(
  planBlueprint?: string,
  maxChars: number = PLAN_BLUEPRINT_MAX_CHARS,
): string {
  if (!planBlueprint || !planBlueprint.trim()) return ""
  // 显式 0 = 整段省略（窗口连计划都装不下）；非数字/负数/NaN 才回退到上限默认值。
  const limit = typeof maxChars === "number" && Number.isFinite(maxChars) && maxChars >= 0
    ? Math.floor(maxChars)
    : PLAN_BLUEPRINT_MAX_CHARS
  if (limit === 0) return ""
  const originalChars = countCodePoints(planBlueprint)
  if (originalChars <= limit) {
    // 未截断：逐字节保留既有强约束口径（F07 原行为不变）。
    return [
      "# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
      "# 【章节计划原文】（用户已确认的强制约束；必须原样执行，不得改写、合并或省略）",
      "# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
      "",
      planBlueprint,
      "# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
    ].join("\n")
  }
  // 已截断：标题行给出可核对的截断事实 + 指向完整计划，正文前降级权威口径。
  const keptBody = truncateToCodePoints(planBlueprint, limit)
  return [
    "# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
    `# 【章节计划原文】（已截断：原文 ${originalChars} 字，此处保留前 ${limit} 字；完整计划请查看计划面板）`,
    "# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
    "",
    "# 【计划完整性声明】以下为计划前段，其余部分未包含；请勿据此推断未给出的内容，也不要自行补写计划未覆盖的节拍。",
    "",
    keptBody,
    "# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
  ].join("\n")
}

/** `fitStagePromptToWindow` 的输入。 */
export interface StagePromptBudgetInput {
  /** 模型上下文窗口（token）。缺省/非正数 → 不预估（零行为变更）。 */
  windowTokens?: number
  /** 输出预留 token（阶段 max_tokens / 阶段输出预算）。 */
  reservedOutputTokens?: number
  /** 稳定前缀里的大纲段（硬约束，**不压缩**，但计入估算）。 */
  outlinePrompt: string
  /** 可再生的检索上下文（超窗时**第一个**被压）。 */
  contextPrompt: string
  /** 用户确认的章节计划原文（超窗时**第二个**被压）。 */
  planBlueprint?: string
  /** 已产出的任务书（阶段3 才有；计入估算，不压缩——它是本阶段要执行的工件）。 */
  taskBrief?: string
  /** 计划字符上限覆盖（缺省 `PLAN_BLUEPRINT_MAX_CHARS`）。 */
  planMaxChars?: number
  /** 安全比例覆盖（缺省 `STAGE_PROMPT_SAFETY_RATIO`）。 */
  safetyRatio?: number
}

/** `fitStagePromptToWindow` 的输出：可直接喂给各阶段 prompt builder。 */
export interface StagePromptBudgetOutcome {
  /** 实际应使用的上下文（未压缩时与入参逐字节相同）。 */
  contextPrompt: string
  /** 计划原文（**不在这里截断**：截断与标记统一由 `planBlueprintSection` 按 `planMaxChars` 做）。 */
  planBlueprint?: string
  /** 计划的实际字符上限（预算二次压缩后可能小于 `PLAN_BLUEPRINT_MAX_CHARS`）。 */
  planMaxChars: number
  /** 压缩后的输入 token 估算。 */
  estimatedTokens: number
  /** 允许的输入 token 预算（窗口 × 安全比例 − 输出预留）。 */
  budgetTokens: number
  contextCompressed: boolean
  planCompressed: boolean
  /** contextPrompt 被压掉的字符数（码点）。 */
  droppedContextChars: number
  /** 计划被压掉的字符数（码点，含 20000 上限截断）。 */
  droppedPlanChars: number
  /** 给 onThinking / 活动事件的人话说明（未压缩时为空数组）。 */
  notes: string[]
}

/**
 * RV-04：阶段入口的前置预算预估。
 *
 * 为什么需要前置：`llm-client` 的 input-limit 重试对**单条 user 消息**无效
 * （`trimChatMessagesToBudget` 永不裁最后一条），重试 body 与首次相同 → 直接
 * `onError`；阶段2/3 无 try/catch → 整次生成硬失败。所以必须在**发请求之前**
 * 把输入压到窗口内，且压缩顺序固定：
 *   ① 先压 `contextPrompt`（检索上下文可再生，压掉只损失召回）；
 *   ② 再压 `planBlueprint`（用户确认的约束，压掉会损失权威性 → 必须降级口径）；
 *   ③ 大纲与任务书不压（硬约束 / 已产出工件），仍超窗则如实上报。
 *
 * 纯函数：不读 store、不发请求、不写日志；压缩量由文本自身的 tokens/char 比率
 * 推导（CJK ≈ 1 token/字，英文 ≈ 0.25），不用固定常量猜。
 * 未超窗时返回逐字节相同的入参（零行为变更）。
 */
export function fitStagePromptToWindow(input: StagePromptBudgetInput): StagePromptBudgetOutcome {
  const planMaxCharsDefault = typeof input.planMaxChars === "number" && Number.isFinite(input.planMaxChars) && input.planMaxChars > 0
    ? Math.floor(input.planMaxChars)
    : PLAN_BLUEPRINT_MAX_CHARS
  const rawPlan = input.planBlueprint && input.planBlueprint.trim() ? input.planBlueprint : undefined
  let planMaxChars = planMaxCharsDefault
  // 估算口径用「已按上限截断后的计划」：否则 25000 字的计划会被按 25000 字估窗，
  // 白白触发一次 contextPrompt 压缩，而实际发出去的只有前 20000 字。
  let planForEstimate = rawPlan ? truncateToCodePoints(rawPlan, planMaxChars) : undefined

  let nextContext = input.contextPrompt ?? ""
  const outlinePrompt = input.outlinePrompt ?? ""
  const taskBrief = input.taskBrief ?? ""
  const totalTokensNow = (): number =>
    estimateTokens(outlinePrompt)
    + estimateTokens(nextContext)
    + estimateTokens(planForEstimate ?? "")
    + estimateTokens(taskBrief)
    + STAGE_PROMPT_SCAFFOLD_TOKENS
    + PER_MESSAGE_TOKEN_OVERHEAD

  const estimatedTokens = totalTokensNow()
  const notes: string[] = []
  const rawPlanChars = rawPlan ? countCodePoints(rawPlan) : 0
  // 20000 上限本身的截断也要如实上报（即使窗口完全够用）。
  if (rawPlan && rawPlanChars > planMaxChars) {
    notes.push(`章节计划原文 ${rawPlanChars} 字超过上限 ${planMaxChars} 字，已截断并降级为「计划前段」口径（完整计划请查看计划面板）。`)
  }

  const windowTokens = typeof input.windowTokens === "number" && Number.isFinite(input.windowTokens) && input.windowTokens > 0
    ? input.windowTokens
    : 0
  const base = (): StagePromptBudgetOutcome => ({
    contextPrompt: input.contextPrompt,
    planBlueprint: rawPlan,
    planMaxChars,
    estimatedTokens,
    budgetTokens: 0,
    contextCompressed: false,
    planCompressed: false,
    droppedContextChars: 0,
    droppedPlanChars: 0,
    notes: [...notes],
  })
  // 无窗口信息（缺省 / 非正数）→ 不预估，行为与改前逐字节一致。
  if (windowTokens === 0) return base()

  const safetyRatio = typeof input.safetyRatio === "number" && input.safetyRatio > 0 && input.safetyRatio <= 1
    ? input.safetyRatio
    : STAGE_PROMPT_SAFETY_RATIO
  const reservedOutputTokens = typeof input.reservedOutputTokens === "number" && Number.isFinite(input.reservedOutputTokens) && input.reservedOutputTokens > 0
    ? Math.floor(input.reservedOutputTokens)
    : 0
  const budgetTokens = Math.floor(windowTokens * safetyRatio) - reservedOutputTokens
  if (budgetTokens <= 0) {
    // 窗口比输出预留还小：压到 0 字只会把提示词变成空串，那比上游报错更难诊断。
    notes.push(`窗口 ${windowTokens} tok 扣掉输出预留 ${reservedOutputTokens} tok 后已无输入预算，未做压缩（交由上游报错，避免把提示词压成空串）。`)
    return { ...base(), budgetTokens }
  }
  if (estimatedTokens <= budgetTokens) return { ...base(), budgetTokens }

  let remaining = estimatedTokens - budgetTokens
  let droppedContextChars = 0
  let droppedPlanChars = 0

  // ① 先压 contextPrompt。
  if (remaining > 0 && nextContext.length > 0) {
    const contextTokens = estimateTokens(nextContext)
    if (contextTokens > 0) {
      const charsPerToken = nextContext.length / contextTokens
      const cutChars = Math.ceil(remaining * charsPerToken) + CONTEXT_COMPRESSION_MARKER_RESERVE_CHARS
      const contextChars = countCodePoints(nextContext)
      const kept = truncateToCodePoints(nextContext, contextChars - cutChars)
      if (kept.length < nextContext.length) {
        droppedContextChars = contextChars - countCodePoints(kept)
        nextContext = `${kept}\n\n【上下文已按窗口预算压缩：省略后段 ${droppedContextChars} 字（原文 ${contextChars} 字）】`
        remaining = totalTokensNow() - budgetTokens
        notes.push(`上下文包超出窗口预算：已先压缩 contextPrompt，省略后段 ${droppedContextChars} 字（原文 ${contextChars} 字）。`)
      }
    }
  }

  // ② 再压计划（contextPrompt 已经压到 0 字还不够时才动计划）。
  if (remaining > 0 && planForEstimate) {
    const planTokens = estimateTokens(planForEstimate)
    if (planTokens > 0) {
      const charsPerToken = planForEstimate.length / planTokens
      const cutChars = Math.ceil(remaining * charsPerToken) + PLAN_TRUNCATION_MARKER_RESERVE_CHARS
      const planChars = countCodePoints(planForEstimate)
      const kept = truncateToCodePoints(planForEstimate, planChars - cutChars)
      if (kept.length < planForEstimate.length) {
        // 相对**原文**计省略量（kept 永远是 rawPlan 的前缀；若 20000 上限已生效，
        // 只看 planChars 会把上限那部分漏掉，导致对外数字偏小）。
        droppedPlanChars = rawPlanChars - countCodePoints(kept)
        planForEstimate = kept
        planMaxChars = Math.min(planMaxChars, countCodePoints(kept))
        remaining = totalTokensNow() - budgetTokens
        notes.push(planMaxChars > 0
          ? `压缩上下文后仍超窗：已再压缩章节计划，仅保留前 ${planMaxChars} 字（原文 ${rawPlanChars} 字，省略 ${droppedPlanChars} 字），口径已降级为「计划前段」。`
          : `压缩上下文后仍超窗：章节计划已整段省略（原文 ${rawPlanChars} 字），本阶段不再携带计划原文。`)
      }
    }
  }

  // ③ 大纲/任务书不压：仍超窗就如实说明，不假装成功。
  if (remaining > 0) {
    notes.push(`压缩 contextPrompt 与计划后仍超窗约 ${remaining} tok（大纲与任务书不压缩）：已按最保守口径发送；若上游仍拒绝，请调大上下文窗口或降低单章目标字数。`)
  }

  return {
    contextPrompt: nextContext,
    planBlueprint: rawPlan,
    planMaxChars,
    estimatedTokens: totalTokensNow(),
    budgetTokens,
    contextCompressed: droppedContextChars > 0,
    planCompressed: droppedPlanChars > 0,
    droppedContextChars,
    droppedPlanChars,
    notes,
  }
}

export function buildDeepChapterBriefPrompt(
  outline: string,
  contextPrompt: string,
  userRequest: string,
  chapterNumber?: number,
  goldenThreeChapter?: GoldenThreeChapterRequest,
  lengthSpec: ChapterLengthSpec = DEFAULT_CHAPTER_LENGTH_SPEC,
  extraInstructions?: string,
  /**
   * F07: 用户已确认的章节计划原文（可选，additive）。缺省 undefined → prompt 逐字节不变。
   * 任务书是“计划作为权威依据”的落地阶段，故计划原文同样进入阶段2提示词。
   */
  planBlueprint?: string,
  /**
   * RV-04: 计划字符上限（码点计）。缺省 `PLAN_BLUEPRINT_MAX_CHARS`；阶段入口前置预估
   * 超窗时会传更小的值（`fitStagePromptToWindow().planMaxChars`）。
   */
  planMaxChars: number = PLAN_BLUEPRINT_MAX_CHARS,
): string {
  return appendTaskExtraSection([
    buildStableContextPrefix(outline, contextPrompt),
    "[TASK_BRIEF_MARKER]",
    "",
    "你是小说写作任务规划助手。",
    "请基于上述上下文输出一份写作任务书，供后续创作使用。",
    "",
    "硬性要求：",
    "1. 只输出任务书，不要写故事片段。",
    "2. 必须列出本章必须完成、禁止违背、角色状态、伏笔推进、结尾钩子。",
    "3. 章节契约 machine-readable 段（必须原样输出，供写后核对自动解析）：用【章节契约】行开头，随后逐行输出——必须节拍：… / 禁区：… / 连贯核对：…，方向提示行（情绪主色/兑现点/钩子目标）有则输出、无则省略，末行固定为方向提示豁免声明。",
    "4. 如果上下文不足，写明缺失项，并给出最小补全方向。",
    `4. 后续正文必须按完整章节规划，${chapterLengthBoundary(lengthSpec)}`,
    "5. 任务书必须规划足够的场景推进、冲突升级、人物互动、细节描写和结尾钩子，避免只写一个短场景。",
    "6. 方向提示（情绪主色/兑现点/钩子目标）不是机械打卡项：自然节奏与契约细项冲突时优先保证章节成立，并在任务书末尾以“取舍说明：”行写明取舍。",
    "",
    chapterNumber ? `目标章节：第${chapterNumber}章` : "目标章节：用户请求中的章节",
    chapterNumber ? `TARGET_CHAPTER_NUMBER: ${chapterNumber}` : "",
    `用户请求：${userRequest}`,
    goldenThreeChapterSection(goldenThreeChapter),
    planBlueprintSection(planBlueprint, planMaxChars),
  ].filter(Boolean).join("\n"), extraInstructions)
}

export function buildDeepChapterDraftPrompt(
  outline: string,
  contextPrompt: string,
  taskBrief: string,
  userRequest: string,
  chapterNumber?: number,
  goldenThreeChapter?: GoldenThreeChapterRequest,
  lengthSpec: ChapterLengthSpec = DEFAULT_CHAPTER_LENGTH_SPEC,
  extraInstructions?: string,
  autoGenerateChapterTitle = true,
  /**
   * F07: 用户已确认的章节计划原文（可选，additive）。缺省 undefined → prompt 逐字节不变。
   * 排在稳定上下文前缀之后、写作任务书之前：先给计划（权威约束），再给任务书（执行细则）。
   */
  planBlueprint?: string,
  /** RV-04: 计划字符上限（码点计，缺省 `PLAN_BLUEPRINT_MAX_CHARS`）。 */
  planMaxChars: number = PLAN_BLUEPRINT_MAX_CHARS,
): string {
  return appendTaskExtraSection([
    buildStableContextPrefix(outline, contextPrompt),
    "[DRAFT_STAGE_MARKER]",
    "",
    "你是专业小说正文写作助手。",
    "请严格根据上述上下文和下方写作任务书起草章节正文。",
    "",
    "输出要求：",
    "1. 只输出可直接保存到章节库的小说正文。",
    `2. ${chapterTitleLine(autoGenerateChapterTitle)}`,
    "3. 不要输出分析、任务书、审稿说明、引用来源或后续建议。",
    "4. 严格承接上一章结尾，遵守大纲、记忆、人设、伏笔和时间线。",
    "5. 结尾必须留下适合下一章继续推进的钩子。",
    `6. 字数必须接近完整章节长度：${chapterLengthBoundary(lengthSpec)}阶段3正文草稿最多 ${lengthSpec.draftMaxChars} 字，写到完整结尾后立即停止；不能提前收尾，也不能为了补细节新增额外场景。`,
    "7. 必须写成完整章节，不要只写一个片段；需要包含场景铺陈、行动推进、对话交锋、情绪变化、冲突升级和结尾钩子。",
    "8. 禁止复读、循环输出、重复同一段落或用相同句式堆字数；写到完整结尾后立即停止。",
    "",
    chapterNumber ? `目标章节：第${chapterNumber}章` : "目标章节：用户请求中的章节",
    chapterNumber ? `TARGET_CHAPTER_NUMBER: ${chapterNumber}` : "",
    `用户请求：${userRequest}`,
    goldenThreeChapterSection(goldenThreeChapter),
    planBlueprintSection(planBlueprint, planMaxChars),
    "",
    "写作任务书：",
    taskBrief,
  ].filter(Boolean).join("\n"), extraInstructions)
}

export function buildDeepChapterRevisionPrompt(
  outline: string,
  contextPrompt: string,
  taskBrief: string,
  draftContent: string,
  reviewResults: NovelReviewResult[],
  userRequest: string,
  chapterNumber?: number,
  goldenThreeChapter?: GoldenThreeChapterRequest,
  extraInstructions?: string,
  autoGenerateChapterTitle = true,
): string {
  return appendTaskExtraSection([
    buildStableContextPrefix(outline, contextPrompt),
    "[REVISION_STAGE_MARKER]",
    "",
    "你是小说正文返修助手。",
    "请根据审稿问题返修章节正文。",
    "",
    "硬性要求：",
    "1. 只输出返修后的小说正文。",
    `2. ${chapterTitleLine(autoGenerateChapterTitle)}`,
    "3. 不要输出解释、审稿说明、修改清单或后续建议。",
    "4. 优先修复审稿指出的问题，不要无关改写。",
    "5. 必须继续遵守写作任务书和上下文。",
    "6. 不再强制调整到固定字数区间；只修复审稿指出的阻断问题，并保留当前章节的有效剧情容量。",
    "7. 禁止复读、循环输出、重复同一段落或用相同句式堆字数；写到完整结尾后立即停止。",
    "",
    chapterNumber ? `目标章节：第${chapterNumber}章` : "目标章节：用户请求中的章节",
    chapterNumber ? `TARGET_CHAPTER_NUMBER: ${chapterNumber}` : "",
    `用户请求：${userRequest}`,
    goldenThreeChapterSection(goldenThreeChapter),
    "",
    "写作任务书：",
    taskBrief,
    "",
    "审稿问题：",
    formatReviewIssues(reviewResults),
    "",
    "原始初稿：",
    draftContent,
  ].filter(Boolean).join("\n"), extraInstructions)
}

export function buildDeepChapterExpansionPrompt(
  outline: string,
  contextPrompt: string,
  taskBrief: string,
  currentContent: string,
  userRequest: string,
  chapterNumber?: number,
  goldenThreeChapter?: GoldenThreeChapterRequest,
  lengthSpec: ChapterLengthSpec = DEFAULT_CHAPTER_LENGTH_SPEC,
  extraInstructions?: string,
  autoGenerateChapterTitle = true,
): string {
  return appendTaskExtraSection([
    buildStableContextPrefix(outline, contextPrompt),
    "[EXPANSION_STAGE_MARKER]",
    "",
    "你是小说正文扩写补足助手。",
    "当前章节正文明显过短，请在不推翻已有内容的前提下扩写补足为完整章节。",
    "",
    "硬性要求：",
    "1. 只输出扩写补足后的完整小说正文。",
    `2. ${chapterTitleLine(autoGenerateChapterTitle)}`,
    "3. 必须保留并自然融合原有正文的有效内容，不要输出解释、分析或修改说明。",
    `4. ${chapterLengthBoundary(lengthSpec)}`,
    "5. 扩写时补足场景铺陈、动作细节、对话交锋、心理变化、冲突升级和结尾钩子。",
    "6. 必须严格遵守写作任务书、上下文、人物状态、伏笔和时间线，不要新增会推翻设定的剧情。",
    "7. 禁止复读、循环输出、重复同一段落或用相同句式堆字数；写到完整结尾后立即停止。",
    "",
    chapterNumber ? `目标章节：第${chapterNumber}章` : "目标章节：用户请求中的章节",
    chapterNumber ? `TARGET_CHAPTER_NUMBER: ${chapterNumber}` : "",
    `用户请求：${userRequest}`,
    goldenThreeChapterSection(goldenThreeChapter),
    "",
    "写作任务书：",
    taskBrief,
    "",
    "当前过短正文：",
    currentContent,
  ].filter(Boolean).join("\n"), extraInstructions)
}

export function buildDeepChapterFinalPolishPrompt(
  outline: string,
  contextPrompt: string,
  taskBrief: string,
  currentContent: string,
  userRequest: string,
  chapterNumber?: number,
  goldenThreeChapter?: GoldenThreeChapterRequest,
  customDeAiSkill?: string,
  userMemoryStore?: UserMemoryStore,
  genre?: string,
  extraInstructions?: string,
  autoGenerateChapterTitle = true,
): string {
  const deAiRules = customDeAiSkill && customDeAiSkill.trim()
    ? customDeAiSkill.trim()
    : (userMemoryStore && hasUserDeAiWeights(userMemoryStore)
        ? buildUserAwareDeAiPrompt(userMemoryStore)
        : CHINESE_NOVEL_DE_AI_RULES)
  // 54 号设计 ⑧: genre 注入 (prosecreator 14 流派基线吸收)。
  // genre 传入时附加结构化流派规则 (仅低严重度微调, critical/high 硬规则不受影响);
  // 缺省 undefined → 零行为变更。
  const genreFragment = genre && genre.trim()
    ? ["", buildStructuredDeAiRules(genre.trim()), ""].join("\n")
    : ""
  return appendTaskExtraSection([
    buildStableContextPrefix(outline, contextPrompt),
    "[FINAL_POLISH_STAGE_MARKER]",
    "",
    "你是小说正文最终质检与去AI味助手。",
    "请对二次审查/返修后的章节做最后一遍简单审查，并进行去AI味处理。",
    "",
    "处理目标：",
    "1. 检查是否存在明显复读、循环段落、前后矛盾、突兀跳转、解释腔和机械套话。",
    "2. 去掉 AI 味：减少总结腔、模板句、过度解释、相同句式堆叠和空泛形容。",
    "3. 保留原有剧情事实、人物关系、时间线、伏笔和章节结尾钩子，不要另起新剧情。",
    "4. 只做必要的自然化、顺滑化和轻量修补，不要大幅重写。",
    "5. 不再强制压缩到固定字数区间；只做必要的自然化、顺滑化和轻量修补，禁止为了凑字数复读。",
    `6. ${chapterTitleLine(autoGenerateChapterTitle)}`,
    "7. 只输出最终可保存的小说正文，不要输出审查报告、解释或修改说明。",
    "",
    deAiRules,
    genreFragment,
    "",
    chapterNumber ? `目标章节：第${chapterNumber}章` : "目标章节：用户请求中的章节",
    chapterNumber ? `TARGET_CHAPTER_NUMBER: ${chapterNumber}` : "",
    `用户请求：${userRequest}`,
    goldenThreeChapterSection(goldenThreeChapter),
    "",
    "写作任务书：",
    taskBrief,
    "",
    "待最终简单审查与去AI味正文：",
    currentContent,
  ].filter(Boolean).join("\n"), extraInstructions)
}

export function buildDeepChapterLengthRewritePrompt(
  contextPrompt: string,
  taskBrief: string,
  currentContent: string,
  userRequest: string,
  chapterNumber?: number,
  goldenThreeChapter?: GoldenThreeChapterRequest,
  options?: { autoGenerateChapterTitle?: boolean },
  extraInstructions?: string,
): string {
  // 与其它阶段同一开关名：真值只能来自 `novelConfig.autoGenerateChapterTitle`，
  // 不在这里默认成 true（旧缺口 RV-001：恒真 = 用户关不掉）。
  const autoTitle = options?.autoGenerateChapterTitle !== false
  return appendTaskExtraSection([
    "你是小说正文轻量整理助手。",
    "请基于阶段3正文草稿做必要整理，在不影响剧情主线、人物行动、关键冲突和结尾钩子的前提下，酌情删减明显重复、循环输出和无效解释。",
    "",
    "硬性要求：",
    "1. 只输出优化后的完整小说正文，不要输出解释、分析或修改说明。",
    autoTitle ? `2. ${chapterTitleRequirement()}` : "2. 不要输出章节标题。",
    "3. 不强制压缩到固定字数区间；保留当前章节的有效剧情容量。",
    "4. 如果当前正文明显重复或循环，优先删掉重复内容，不得继续扩写。",
    "5. 不得改变剧情因果、人物目标、已完成事件、关键对话含义和下一章钩子。",
    "6. 可以优化环境、氛围、心理和过渡，但每一段都必须推动剧情、冲突、人物关系或期待。",
    "7. 写到完整结尾后立即停止。",
    "",
    chapterNumber ? `目标章节：第${chapterNumber}章` : "目标章节：用户请求中的章节",
    chapterNumber ? `TARGET_CHAPTER_NUMBER: ${chapterNumber}` : "",
    `用户请求：${userRequest}`,
    goldenThreeChapterSection(goldenThreeChapter),
    "",
    "写作任务书：",
    taskBrief,
    "",
    "当前过长正文：",
    currentContent,
    "",
    "上下文：",
    contextPrompt,
  ].join("\n"), extraInstructions)
}

function goldenThreeChapterSection(goldenThreeChapter?: GoldenThreeChapterRequest): string {
  return buildGoldenThreeChapterDirective(goldenThreeChapter)
}

/** 章节标题输出要求（当 autoGenerateChapterTitle 为 true 时使用）。 */
function chapterTitleRequirement(): string {
  return "正文第一行必须是章节标题，格式为：# 第X章 标题名（标题4-12字，概括本章核心内容）。"
}

/**
 * 标题行（RV-001）：开关来自 `novelConfig.autoGenerateChapterTitle` 真值。
 *
 * 关闭时明确要求「不要输出章节标题」，否则模型仍会自带 H1，让「关掉自动标题」变成假开关。
 */
function chapterTitleLine(autoGenerateChapterTitle: boolean): string {
  return autoGenerateChapterTitle ? chapterTitleRequirement() : "不要输出章节标题。"
}

function formatReviewIssues(reviewResults: NovelReviewResult[]): string {
  if (reviewResults.length === 0) return "未发现问题。"
  return reviewResults
    .map((item, index) => [
      `${index + 1}. [${item.severity}] ${item.message}`,
      item.evidence ? `证据：${item.evidence}` : "",
      item.relatedMemory ? `相关记忆：${item.relatedMemory}` : "",
      item.suggestion ? `建议：${item.suggestion}` : "",
    ].filter(Boolean).join("\n"))
    .join("\n\n")
}
