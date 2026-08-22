// Copyright (c) 2024 Niko-hub contributors. MIT License.

/**
 * premium-execution.ts — T33c 精品执行语义
 *
 * 蓝图 §7 T33c:
 *   GCR 生成-批判-修订循环（两轮封顶；异模型批判挂 run_review 既有指令，0 新 route 分支）
 *   交叉共识门：accept/伏笔冲突/POV 风险双异模型独立判定一致才放行，分歧确定性落 manual_review；
 *   仅 P2 additive，永不覆盖 P0/P1（门控优先级铁律）
 *   双提案/双判官 optional 开关执行语义（读 premium-config triggers）
 *
 * 机械层约束:
 *   模型调用走 ModelPort 接口（mockable），不真调 LLM。
 *   不动 deep-chapter-generation.ts 主链。
 *   0 新 route 分支：批判步骤复用 run_review 既有指令（review-adapter 审查维度）。
 *
 * @license MIT © QMAI
 */

import { ModelPort } from "@/lib/llm/model-port"
import {
  resolveRoleModel,
  resolveJudgePool,
  resolveJudgePair,
} from "@/lib/llm/model-resolver"
import type { LlmConfig } from "@/stores/wiki-store"
import type { PremiumConfig } from "./premium-config"
import { initJournalTtlMsFromConfig, isPremiumEnabled, getEffectiveTriggers } from "./premium-config"
import type { ContextPack } from "./context-engine"
import { contextPackToPrompt } from "./context-engine"

// ════════════════════════════════════════════════════════════════════════════
// 类型定义
// ════════════════════════════════════════════════════════════════════════════

/** 共识判断维度。 */
export type ConsensusJudgmentType = "accept" | "foreshadowing_conflict" | "pov_risk"

/** 共识严重度。 */
export type ConsensusSeverity = "pass" | "warning" | "block"

/** 单次共识判断。 */
export interface ConsensusJudgment {
  type: ConsensusJudgmentType
  severity: ConsensusSeverity
  reasoning: string
}

/** 共识门裁决结果。 */
export interface ConsensusVerdict {
  /** 是否放行（双判官一致且全部 pass）。 */
  pass: boolean
  /** 是否需要人工审核（双判官分歧）。 */
  manualReview: boolean
  /** 判官 A 与判官 B 的判定数组。 */
  judgments: { judgeA: ConsensusJudgment[]; judgeB: ConsensusJudgment[] }
  /** 是否存在分歧。 */
  divergence: boolean
}

/** 单轮 GCR 记录。 */
export interface GcrRound {
  roundIndex: number
  proposal: string
  critique: string
  revision: string
}

/** GCR 循环结果。 */
export interface GcrResult {
  rounds: GcrRound[]
  finalText: string
}

/** ModelPort 模型配置（简化版，用于精品执行上下文）。 */
export interface PremiumModelConfig {
  model: string
  provider?: string
}

/** 精品执行输入。 */
export interface PremiumExecutionInput {
  /** 当前章节正文。 */
  chapterContent: string
  /** 上下文包（已装配好的 context pack）。 */
  contextPack: ContextPack
  /** 精品模式配置。 */
  premiumConfig: PremiumConfig
  /** 项目模型配置（writingModel/reviewModel 字段）。 */
  projectConfig: { writingModel: string; reviewModel: string }
  /** ModelPort 实例（测试时可注入 mock）。 */
  modelPort: ModelPort
  /** 可选：章节号。 */
  chapterNumber?: number
}

/** 精品执行结果。 */
export interface PremiumExecutionResult {
  /** 最终正文。 */
  finalText: string
  /** GCR 轮次记录（GCR 启用时非空）。 */
  gcrRounds: GcrRound[]
  /** 共识门裁决（共识门启用时非 null）。 */
  consensusVerdict: ConsensusVerdict | null
  /** 是否使用了双提案模式。 */
  dualProposalUsed: boolean
  /** 是否使用了双判官模式。 */
  dualJudgeUsed: boolean
  /** 是否需要人工审核。 */
  manualReviewRequired: boolean
}

// ════════════════════════════════════════════════════════════════════════════
// 常量
// ════════════════════════════════════════════════════════════════════════════

/** GCR 循环最大轮次（两轮封顶）。 */
const MAX_GCR_ROUNDS = 2

/** 共识门判定维度（三维）。 */
const CONSENSUS_DIMENSIONS: readonly ConsensusJudgmentType[] = [
  "accept",
  "foreshadowing_conflict",
  "pov_risk",
] as const

// ════════════════════════════════════════════════════════════════════════════
// Prompt 构建（纯函数）
// ════════════════════════════════════════════════════════════════════════════

/**
 * 构建生成提案的 prompt。
 * 纯函数。
 */
export function buildGeneratePrompt(contextPack: ContextPack): string {
  return `${contextPackToPrompt(contextPack)}

请根据以上上下文，生成本章正文。

要求：
1. 严格遵循大纲和章节目标
2. 保持角色人设一致
3. 推进剧情发展
4. 语言自然流畅，避免 AI 味

请直接输出正文，不要输出 JSON 或其他格式。`
}

/**
 * 构建批判 prompt。
 * 挂 run_review 既有指令（复用 review-adapter 的审查维度），0 新 route 分支。
 * 纯函数。
 */
export function buildCritiquePrompt(contextPack: ContextPack, proposal: string): string {
  return `${contextPackToPrompt(contextPack)}

以下是本章正文草稿：

${proposal}

你是一位专业审稿编辑。请对以上正文进行审查，检查以下维度：
1. 是否人设崩坏
2. 是否人物动机不一致
3. 是否时间线错误
4. 是否伏笔遗忘
5. 是否提前泄露秘密
6. 是否角色知道了不该知道的信息
7. 是否剧情水文
8. 是否缺少章节钩子

请逐维度给出分析，然后输出 JSON 数组：
[
  {
    "severity": "error|warning|info",
    "type": "consistency|timeline|foreshadowing|character_consistency|plot|style",
    "message": "问题描述",
    "evidence": "正文片段",
    "suggestion": "修改建议"
  }
]`
}

/**
 * 构建修订 prompt。
 * 纯函数。
 */
export function buildRevisePrompt(
  contextPack: ContextPack,
  critique: string,
  currentText: string,
): string {
  return `${contextPackToPrompt(contextPack)}

以下是本章正文草稿：

${currentText}

以下是审稿编辑的审查意见：

${critique}

请根据以上审查意见，修改本章正文。修正所有指出的问题，保持正文的连贯性和可读性。

请直接输出修改后的正文，不要输出 JSON 或其他格式。`
}

/**
 * 构建共识判官 prompt。
 * 纯函数。
 */
export function buildConsensusJudgePrompt(
  contextPack: ContextPack,
  text: string,
): string {
  return `${contextPackToPrompt(contextPack)}

以下是本章正文：

${text}

请从以下三个维度分别评估：
1. accept — 本章正文是否可以直接接受（无阻断性问题）
2. foreshadowing_conflict — 是否存在伏笔冲突（新增伏笔与已有伏笔矛盾）
3. pov_risk — 是否存在 POV 风险（视角切换不当、泄露未知信息）

请输出 JSON 格式：
[
  {
    "type": "accept|foreshadowing_conflict|pov_risk",
    "severity": "pass|warning|block",
    "reasoning": "判定理由"
  }
]`
}

/**
 * 构建仲裁 prompt（双提案模式）。
 * 纯函数。
 */
export function buildArbiterPrompt(
  contextPack: ContextPack,
  proposalA: string,
  proposalB: string,
): string {
  return `${contextPackToPrompt(contextPack)}

以下是两份独立生成的本章正文草稿：

--- 草稿 A ---
${proposalA}

--- 草稿 B ---
${proposalB}

请比较两份草稿，从以下标准选择更优的一份：
1. 与大纲和章节目标对齐程度
2. 角色人设一致性
3. 剧情推进有效性
4. 语言流畅度

请输出 JSON 格式：
{
  "selected": "A|B",
  "reasoning": "选择理由"
}`
}

/**
 * 构建判官融合 prompt（双判官模式）。
 * 纯函数。
 */
export function buildJudgeFusionPrompt(
  contextPack: ContextPack,
  text: string,
  judgeAOutput: string,
  judgeBOutput: string,
): string {
  return `${contextPackToPrompt(contextPack)}

以下是本章正文：

${text}

以下是两位独立审稿编辑的判定：

--- 判官 A ---
${judgeAOutput}

--- 判官 B ---
${judgeBOutput}

请综合两位判官的判定，输出融合后的最终判定 JSON 数组：
[
  {
    "type": "accept|foreshadowing_conflict|pov_risk",
    "severity": "pass|warning|block",
    "reasoning": "融合判定理由"
  }
]`
}

// ════════════════════════════════════════════════════════════════════════════
// 辅助函数
// ════════════════════════════════════════════════════════════════════════════

/**
 * 从 ModelPort.execute 的原始响应中解析共识判定数组。
 * 容错 JSON 解析失败（返回空数组）。
 * 纯函数。
 */
export function parseConsensusJudgments(raw: string): ConsensusJudgment[] {
  try {
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter(
      (j: unknown): j is ConsensusJudgment => {
        if (typeof j !== "object" || j === null) return false
        const entry = j as Record<string, unknown>
        return (
          typeof entry.type === "string" &&
          (CONSENSUS_DIMENSIONS as readonly string[]).includes(entry.type) &&
          typeof entry.severity === "string" &&
          ["pass", "warning", "block"].includes(entry.severity) &&
          typeof entry.reasoning === "string"
        )
      },
    )
  } catch {
    return []
  }
}

/**
 * 检测双判官判定是否存在分歧。
 * 任一维度的 severity 不一致即视为分歧。
 * 纯函数。
 */
export function detectDivergence(
  a: ConsensusJudgment[],
  b: ConsensusJudgment[],
): boolean {
  for (const dim of CONSENSUS_DIMENSIONS) {
    const jA = a.find((j) => j.type === dim)
    const jB = b.find((j) => j.type === dim)
    // 缺少任一判官对某维度的判定 → 分歧
    if (!jA || !jB) return true
    if (jA.severity !== jB.severity) return true
  }
  return false
}

/**
 * 仲裁结果解析（从 ModelPort 响应中提取 selected 字段）。
 * 容错失败时默认选 A。
 * 纯函数。
 */
export function parseArbiterResult(raw: string): "A" | "B" {
  try {
    const parsed = JSON.parse(raw) as { selected?: string; reasoning?: string }
    if (parsed.selected === "B") return "B"
    return "A"
  } catch {
    return "A"
  }
}

// ════════════════════════════════════════════════════════════════════════════
// GCR 循环
// ════════════════════════════════════════════════════════════════════════════

/**
 * 执行 GCR 生成-批判-修订循环（两轮封顶）。
 *
 * 批判步骤：
 *   挂 run_review 既有指令（复用 review-adapter 的审查维度对比），
 *   0 新 route 分支。
 *   异模型批判：使用 premiumConfig.fallbackChains.critic?.primary 设定的模型，
 *   未配置时回退到 writer 模型。
 *
 * @param input 精品执行输入
 * @param signal 可选中止信号
 * @returns GCR 循环结果
 */
export async function runGcrLoop(
  input: PremiumExecutionInput,
  signal?: AbortSignal,
): Promise<GcrResult> {
  if (signal?.aborted) throw new Error("已停止生成")

  const rounds: GcrRound[] = []
  const writerModel = resolveRoleModel("writer", input.projectConfig)
  const criticModel = input.premiumConfig.fallbackChains.critic?.primary || writerModel

  for (let roundIndex = 0; roundIndex < MAX_GCR_ROUNDS; roundIndex++) {
    if (signal?.aborted) throw new Error("已停止生成")

    // 第 0 轮：生成初始提案；后续轮次：基于上一轮修订结果继续修订
    const proposal: string = await (async () => {
      if (roundIndex === 0) {
        // 双提案模式启用时使用 runDualProposal 替代初始生成
        // A9 TTL 接线：执行入口同步 journal TTL（幂等；未配置时零差异）
        initJournalTtlMsFromConfig(input.premiumConfig)
        const triggers = getEffectiveTriggers(input.premiumConfig)
        if (triggers.dualProposal) {
          return runDualProposal(input, signal)
        }
        return generateProposal(input, writerModel, signal)
      }
      // 后续轮次：基于上一轮修订结果继续
      const prevRound = rounds[roundIndex - 1]
      return generateProposal(input, writerModel, signal, prevRound.revision)
    })()

    // 批判：挂 run_review 既有指令，异模型
    const critique = await critiqueProposal(input, proposal, criticModel, signal)

    // 修订
    const revision = await reviseProposal(input, proposal, critique, writerModel, signal)

    rounds.push({ roundIndex, proposal, critique, revision })
  }

  return {
    rounds,
    finalText: rounds[rounds.length - 1].revision,
  }
}

/**
 * 生成提案（首次生成或基于上下文重写）。
 *
 * @param input 精品执行输入
 * @param model 模型名称
 * @param signal 可选中止信号
 * @param previousText 可选：上一轮文本（后续轮次时传入）
 * @returns 生成的正文
 */
async function generateProposal(
  input: PremiumExecutionInput,
  model: string,
  signal?: AbortSignal,
  previousText?: string,
): Promise<string> {
  const prompt = previousText
    ? buildRevisePrompt(
        input.contextPack,
        "请对以下正文进行优化，提升语言质量和可读性。",
        previousText,
      )
    : buildGeneratePrompt(input.contextPack)

  return input.modelPort.execute({
    config: { model, provider: input.projectConfig.writingModel } as LlmConfig,
    messages: [{ role: "user", content: prompt }],
    signal,
  })
}

/**
 * 批判提案。
 *
 * 挂 run_review 既有指令（复用 review-adapter 的审查维度），
 * 0 新 route 分支。
 * 异模型批判：使用 criticModel（可能不同于 writerModel）。
 *
 * @param input 精品执行输入
 * @param proposal 待批判的提案正文
 * @param model 批判模型
 * @param signal 可选中止信号
 * @returns 批判结果文本
 */
async function critiqueProposal(
  input: PremiumExecutionInput,
  proposal: string,
  model: string,
  signal?: AbortSignal,
): Promise<string> {
  const prompt = buildCritiquePrompt(input.contextPack, proposal)
  return input.modelPort.execute({
    config: { model, provider: input.projectConfig.reviewModel } as LlmConfig,
    messages: [{ role: "user", content: prompt }],
    signal,
  })
}

/**
 * 修订提案。
 *
 * @param input 精品执行输入
 * @param currentText 当前正文
 * @param critique 批判意见
 * @param model 修订模型
 * @param signal 可选中止信号
 * @returns 修订后的正文
 */
async function reviseProposal(
  input: PremiumExecutionInput,
  currentText: string,
  critique: string,
  model: string,
  signal?: AbortSignal,
): Promise<string> {
  const prompt = buildRevisePrompt(input.contextPack, critique, currentText)
  return input.modelPort.execute({
    config: { model, provider: input.projectConfig.writingModel } as LlmConfig,
    messages: [{ role: "user", content: prompt }],
    signal,
  })
}

// ════════════════════════════════════════════════════════════════════════════
// 交叉共识门
// ════════════════════════════════════════════════════════════════════════════

/**
 * 执行交叉共识门判定。
 *
 * 双异模型独立判定 three 维度（accept/伏笔冲突/POV 风险），
 * 一致且全部 pass → 放行（pass=true）；
 * 分歧 → 落 manual_review（manualReview=true）。
 *
 * 门控优先级铁律：
 *   仅 P2 additive，永不覆盖 P0/P1（consensus 门不阻断执行，
 *   分歧标记 manual_review 而非立即阻断，由调用方决定是否阻断）。
 *
 * @param input 精品执行输入
 * @param text 待判定的正文
 * @param signal 可选中止信号
 * @returns 共识门裁决
 */
export async function runConsensusGate(
  input: PremiumExecutionInput,
  text: string,
  signal?: AbortSignal,
): Promise<ConsensusVerdict> {
  if (signal?.aborted) throw new Error("已停止生成")

  // 判官池 registry 路由（DEBT-20260828-t31b-01）:
  //   judgePool 显式列表 > fallbackChains.judge 派生 > 单判官回退（现状）
  const judgePool = resolveJudgePool(input.projectConfig, input.premiumConfig)
  const { judgeA: judgeModelA, judgeB: judgeModelB } = resolveJudgePair(judgePool)

  const prompt = buildConsensusJudgePrompt(input.contextPack, text)

  // 双判官并行独立判定
  const [judgeAResult, judgeBResult] = await Promise.all([
    input.modelPort.execute({
      config: { model: judgeModelA, provider: input.projectConfig.reviewModel } as LlmConfig,
      messages: [{ role: "user", content: prompt }],
      signal,
    }),
    input.modelPort.execute({
      config: { model: judgeModelB, provider: input.projectConfig.reviewModel } as LlmConfig,
      messages: [{ role: "user", content: prompt }],
      signal,
    }),
  ])

  if (signal?.aborted) throw new Error("已停止生成")

  const judgmentsA = parseConsensusJudgments(judgeAResult)
  const judgmentsB = parseConsensusJudgments(judgeBResult)

  const divergence = detectDivergence(judgmentsA, judgmentsB)

  // 门控优先级铁律：仅 P2 additive — 分歧时标记 manualReview 但 pass=false
  // 不阻断执行，由调用方决定是否走 manual_review 路径
  const pass =
    !divergence &&
    judgmentsA.every((j) => j.severity === "pass") &&
    judgmentsB.every((j) => j.severity === "pass")

  return {
    pass,
    manualReview: divergence,
    judgments: { judgeA: judgmentsA, judgeB: judgmentsB },
    divergence,
  }
}

// ════════════════════════════════════════════════════════════════════════════
// 双提案模式
// ════════════════════════════════════════════════════════════════════════════

/**
 * 双提案模式：两个独立 writer 生成后仲裁。
 *
 * 使用 resolveRoleModel("writer") 获取主模型，
 * premiumConfig.fallbackChains.writer?.primary 作为副模型（未配置时复用主模型）。
 *
 * @param input 精品执行输入
 * @param signal 可选中止信号
 * @returns 仲裁选定的正文
 */
export async function runDualProposal(
  input: PremiumExecutionInput,
  signal?: AbortSignal,
): Promise<string> {
  if (signal?.aborted) throw new Error("已停止生成")

  const modelA = resolveRoleModel("writer", input.projectConfig)
  const modelB = input.premiumConfig.fallbackChains.writer?.primary || modelA

  const prompt = buildGeneratePrompt(input.contextPack)

  // 双 writer 并行独立生成
  const [proposalA, proposalB] = await Promise.all([
    input.modelPort.execute({
      config: { model: modelA, provider: input.projectConfig.writingModel } as LlmConfig,
      messages: [{ role: "user", content: prompt }],
      signal,
    }),
    input.modelPort.execute({
      config: { model: modelB, provider: input.projectConfig.writingModel } as LlmConfig,
      messages: [{ role: "user", content: prompt }],
      signal,
    }),
  ])

  if (signal?.aborted) throw new Error("已停止生成")

  // Arbiter 仲裁选择
  const arbiterModel = resolveRoleModel("arbiter", input.projectConfig)
  const arbiterPrompt = buildArbiterPrompt(input.contextPack, proposalA, proposalB)
  const arbiterResult = await input.modelPort.execute({
    config: { model: arbiterModel, provider: input.projectConfig.reviewModel } as LlmConfig,
    messages: [{ role: "user", content: arbiterPrompt }],
    signal,
  })

  const selected = parseArbiterResult(arbiterResult)
  return selected === "B" ? proposalB : proposalA
}

// ════════════════════════════════════════════════════════════════════════════
// 双判官模式
// ════════════════════════════════════════════════════════════════════════════

/**
 * 双判官模式：两个独立 judge 判定后融合。
 *
 * 使用 resolveRoleModel("judge") 获取主判官模型，
 * premiumConfig.fallbackChains.judge?.primary 作为副判官模型（未配置时复用主模型）。
 * Arbiter 模型用于融合两位判官的判定结果。
 *
 * @param input 精品执行输入
 * @param text 待判定的正文
 * @param signal 可选中止信号
 * @returns 融合后的判定 JSON 文本
 */
export async function runDualJudge(
  input: PremiumExecutionInput,
  text: string,
  signal?: AbortSignal,
): Promise<string> {
  if (signal?.aborted) throw new Error("已停止生成")

  // 判官池 registry 路由（DEBT-20260828-t31b-01）:
  //   judgePool 显式列表 > fallbackChains.judge 派生 > 单判官回退（现状）
  const judgePool = resolveJudgePool(input.projectConfig, input.premiumConfig)
  const { judgeA: judgeModelA, judgeB: judgeModelB } = resolveJudgePair(judgePool)

  const prompt = buildConsensusJudgePrompt(input.contextPack, text)

  // 双判官并行独立判定
  const [judgeAResult, judgeBResult] = await Promise.all([
    input.modelPort.execute({
      config: { model: judgeModelA, provider: input.projectConfig.reviewModel } as LlmConfig,
      messages: [{ role: "user", content: prompt }],
      signal,
    }),
    input.modelPort.execute({
      config: { model: judgeModelB, provider: input.projectConfig.reviewModel } as LlmConfig,
      messages: [{ role: "user", content: prompt }],
      signal,
    }),
  ])

  if (signal?.aborted) throw new Error("已停止生成")

  // Arbiter 融合两判官结果
  const fusionModel = resolveRoleModel("arbiter", input.projectConfig)
  const fusionPrompt = buildJudgeFusionPrompt(
    input.contextPack,
    text,
    judgeAResult,
    judgeBResult,
  )
  return input.modelPort.execute({
    config: { model: fusionModel, provider: input.projectConfig.reviewModel } as LlmConfig,
    messages: [{ role: "user", content: fusionPrompt }],
    signal,
  })
}

// ════════════════════════════════════════════════════════════════════════════
// 精品执行编排
// ════════════════════════════════════════════════════════════════════════════

/**
 * 完整精品执行编排。
 *
 * 执行流程（按 triggers 开关）：
 *   1. GCR 循环（triggers.gcr）
 *   2. 双提案模式（triggers.dualProposal，替换 GCR 的初始生成步骤，GCR 内判断）
 *   3. 交叉共识门（triggers.consensusGate）
 *   4. 双判官模式（triggers.dualJudge，替换共识门的判定步骤，额外调用）
 *
 * 门控优先级铁律：
 *   共识门仅 P2 additive，分歧标记 manualReview 而非立即阻断，
 *   永不覆盖 P0/P1 的阻断逻辑。
 *
 * @param input 精品执行输入
 * @param signal 可选中止信号
 * @returns 精品执行结果
 */
export async function runPremiumExecution(
  input: PremiumExecutionInput,
  signal?: AbortSignal,
): Promise<PremiumExecutionResult> {
  if (signal?.aborted) throw new Error("已停止生成")

  // 精品模式未启用 → 返回原内容
  if (!isPremiumEnabled(input.premiumConfig)) {
    return {
      finalText: input.chapterContent,
      gcrRounds: [],
      consensusVerdict: null,
      dualProposalUsed: false,
      dualJudgeUsed: false,
      manualReviewRequired: false,
    }
  }

  // A9 TTL 接线：执行入口同步 journal TTL（幂等；未配置时零差异）
  initJournalTtlMsFromConfig(input.premiumConfig)
  const triggers = getEffectiveTriggers(input.premiumConfig)
  let workingText = input.chapterContent
  let gcrRounds: GcrRound[] = []
  let consensusVerdict: ConsensusVerdict | null = null
  let manualReviewRequired = false

  // Step 1: GCR 循环（包含双提案模式内部判断）
  if (triggers.gcr) {
    const gcrResult = await runGcrLoop(input, signal)
    gcrRounds = gcrResult.rounds
    workingText = gcrResult.finalText
  }

  // Step 2: 双提案模式（仅在 GCR 未启用时独立执行）
  if (!triggers.gcr && triggers.dualProposal) {
    workingText = await runDualProposal(input, signal)
  }

  // Step 3: 交叉共识门
  // 门控优先级铁律：仅 P2 additive，不阻断执行
  if (triggers.consensusGate) {
    consensusVerdict = await runConsensusGate(input, workingText, signal)
    manualReviewRequired = consensusVerdict.manualReview

    // 共识门分歧 → 标记 manualReview 但继续执行
    // 永不覆盖 P0/P1 的阻断逻辑
  }

  // Step 4: 双判官模式（仅在共识门未启用时独立执行）
  if (!triggers.consensusGate && triggers.dualJudge) {
    await runDualJudge(input, workingText, signal)
  }

  return {
    finalText: workingText,
    gcrRounds,
    consensusVerdict,
    dualProposalUsed: triggers.dualProposal,
    dualJudgeUsed: triggers.dualJudge,
    manualReviewRequired,
  }
}