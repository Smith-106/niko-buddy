import type { LlmConfig, NovelConfig } from "@/stores/wiki-store"
import type { ContextPack } from "@/lib/novel/context-engine"
import { streamChat, combineAbortSignals, type ChatMessage } from "@/lib/llm-client"
import {
  buildDimensionReviewPrompt,
  parseDimensionReviewResult,
  reviewChapterDimension,
  type SixReviewDimensionDefinition,
} from "./dimension-review-adapter"
import { aggregateReviewDimension, anonymousId, type ReviewConsensusOutcome } from "./consensus-aggregate"
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
}

const DEBATE_SYSTEM_PROMPT =
  "你是专业网文审稿编辑，当前只负责多评审共识辩论中你这一席的重新评分。输出必须使用中文。"

/** 辩论轮附加段：展示其他席位的匿名评分与理由（不含身份信息）。 */
function buildDebateSection(ballots: { anonymousId: string; score: number; summary: string }[], selfId: string): string {
  const others = ballots
    .filter((b) => b.anonymousId !== selfId)
    .map((b) => `- 评审${b.anonymousId}：${b.score} 分 —— ${b.summary}`)
  return `

【多模型共识辩论】其他独立评审对本维度的匿名意见：
${others.join("\n")}

请参考上述意见重新独立给出本维度的最终 JSON 评分。若你维持原判，请原样重申你的评分与理由；若意见改变，请说明被说服的点。`
}

async function debateCall(
  llmConfig: LlmConfig,
  debatePrompt: string,
  signal: AbortSignal | undefined,
  novelConfig: NovelConfig | undefined,
): Promise<string> {
  const messages: ChatMessage[] = [
    { role: "system", content: DEBATE_SYSTEM_PROMPT },
    { role: "user", content: debatePrompt },
  ]
  let result = ""
  await streamChat(
    llmConfig,
    messages,
    {
      onToken: (token: string) => {
        result += token
      },
      onDone: () => {},
      onError: () => {},
    },
    combineAbortSignals(signal, AbortSignal.timeout(120000)),
    { reasoning: { mode: (novelConfig ?? useWikiStore.getState().novelConfig).reviewReasoningEffort ?? "high" } },
  )
  return result.trim()
}

/**
 * 单维共识：N 路并行独立评审 → debateRounds 轮匿名辩论 → 聚合。
 * 任一独立评审失败（parse/stream）→ 整维抛错（外层 buildFailedDimensionResult 路径处理）；
 * 辩论轮单席位失败 → 该席位沿用上一轮票（降级容错）。
 * models 长度为 1 时直通（无辩论），与单模型行为等价。
 */
export async function runDimensionConsensus(options: DimensionConsensusOptions): Promise<ReviewConsensusOutcome> {
  const { models, dimension, contextPack, chapterContent, debateRounds, signal, novelConfig, goldAnchors, goldReadinessHint } =
    options
  const usable = models.filter((m) => hasUsableLlm(m))
  if (usable.length === 0) throw new Error(`${dimension.label}共识模型均不可用`)

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
    const nextBallots = await Promise.all(
      usable.map(async (llmConfig, i) => {
        const seat = anonymousId(i)
        try {
          const basePrompt = buildDimensionReviewPrompt(contextPack, chapterContent, dimension, {
            goldAnchors,
            goldReadinessHint,
            hardInjectEnabled: novelConfig?.hardInjectEnabled,
          })
          const debatePrompt = basePrompt + buildDebateSection(ballots, seat)
          const text = await debateCall(llmConfig, debatePrompt, signal, novelConfig)
          const parsed = parseDimensionReviewResult(dimension, text, `${dimension.label}辩论轮${round + 1}`)
          return { anonymousId: seat, score: parsed.score, status: parsed.status, summary: parsed.summary, issues: parsed.issues }
        } catch {
          // 降级容错：该席位沿用上一轮票
          return ballots[i]!
        }
      }),
    )
    ballots = nextBallots
  }

  return aggregateReviewDimension(dimension.key, ballots)
}
