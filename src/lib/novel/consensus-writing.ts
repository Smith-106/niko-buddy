import type { LlmConfig } from "@/stores/wiki-store"
import type { ChatMessage } from "@/lib/llm-client"
import { streamChat, combineAbortSignals, isRequestCancelledError } from "@/lib/llm-client"
import {
  runDeepChapterGeneration,
  type DeepChapterGenerationCallbacks,
  type DeepChapterGenerationDeps,
  type DeepChapterGenerationInput,
  type DeepChapterGenerationResult,
} from "./deep-chapter-generation"
import {
  anonymousId,
  buildConsensusCanonDigest,
  pickBestDraft,
  type DraftCandidate,
  type PeerEvaluation,
} from "./consensus-aggregate"
import { logger, toErrorMessage } from "@/lib/utils"
import { getNovelRoleTemperature, resolveConsensusModels } from "./model-resolver"

/**
 * 写作共识执行器（consensus feature，consensusEnabled=true 旁路）：
 * N 路独立 LlmConfig 并行 runDeepChapterGeneration → Track A 门控先筛（Consistency P0 >
 * Anti-AI P1 > Quality P2）→ 互评（排除自评，debateRounds 轮真辩论注入他席匿名评分）→
 * 互评平均分最高稿胜出 → 胜者结果原样返回，照常进 Draft pending 状态机。
 *
 * 等价性：consensusEnabled=false / 模型组空 / 解析后单模型 → 直通
 * runDeepChapterGeneration，行为与现状逐字节一致。
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
const CONSENSUS_ABORT_MESSAGE = "已停止生成"

type GateTriState = "passed" | "failed" | "pending" | undefined

function readGateState(
  decisionGates: DeepChapterGenerationResult["decisionGates"] | undefined,
  key: "consistency" | "anti_ai",
): GateTriState {
  const gate = decisionGates?.[key]
  if (!gate) return undefined
  if (gate.status === "failed" || gate.verdict === "fail" || gate.verdict === "manual_review") {
    return "failed"
  }
  if (gate.status === "passed" || gate.verdict === "pass" || gate.verdict === "warning") {
    return "passed"
  }
  return "pending"
}

/**
 * R2-REV-004：Track A 门控优先级过滤（Consistency P0 > Anti-AI P1 > Quality P2）。
 * 先按 P0 一致性筛，再在 P0 存活集内按 P1 反 AI 筛；绝不允许 P0 失败稿凭高文学分翻盘。
 * 当所有候选均未提供 decisionGates（兼容旧夹具）时保留全集。
 */
export function selectGateEligibleCandidates<
  T extends { result: Pick<DeepChapterGenerationResult, "decisionGates"> },
>(seats: readonly T[]): T[] {
  if (seats.length <= 1) return [...seats]

  // P0: Consistency
  let pool = [...seats]
  const p0Passed = pool.filter((s) => readGateState(s.result.decisionGates, "consistency") === "passed")
  if (p0Passed.length > 0) {
    pool = p0Passed
  } else {
    const p0NotFailed = pool.filter((s) => readGateState(s.result.decisionGates, "consistency") !== "failed")
    if (p0NotFailed.length > 0) {
      pool = p0NotFailed
    }
  }

  // P1: Anti-AI (within P0 survivors)
  if (pool.length > 1) {
    const p1Passed = pool.filter((s) => readGateState(s.result.decisionGates, "anti_ai") === "passed")
    if (p1Passed.length > 0) {
      pool = p1Passed
    } else {
      const p1NotFailed = pool.filter((s) => readGateState(s.result.decisionGates, "anti_ai") !== "failed")
      if (p1NotFailed.length > 0) {
        pool = p1NotFailed
      }
    }
  }

  return pool
}

export function buildEvaluationPrompt(
  input: DeepChapterGenerationInput,
  candidateContent: string,
  peerOpinions?: readonly PeerEvaluation[],
  canonDigest?: string,
): string {
  const chapterLabel = input.chapterNumber ? `第${input.chapterNumber}章` : "本章"
  const canonSection = canonDigest?.trim()
    ? `\n\n【正典与计划约束摘要（互评对齐基线）】\n${canonDigest.trim()}`
    : ""
  const peerSection =
    peerOpinions && peerOpinions.length > 0
      ? `\n\n【多模型共识辩论】其他席位对该候选稿的上轮匿名评分与理由：\n${peerOpinions
          .map((op) => `- 评审${op.voter}：${op.score} 分 —— ${op.rationale}`)
          .join("\n")}\n请综合参考上述他席意见后重新独立评分，并在 rationale 中说明维持原判或调整分数的依据。`
      : ""
  return `写作目标：
${input.userRequest}${canonSection}

候选${chapterLabel}稿件全文：
${candidateContent}${peerSection}

请以编辑身份独立评分（0-10，可一位小数）。评分维度：目标达成、叙事张力、文风一致性、可用性。
只输出 JSON：{"score": 0.0, "rationale": "评分理由（引用稿件具体之处）"}`
}

async function evaluateDraft(
  llmConfig: LlmConfig,
  input: DeepChapterGenerationInput,
  candidateContent: string,
  signal: AbortSignal | undefined,
  peerOpinions?: readonly PeerEvaluation[],
  canonDigest?: string,
): Promise<PeerEvaluation> {
  if (signal?.aborted) throw new Error(CONSENSUS_ABORT_MESSAGE)
  const messages: ChatMessage[] = [
    { role: "system", content: EVAL_SYSTEM_PROMPT },
    { role: "user", content: buildEvaluationPrompt(input, candidateContent, peerOpinions, canonDigest) },
  ]
  let text = ""
  let streamError: unknown = null
  await streamChat(
    llmConfig,
    messages,
    {
      onToken: (token: string) => {
        text += token
      },
      onDone: () => {},
      onError: (err: unknown) => {
        streamError = err
        // IMT-ODX-02: 互评席位流中断记录日志并在流结束后主动抛出
        logger.warn("Consensus Writing", `互评席位流中断: ${toErrorMessage(err)}`)
      },
    },
    combineAbortSignals(signal, AbortSignal.timeout(120000)),
    {
      temperature: getNovelRoleTemperature("review"),
      reasoning: { mode: input.novelConfig.reviewReasoningEffort ?? "high" },
    },
  )
  if (signal?.aborted) throw new Error(CONSENSUS_ABORT_MESSAGE)
  const readStreamError = (): unknown => streamError
  const caughtStreamError = readStreamError()
  if (caughtStreamError !== null) {
    throw caughtStreamError instanceof Error ? caughtStreamError : new Error(toErrorMessage(caughtStreamError))
  }
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
  if (signal?.aborted) throw new Error(CONSENSUS_ABORT_MESSAGE)
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
  if (signal?.aborted) throw new Error(CONSENSUS_ABORT_MESSAGE)
  for (const s of settled) {
    if (s.status === "rejected" && isRequestCancelledError(s.reason)) {
      throw s.reason
    }
  }
  const successes: { llmConfig: LlmConfig; result: DeepChapterGenerationResult; anonymousId: string }[] = []
  const failedSeats: string[] = []
  settled.forEach((s, i) => {
    if (s.status === "fulfilled") {
      successes.push({ llmConfig: models[i]!, result: s.value, anonymousId: anonymousId(successes.length) })
    } else {
      failedSeats.push(anonymousId(i))
    }
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

  // R2-REV-004：Track A 门控先于互评选优（Consistency P0 > Anti-AI P1 > Quality P2）
  const eligibleSeats = selectGateEligibleCandidates(successes)
  if (eligibleSeats.length === 1) {
    const soleWinner = eligibleSeats[0]!
    onTrace?.({
      seatCount: successes.length,
      debateRounds: 0,
      averageScores: [],
      winner: soleWinner.anonymousId,
      rationaleDigest: "Track A 门控过滤唯一存活候选稿",
      failedSeats,
    })
    return soleWinner.result
  }

  // 互评：每席评存活集合内其他候选稿（排除自评），debateRounds 轮真辩论迭代
  const candidates: DraftCandidate[] = eligibleSeats.map((s) => ({
    anonymousId: s.anonymousId,
    content: s.result.finalContent,
  }))
  const candidateTaskBriefById = new Map<string, string>(
    eligibleSeats.map((s) => [s.anonymousId, s.result.taskBrief ?? ""]),
  )
  let evaluations: PeerEvaluation[] = []
  const rounds = Math.max(1, cfg.consensusDebateRounds)
  for (let round = 0; round < rounds; round++) {
    if (signal?.aborted) throw new Error(CONSENSUS_ABORT_MESSAGE)
    const roundEvals = await Promise.allSettled(
      eligibleSeats.flatMap((seat) => {
        const voterId = seat.anonymousId
        return candidates
          .filter((c) => c.anonymousId !== voterId)
          .map(async (c) => {
            // 仅把「其他席位对该候选稿的上轮匿名评分」注入辩论 prompt（修复旧版自查他稿 Bug）
            const peerOpinions =
              round > 0
                ? evaluations.filter((e) => e.voter !== voterId && e.candidate === c.anonymousId)
                : []
            const canonDigest = buildConsensusCanonDigest({
              planBlueprint: input.planBlueprint,
              taskBrief: candidateTaskBriefById.get(c.anonymousId),
            })
            const base = await evaluateDraft(seat.llmConfig, input, c.content, signal, peerOpinions, canonDigest)
            const adjusted =
              round > 0 && peerOpinions.length > 0
                ? {
                    ...base,
                    rationale: `${base.rationale}（他席上轮评分：${peerOpinions
                      .map((op) => `${op.voter} ${op.score}`)
                      .join("、")}）`,
                  }
                : base
            return { ...adjusted, voter: voterId, candidate: c.anonymousId }
          })
      }),
    )
    if (signal?.aborted) throw new Error(CONSENSUS_ABORT_MESSAGE)
    for (const r of roundEvals) {
      if (r.status === "rejected" && isRequestCancelledError(r.reason)) {
        throw r.reason
      }
    }
    const valid = roundEvals.filter((r) => r.status === "fulfilled").map((r) => r.value)
    if (valid.length > 0) evaluations = valid
  }

  const outcome = pickBestDraft(candidates, evaluations)
  const winnerSeat = eligibleSeats.find((s) => s.anonymousId === outcome.winner.anonymousId)!
  onTrace?.({
    seatCount: successes.length,
    debateRounds: rounds,
    averageScores: outcome.averageScores,
    winner: outcome.winner.anonymousId,
    rationaleDigest: outcome.rationaleDigest,
    failedSeats,
  })
  return winnerSeat.result
}
