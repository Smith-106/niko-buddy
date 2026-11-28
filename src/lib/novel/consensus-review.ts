import type { LlmConfig, NovelConfig } from "@/stores/wiki-store"
import type { ContextPack } from "@/lib/novel/context-engine"
import { streamChat, combineAbortSignals, isRequestCancelledError, type ChatMessage } from "@/lib/llm-client"
import {
  buildDimensionReviewPrompt,
  parseDimensionReviewResult,
  reviewChapterDimension,
  type SixReviewDimensionDefinition,
} from "./dimension-review-adapter"
import {
  aggregateReviewDimension,
  anonymousId,
  buildConsensusCanonDigest,
  type ReviewConsensusOutcome,
} from "./consensus-aggregate"
import { getNovelRoleTemperature, type NovelRoleTemperatureKey } from "./model-resolver"
import { resolveTaskExtraPrompt } from "./task-customization"
import { appendTaskExtraSection } from "./deep-chapter-prompts"
import { logger, toErrorMessage } from "@/lib/utils"
import { useWikiStore } from "@/stores/wiki-store"
import { hasUsableLlm } from "@/lib/has-usable-llm"

/**
 * 审查共识执行器（consensus feature，consensusEnabled=true 旁路）：
 * 每维 N 模型并行独立评 → debateRounds 轮匿名互看（A/B/C）再评 →
 * 纯函数聚合（consensus-aggregate）出单维终值，接回既有六维门控。
 * 门控优先级 Consistency(P0)>Anti-AI(P1)>Quality(P2) 不因此改变。
 *
 * 注：本模块与 dimension-review-adapter 为函数级循环互调（ESM 顶层无互调执行，
 * 运行时安全），换取复用 parseDimensionReviewResult / buildDimensionReviewPrompt
 * 而不复制审查 prompt/解析逻辑。
 */

export interface DimensionConsensusOptions {
  models: LlmConfig[]
  dimension: SixReviewDimensionDefinition
  contextPack: ContextPack
  chapterContent: string
  debateRounds: number
  signal?: AbortSignal
  novelConfig?: NovelConfig
  goldAnchors?: Parameters<typeof buildDimensionReviewPrompt>[3] extends infer O
    ? O extends { goldAnchors?: infer G }
      ? G
      : never
    : never
  goldReadinessHint?: string
  /** R2-W09 / R2-REV-004：透传 Track B skill hook 软提示片段（首轮 + 辩论轮同步）。 */
  skillHookPromptFragments?: readonly string[]
  /** Phase 1：审查阶段运行时技能提示片段（空串时零行为变化）。 */
  reviewSkillsPrompt?: string
  /** Phase 1：审查上下文 token 上限（缺省时零行为变化）。 */
  contextTokenBudget?: number
}

const DEBATE_SYSTEM_PROMPT =
  "你是专业网文审稿编辑，当前只负责多评审共识辩论中你这一席的重新评分。输出必须使用中文。"
const CONSENSUS_ABORT_MESSAGE = "已停止生成"

/** 辩论轮附加段：展示其他席位的匿名评分与理由（不含身份信息），可选注入有界正典摘要，明确沿用上方同一 JSON schema。 */
function buildDebateSection(
  ballots: { anonymousId: string; score: number; summary: string }[],
  selfId: string,
  canonDigest?: string,
): string {
  const others = ballots
    .filter((b) => b.anonymousId !== selfId)
    .map((b) => `- 评审${b.anonymousId}：${b.score} 分 —— ${b.summary}`)
  const digestBlock = canonDigest?.trim()
    ? `\n\n【正典约束摘要（互评对齐基线）】\n${canonDigest.trim()}`
    : ""
  return `

【多模型共识辩论】其他独立评审对本维度的匿名意见：
${others.join("\n")}${digestBlock}

辩论裁决说明：综合参考他席匿名意见后重新独立裁决，保持上文同一 JSON 输出 schema，仅输出最终 JSON 对象（不要输出额外解释、标题或 markdown 代码块）。若你维持原判，请在 summary 中重申你的评分与理由；若意见改变，请说明被说服的关键依据。`
}

async function debateCall(
  llmConfig: LlmConfig,
  debatePrompt: string,
  signal: AbortSignal | undefined,
  novelConfig: NovelConfig | undefined,
  roleKey: NovelRoleTemperatureKey,
): Promise<string> {
  if (signal?.aborted) throw new Error(CONSENSUS_ABORT_MESSAGE)
  const messages: ChatMessage[] = [
    {
      role: "system",
      content: appendTaskExtraSection(DEBATE_SYSTEM_PROMPT, resolveTaskExtraPrompt(novelConfig, "review")),
    },
    { role: "user", content: debatePrompt },
  ]
  let result = ""
  let streamError: unknown = null
  await streamChat(
    llmConfig,
    messages,
    {
      onToken: (token: string) => {
        result += token
      },
      onDone: () => {},
      onError: (err: unknown) => {
        streamError = err
        // IMT-ODX-01: 辩论流式错误记录日志并随后主动抛出，避免半截/空流被误解析。
        logger.warn("Consensus Review", `辩论席位流中断（降级沿用上轮票）: ${toErrorMessage(err)}`)
      },
    },
    combineAbortSignals(signal, AbortSignal.timeout(120000)),
    {
      temperature: getNovelRoleTemperature(roleKey),
      reasoning: { mode: (novelConfig ?? useWikiStore.getState().novelConfig).reviewReasoningEffort ?? "high" },
    },
  )
  if (signal?.aborted) throw new Error(CONSENSUS_ABORT_MESSAGE)
  const readStreamError = (): unknown => streamError
  const caughtStreamError = readStreamError()
  if (caughtStreamError !== null) {
    throw caughtStreamError instanceof Error ? caughtStreamError : new Error(toErrorMessage(caughtStreamError))
  }
  return result.trim()
}

/**
 * 单维共识：N 路并行独立评审 → debateRounds 轮匿名辩论 → 聚合。
 * 任一独立评审失败（parse/stream）→ 整维抛错（外层 buildFailedDimensionResult 路径处理）；
 * 辩论轮单席位非取消失败 → 该席位沿用上一轮票（降级容错）；取消信号立即中止并上抛。
 * models 长度为 1 时直通（无辩论），与单模型行为等价。
 */
export async function runDimensionConsensus(options: DimensionConsensusOptions): Promise<ReviewConsensusOutcome> {
  const {
    models,
    dimension,
    contextPack,
    chapterContent,
    debateRounds,
    signal,
    novelConfig,
    goldAnchors,
    goldReadinessHint,
    skillHookPromptFragments,
    reviewSkillsPrompt,
    contextTokenBudget,
  } = options
  if (signal?.aborted) throw new Error(CONSENSUS_ABORT_MESSAGE)
  const usable = models.filter((m) => hasUsableLlm(m))
  if (usable.length === 0) throw new Error(`${dimension.label}共识模型均不可用`)

  const roleKey: NovelRoleTemperatureKey =
    dimension.key === "consistency" || dimension.key === "continuity" ? "canon_audit" : "review"
  const canonDigest = buildConsensusCanonDigest(contextPack)

  // 第 1 轮：N 路独立评审（静默，不串台 callbacks）
  const firstRound = await Promise.all(
    usable.map(async (llmConfig) =>
      reviewChapterDimension({
        llmConfig,
        contextPack,
        chapterContent,
        dimension,
        signal,
        novelConfig,
        goldAnchors,
        goldReadinessHint,
        skillHookPromptFragments,
        reviewSkillsPrompt,
        contextTokenBudget,
      }),
    ),
  )
  let ballots = firstRound.map((r, i) => ({
    anonymousId: anonymousId(i),
    score: r.score,
    status: r.status,
    summary: r.summary,
    issues: r.issues,
  }))

  // 辩论轮：互看匿名意见再评（单模型直通不辩论）
  for (let round = 0; round < Math.max(0, debateRounds) && ballots.length > 1; round++) {
    if (signal?.aborted) throw new Error(CONSENSUS_ABORT_MESSAGE)
    const nextBallots = await Promise.all(
      usable.map(async (llmConfig, i) => {
        const seat = anonymousId(i)
        try {
          const basePrompt = buildDimensionReviewPrompt(contextPack, chapterContent, dimension, {
            goldAnchors,
            goldReadinessHint,
            skillHookPromptFragments,
            hardInjectEnabled: novelConfig?.hardInjectEnabled,
            contextTokenBudget,
          })
          const debatePrompt = basePrompt + buildDebateSection(ballots, seat, canonDigest)
          const text = await debateCall(llmConfig, debatePrompt, signal, novelConfig, roleKey)
          const parsed = parseDimensionReviewResult(dimension, text, `${dimension.label}辩论轮${round + 1}`)
          return { anonymousId: seat, score: parsed.score, status: parsed.status, summary: parsed.summary, issues: parsed.issues }
        } catch (err) {
          if (signal?.aborted || (err instanceof Error && isRequestCancelledError(err))) {
            throw err instanceof Error ? err : new Error(toErrorMessage(err))
          }
          // 降级容错：该席位沿用上一轮票（IMT-ODX-01: 补日志，失败席位/轮次可观测）
          logger.warn(
            "Consensus Review",
            `辩论席位 ${seat} 第 ${round + 1} 轮失败，沿用上轮票: ${toErrorMessage(err)}`,
          )
          return ballots[i]!
        }
      }),
    )
    ballots = nextBallots
  }

  return aggregateReviewDimension(dimension.key, ballots)
}
