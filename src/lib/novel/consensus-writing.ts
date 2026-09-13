import type { LlmConfig } from "@/stores/wiki-store"
import type { ChatMessage } from "@/lib/llm-client"
import { streamChat, combineAbortSignals } from "@/lib/llm-client"
import {
  runDeepChapterGeneration,
  type DeepChapterGenerationCallbacks,
  type DeepChapterGenerationDeps,
  type DeepChapterGenerationInput,
  type DeepChapterGenerationResult,
} from "./deep-chapter-generation"
import { anonymousId, pickBestDraft, type DraftCandidate, type PeerEvaluation } from "./consensus-aggregate"
import { logger } from "@/lib/utils"
import { resolveConsensusModels } from "./model-resolver"

/**
 * 写作共识执行器（consensus feature，consensusEnabled=true 旁路）：
 * N 路独立 LlmConfig 并行 runDeepChapterGeneration → 互评（排除自评，
 * debateRounds 轮互看匿名评分迭代）→ 互评平均分最高稿胜出（保作者声音
 * 一致性，不做段落合成）→ 胜者结果原样返回，照常进 Draft pending 状态机。
 *
 * 等价性：consensusEnabled=false / 模型组空 / 解析后单模型 → 直通
 * runDeepChapterGeneration，行为与现状逐字节一致（不触碰
 * deep-chapter-generation.ts 内部 resolveWritingConfig 约定）。
 */

export interface ConsensusTrace {
  seatCount: number
  debateRounds: number
  averageScores: { candidate: string; average: number }[]
  winner: string
  rationaleDigest: string
  failedSeats: string[]
}

export type ConsensusTraceListener = (trace: ConsensusTrace) => void

const EVAL_SYSTEM_PROMPT = "你是专业网文编辑，正在为多模型共识评审给一篇候选章节稿打分。输出必须使用中文。"

function buildEvaluationPrompt(input: DeepChapterGenerationInput, candidateContent: string): string {
  const chapterLabel = input.chapterNumber ? `第${input.chapterNumber}章` : "本章"
  return `写作目标：
${input.userRequest}

候选${chapterLabel}稿件全文：
${candidateContent}

请以编辑身份独立评分（0-10，可一位小数）。评分维度：目标达成、叙事张力、文风一致性、可用性。
只输出 JSON：{"score": 0.0, "rationale": "评分理由（引用稿件具体之处）"}`
}

async function evaluateDraft(
  llmConfig: LlmConfig,
  input: DeepChapterGenerationInput,
  candidateContent: string,
  signal: AbortSignal | undefined,
): Promise<PeerEvaluation> {
  const messages: ChatMessage[] = [
    { role: "system", content: EVAL_SYSTEM_PROMPT },
    { role: "user", content: buildEvaluationPrompt(input, candidateContent) },
  ]
  let text = ""
  await streamChat(
    llmConfig,
    messages,
    {
      onToken: (token: string) => {
        text += token
      },
      onDone: () => {},
      onError: (err: unknown) => {
        // IMT-ODX-02: 同型修复（见 consensus-review.ts）——互评席位流中断不再静默
        logger.warn("Consensus Writing", `互评席位流中断: ${err instanceof Error ? err.message : String(err)}`)
      },
    },
    combineAbortSignals(signal, AbortSignal.timeout(120000)),
    { reasoning: { mode: input.novelConfig.reviewReasoningEffort ?? "high" } },
  )
  const jsonMatch = text.trim().match(/\{[\s\S]*\}/)
  if (!jsonMatch) throw new Error("互评没有返回 JSON")
  const parsed = JSON.parse(jsonMatch[0]) as { score?: unknown; rationale?: unknown }
  const score = typeof parsed.score === "number" ? parsed.score : Number(parsed.score)
  if (!Number.isFinite(score)) throw new Error("互评分数无效")
  return {
    voter: "",
    candidate: "",
    score: Math.min(10, Math.max(0, score)),
    rationale: String(parsed.rationale || ""),
  }
}

/**
 * 写作共识入口。deps 透传（undefined 触发 runDeepChapterGeneration 默认 deps，
 * 与 chat-panel 直调行为一致）。返回胜者的 DeepChapterGenerationResult（类型与
 * 单模型路径一致，调用方零改动）；共识过程细节通过 trace 回调（可选）交付。
 */
export async function runDeepChapterGenerationConsensus(
  input: DeepChapterGenerationInput,
  callbacks: DeepChapterGenerationCallbacks = {},
  deps?: DeepChapterGenerationDeps,
  signal?: AbortSignal,
  onTrace?: ConsensusTraceListener,
): Promise<DeepChapterGenerationResult> {
  const cfg = input.novelConfig
  const configured = cfg.consensusEnabled ? cfg.consensusWritingModels.filter((m) => m.trim()) : []
  // 等价直通：未启用 / 未配置模型组（解析后单模型也直通）
  if (configured.length === 0) {
    return runDeepChapterGeneration(input, callbacks, deps, signal)
  }
  const models = resolveConsensusModels(configured, input.llmConfig, cfg)
  if (models.length === 1) {
    return runDeepChapterGeneration(input, callbacks, deps, signal)
  }

  // N 路并行完整生成（静默：callbacks 不透传，避免 N 路流式串台）
  const settled = await Promise.allSettled(
    models.map((llmConfig) => runDeepChapterGeneration({ ...input, llmConfig }, {}, deps, signal)),
  )
  const successes: { llmConfig: LlmConfig; result: DeepChapterGenerationResult }[] = []
  const failedSeats: string[] = []
  settled.forEach((s, i) => {
    if (s.status === "fulfilled") successes.push({ llmConfig: models[i]!, result: s.value })
    else failedSeats.push(anonymousId(i))
  })
  if (successes.length === 0) {
    // 全部失败：抛最后一个错误（与单模型失败语义一致）
    const last = [...settled].reverse().find((s) => s.status === "rejected") as PromiseRejectedResult | undefined
    logger.error(
      "Consensus Writing",
      `共识生成全部失败（${models.length} 席位）`,
      { reason: last?.reason instanceof Error ? last.reason.message : String(last?.reason ?? "unknown") },
    )
    throw last?.reason ?? new Error("共识生成全部失败")
  }
  if (successes.length === 1) {
    return successes[0]!.result
  }

  // 互评：每模型评其他成功稿（排除自评），debateRounds 轮迭代
  const candidates: DraftCandidate[] = successes.map((s, i) => ({
    anonymousId: anonymousId(i),
    content: s.result.finalContent,
  }))
  let evaluations: PeerEvaluation[] = []
  const rounds = Math.max(1, cfg.consensusDebateRounds)
  for (let round = 0; round < rounds; round++) {
    const roundEvals = await Promise.allSettled(
      successes.flatMap((seat, si) => {
        const voterId = anonymousId(si)
        return candidates
          .filter((c) => c.anonymousId !== voterId)
          .map(async (c) => {
            const base = await evaluateDraft(seat.llmConfig, input, c.content, signal)
            const prev = evaluations.find((e) => e.voter === voterId && e.candidate === c.anonymousId)
            // 迭代轮：模型看到他席上轮评分（辩论式互看）
            const adjusted =
              round > 0 && prev
                ? {
                    ...base,
                    rationale: `${base.rationale}（他席上轮评分：${candidates
                      .filter((o) => o.anonymousId !== voterId && o.anonymousId !== c.anonymousId)
                      .map((o) => {
                        const found = evaluations.find((e) => e.voter === voterId && e.candidate === o.anonymousId)
                        return `${o.anonymousId} ${found?.score ?? "?"}`
                      })
                      .join("、")}）`,
                  }
                : base
            return { ...adjusted, voter: voterId, candidate: c.anonymousId }
          })
      }),
    )
    const valid = roundEvals.filter((r) => r.status === "fulfilled").map((r) => r.value)
    if (valid.length > 0) evaluations = valid
  }

  const outcome = pickBestDraft(candidates, evaluations)
  const winnerIndex = candidates.findIndex((c) => c.anonymousId === outcome.winner.anonymousId)
  const winnerResult = successes[winnerIndex]!.result
  onTrace?.({
    seatCount: successes.length,
    debateRounds: rounds,
    averageScores: outcome.averageScores,
    winner: outcome.winner.anonymousId,
    rationaleDigest: outcome.rationaleDigest,
    failedSeats,
  })
  return winnerResult
}
