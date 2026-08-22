// Copyright (c) 2024 Niko-hub contributors. MIT License.

/**
 * premium-execution.spec.ts — T33c 精品执行语义 100% 覆盖率测试
 *
 * 覆盖（蓝图 §7 T33c）：
 *   1. GCR 循环（两轮封顶，异模型批判）
 *   2. 交叉共识门（一致放行/分歧落 manual_review）
 *   3. P0/P1 不被 P2 覆盖（门控优先级铁律）
 *   4. 双提案/双判官 optional 开关
 *   5. 精品模式未启用时返回原内容
 *   6. 辅助函数（parseConsensusJudgments/detectDivergence/parseArbiterResult）
 *
 * 机械层约束：模型调用走 ModelPort mock，不真调 LLM。
 * 不动 deep-chapter-generation.ts 主链。
 *
 * @license MIT © QMAI
 */

import { describe, expect, it, vi } from "vitest"
import { ModelPort } from "@/lib/llm/model-port"
import { DEFAULT_PREMIUM_CONFIG, type PremiumConfig, type PremiumModeTriggers } from "./premium-config"
import {
  runGcrLoop,
  runConsensusGate,
  runDualProposal,
  runDualJudge,
  runPremiumExecution,
  parseConsensusJudgments,
  detectDivergence,
  parseArbiterResult,
  buildGeneratePrompt,
  buildCritiquePrompt,
  buildRevisePrompt,
  buildConsensusJudgePrompt,
  buildArbiterPrompt,
  buildJudgeFusionPrompt,
  type ConsensusJudgment,
  type PremiumExecutionInput,
} from "./premium-execution"
import type { ContextPack } from "./context-engine"

// ════════════════════════════════════════════════════════════════════════════
// 测试辅助
// ════════════════════════════════════════════════════════════════════════════

/** 最小化 context pack 用于测试。 */
const MINIMAL_CONTEXT_PACK: ContextPack = {
  task: "test",
  chapterGoal: "测试章节目标",
  outline: "测试大纲",
  characterStates: "角色状态",
  cognitionStates: "认知状态",
  characterAuras: "角色光环",
  foreshadowing: "伏笔",
  memory: "记忆库",
  styleGuide: "风格指南",
  wiki: "知识库",
} as unknown as ContextPack

/** 默认项目模型配置。 */
const DEFAULT_PROJECT_CONFIG = {
  writingModel: "gpt-4",
  reviewModel: "gpt-4-review",
}

/** 创建 ModelPort mock。 */
function createMockModelPort(returnValue: string): ModelPort {
  const mock = new ModelPort()
  vi.spyOn(mock, "execute").mockResolvedValue(returnValue)
  return mock
}

/** 创建序列式 ModelPort mock（按调用次数返回不同值）。 */
function createSequentialMockModelPort(returnValues: string[]): ModelPort {
  const mock = new ModelPort()
  let callIndex = 0
  vi.spyOn(mock, "execute").mockImplementation(async () => {
    const value = returnValues[callIndex % returnValues.length]
    callIndex++
    return value
  })
  return mock
}

/** 创建基础 PremiumExecutionInput。 */
function createInput(
  overrides: Partial<PremiumExecutionInput> & {
    modelPort?: ModelPort
    premiumConfig?: PremiumConfig
  } = {},
): PremiumExecutionInput {
  return {
    chapterContent: "原始章节正文。",
    contextPack: MINIMAL_CONTEXT_PACK,
    premiumConfig: overrides.premiumConfig ?? DEFAULT_PREMIUM_CONFIG,
    projectConfig: DEFAULT_PROJECT_CONFIG,
    modelPort: overrides.modelPort ?? createMockModelPort("mock response"),
    chapterNumber: 3,
    ...overrides,
  }
}

/** 创建已启用精品模式的配置。 */
function createPremiumEnabledConfig(
  triggerOverrides?: Partial<PremiumModeTriggers>,
): PremiumConfig {
  return {
    ...DEFAULT_PREMIUM_CONFIG,
    premiumMode: true,
    triggers: {
      gcr: true,
      consensusGate: true,
      dualProposal: false,
      dualJudge: false,
      ...triggerOverrides,
    },
  }
}

// ════════════════════════════════════════════════════════════════════════════
// 辅助函数测试
// ════════════════════════════════════════════════════════════════════════════

describe("parseConsensusJudgments", () => {
  it("解析有效的 JSON 数组", () => {
    const raw = JSON.stringify([
      { type: "accept", severity: "pass", reasoning: "一切正常" },
      { type: "foreshadowing_conflict", severity: "pass", reasoning: "无冲突" },
      { type: "pov_risk", severity: "warning", reasoning: "轻微 POV 风险" },
    ])
    const result = parseConsensusJudgments(raw)
    expect(result).toHaveLength(3)
    expect(result[0]).toEqual({
      type: "accept",
      severity: "pass",
      reasoning: "一切正常",
    })
    expect(result[1]).toEqual({
      type: "foreshadowing_conflict",
      severity: "pass",
      reasoning: "无冲突",
    })
    expect(result[2]).toEqual({
      type: "pov_risk",
      severity: "warning",
      reasoning: "轻微 POV 风险",
    })
  })

  it("过滤无效条目", () => {
    const raw = JSON.stringify([
      { type: "accept", severity: "pass", reasoning: "ok" },
      { type: "unknown_dim", severity: "pass", reasoning: "未知维度" },
      { type: "accept", severity: "invalid_severity", reasoning: "无效严重度" },
      { type: "accept", reasoning: "缺少 severity" },
      { severity: "pass", reasoning: "缺少 type" },
      null,
      "string",
      42,
    ])
    const result = parseConsensusJudgments(raw)
    expect(result).toHaveLength(1)
    expect(result[0].type).toBe("accept")
  })

  it("非数组 JSON 返回空数组", () => {
    expect(parseConsensusJudgments('{"not":"array"}')).toEqual([])
  })

  it("无效 JSON 返回空数组", () => {
    expect(parseConsensusJudgments("not valid json")).toEqual([])
  })

  it("空字符串返回空数组", () => {
    expect(parseConsensusJudgments("")).toEqual([])
  })

  it("纯函数：同输入同输出", () => {
    const raw = JSON.stringify([
      { type: "accept", severity: "pass", reasoning: "ok" },
    ])
    expect(parseConsensusJudgments(raw)).toEqual(parseConsensusJudgments(raw))
  })
})

describe("detectDivergence", () => {
  const makeJudgment = (
    type: "accept" | "foreshadowing_conflict" | "pov_risk",
    severity: "pass" | "warning" | "block",
  ): ConsensusJudgment => ({ type, severity, reasoning: `${type}=${severity}` })

  it("三维度完全一致 → 无分歧", () => {
    const a = [
      makeJudgment("accept", "pass"),
      makeJudgment("foreshadowing_conflict", "pass"),
      makeJudgment("pov_risk", "pass"),
    ]
    const b = [
      makeJudgment("accept", "pass"),
      makeJudgment("foreshadowing_conflict", "pass"),
      makeJudgment("pov_risk", "pass"),
    ]
    expect(detectDivergence(a, b)).toBe(false)
  })

  it("accept 维度不一致 → 分歧", () => {
    const a = [
      makeJudgment("accept", "pass"),
      makeJudgment("foreshadowing_conflict", "pass"),
      makeJudgment("pov_risk", "pass"),
    ]
    const b = [
      makeJudgment("accept", "block"),
      makeJudgment("foreshadowing_conflict", "pass"),
      makeJudgment("pov_risk", "pass"),
    ]
    expect(detectDivergence(a, b)).toBe(true)
  })

  it("foreshadowing_conflict 维度不一致 → 分歧", () => {
    const a = [
      makeJudgment("accept", "pass"),
      makeJudgment("foreshadowing_conflict", "pass"),
      makeJudgment("pov_risk", "pass"),
    ]
    const b = [
      makeJudgment("accept", "pass"),
      makeJudgment("foreshadowing_conflict", "warning"),
      makeJudgment("pov_risk", "pass"),
    ]
    expect(detectDivergence(a, b)).toBe(true)
  })

  it("pov_risk 维度不一致 → 分歧", () => {
    const a = [
      makeJudgment("accept", "pass"),
      makeJudgment("foreshadowing_conflict", "pass"),
      makeJudgment("pov_risk", "warning"),
    ]
    const b = [
      makeJudgment("accept", "pass"),
      makeJudgment("foreshadowing_conflict", "pass"),
      makeJudgment("pov_risk", "block"),
    ]
    expect(detectDivergence(a, b)).toBe(true)
  })

  it("缺少某维度判定 → 分歧", () => {
    const a = [
      makeJudgment("accept", "pass"),
      makeJudgment("foreshadowing_conflict", "pass"),
      makeJudgment("pov_risk", "pass"),
    ]
    const b = [
      makeJudgment("accept", "pass"),
      makeJudgment("foreshadowing_conflict", "pass"),
      // missing pov_risk
    ]
    expect(detectDivergence(a, b)).toBe(true)
  })

  it("双空数组 → 分歧（缺少所有维度判定）", () => {
    expect(detectDivergence([], [])).toBe(true)
  })

  it("severity 完全一致（warning）→ 无分歧", () => {
    const a = [
      makeJudgment("accept", "warning"),
      makeJudgment("foreshadowing_conflict", "warning"),
      makeJudgment("pov_risk", "warning"),
    ]
    const b = [
      makeJudgment("accept", "warning"),
      makeJudgment("foreshadowing_conflict", "warning"),
      makeJudgment("pov_risk", "warning"),
    ]
    expect(detectDivergence(a, b)).toBe(false)
  })

  it("纯函数：同输入同输出", () => {
    const a = [makeJudgment("accept", "pass")]
    const b = [makeJudgment("accept", "pass")]
    expect(detectDivergence(a, b)).toBe(detectDivergence(a, b))
  })
})

describe("parseArbiterResult", () => {
  it("selected=A 返回 A", () => {
    expect(parseArbiterResult('{"selected":"A","reasoning":"A更优"}')).toBe("A")
  })

  it("selected=B 返回 B", () => {
    expect(parseArbiterResult('{"selected":"B","reasoning":"B更优"}')).toBe("B")
  })

  it("selected 大小写敏感 — 'a' 视为非 B 返回 A", () => {
    expect(parseArbiterResult('{"selected":"a","reasoning":"小写a"}')).toBe("A")
  })

  it("无效 JSON 返回 A（容错）", () => {
    expect(parseArbiterResult("not json")).toBe("A")
  })

  it("缺少字段返回 A", () => {
    expect(parseArbiterResult("{}")).toBe("A")
  })

  it("纯函数：同输入同输出", () => {
    expect(parseArbiterResult('{"selected":"A"}')).toBe(
      parseArbiterResult('{"selected":"A"}'),
    )
  })
})

// ════════════════════════════════════════════════════════════════════════════
// Prompt 构建函数测试
// ════════════════════════════════════════════════════════════════════════════

describe("prompt 构建函数", () => {
  it("buildGeneratePrompt 包含上下文", () => {
    const prompt = buildGeneratePrompt(MINIMAL_CONTEXT_PACK)
    expect(prompt).toContain("测试章节目标")
    expect(prompt).toContain("生成本章正文")
  })

  it("buildCritiquePrompt 包含章节正文和审查维度", () => {
    const prompt = buildCritiquePrompt(MINIMAL_CONTEXT_PACK, "测试正文")
    expect(prompt).toContain("测试正文")
    expect(prompt).toContain("审稿编辑")
    expect(prompt).toContain("人设崩坏")
    expect(prompt).toContain("JSON 数组")
  })

  it("buildRevisePrompt 包含批判意见", () => {
    const prompt = buildRevisePrompt(MINIMAL_CONTEXT_PACK, "批判意见", "当前正文")
    expect(prompt).toContain("当前正文")
    expect(prompt).toContain("批判意见")
    expect(prompt).toContain("修改本章正文")
  })

  it("buildConsensusJudgePrompt 包含三维度", () => {
    const prompt = buildConsensusJudgePrompt(MINIMAL_CONTEXT_PACK, "测试正文")
    expect(prompt).toContain("测试正文")
    expect(prompt).toContain("accept")
    expect(prompt).toContain("foreshadowing_conflict")
    expect(prompt).toContain("pov_risk")
  })

  it("buildArbiterPrompt 包含两份草稿", () => {
    const prompt = buildArbiterPrompt(MINIMAL_CONTEXT_PACK, "草稿A", "草稿B")
    expect(prompt).toContain("草稿A")
    expect(prompt).toContain("草稿B")
    expect(prompt).toContain("草稿 A")
    expect(prompt).toContain("草稿 B")
  })

  it("buildJudgeFusionPrompt 包含两位判官输出", () => {
    const prompt = buildJudgeFusionPrompt(
      MINIMAL_CONTEXT_PACK,
      "测试正文",
      "判官A输出",
      "判官B输出",
    )
    expect(prompt).toContain("测试正文")
    expect(prompt).toContain("判官A输出")
    expect(prompt).toContain("判官B输出")
    expect(prompt).toContain("判官 A")
    expect(prompt).toContain("判官 B")
  })
})

// ════════════════════════════════════════════════════════════════════════════
// GCR 循环
// ════════════════════════════════════════════════════════════════════════════

describe("GCR 循环 (runGcrLoop)", () => {
  it("执行两轮 GCR（generate → critique → revise ×2）", async () => {
    const modelPort = createSequentialMockModelPort([
      "初始提案正文",
      "批判意见：角色A人设不一致",
      "修订后正文V1",
      "第二轮提案正文",
      "第二轮批判意见",
      "修订后正文V2",
    ])
    const input = createInput({
      modelPort,
      premiumConfig: createPremiumEnabledConfig(),
    })
    const result = await runGcrLoop(input)
    expect(result.rounds).toHaveLength(2)
    expect(result.rounds[0].proposal).toBe("初始提案正文")
    expect(result.rounds[0].critique).toBe("批判意见：角色A人设不一致")
    expect(result.rounds[0].revision).toBe("修订后正文V1")
    expect(result.rounds[1].proposal).toBe("第二轮提案正文")
    expect(result.rounds[1].critique).toBe("第二轮批判意见")
    expect(result.rounds[1].revision).toBe("修订后正文V2")
    expect(result.finalText).toBe("修订后正文V2")
    // ModelPort.execute 应被调用 6 次（2 轮 × 3 步）
    expect(modelPort.execute).toHaveBeenCalledTimes(6)
  })

  it("异模型批判：使用 premiumConfig.fallbackChains.critic 的模型", async () => {
    const modelPort = createMockModelPort("mock response")
    const premiumConfig: PremiumConfig = {
      ...createPremiumEnabledConfig(),
      fallbackChains: {
        critic: {
          primary: "claude-3-opus",
          fallbacks: [],
          exhaustedAction: "checkpoint",
          contentFailAction: "manual_review",
        },
      },
    }
    const input = createInput({ modelPort, premiumConfig })
    await runGcrLoop(input)
    // 第 1 次和第 4 次调用是 generate（writer 模型），第 2 次和第 5 次调用是 critique（critic 模型）
    const calls = (modelPort.execute as ReturnType<typeof vi.spyOn>).mock.calls
    // 每次调用参数是 { config, messages, signal }
    const critiqueCall1 = calls[1][0] as { config: { model: string } }
    const critiqueCall2 = calls[4][0] as { config: { model: string } }
    expect(critiqueCall1.config.model).toBe("claude-3-opus")
    expect(critiqueCall2.config.model).toBe("claude-3-opus")
  })

  it("GCR 未启用时由 runPremiumExecution 控制，不直接调用", async () => {
    // 无 GCR 时 runGcrLoop 不被调用，同时关闭共识门避免 ModelPort 调用
    const modelPort = createMockModelPort("mock")
    const premiumConfig = { ...DEFAULT_PREMIUM_CONFIG, premiumMode: true, triggers: { ...DEFAULT_PREMIUM_CONFIG.triggers, gcr: false, consensusGate: false } }
    const input = createInput({ modelPort, premiumConfig })
    const result = await runPremiumExecution(input)
    expect(result.gcrRounds).toEqual([])
    expect(modelPort.execute).not.toHaveBeenCalled()
  })

  it("中止信号提前终止", async () => {
    const controller = new AbortController()
    controller.abort()
    const modelPort = createMockModelPort("mock")
    const input = createInput({
      modelPort,
      premiumConfig: createPremiumEnabledConfig(),
    })
    await expect(runGcrLoop(input, controller.signal)).rejects.toThrow("已停止生成")
  })
})

// ════════════════════════════════════════════════════════════════════════════
// 交叉共识门
// ════════════════════════════════════════════════════════════════════════════

describe("交叉共识门 (runConsensusGate)", () => {
  it("双判官一致且全部 pass → 放行 (pass=true, manualReview=false)", async () => {
    const judgeOutput = JSON.stringify([
      { type: "accept", severity: "pass", reasoning: "ok" },
      { type: "foreshadowing_conflict", severity: "pass", reasoning: "无冲突" },
      { type: "pov_risk", severity: "pass", reasoning: "无风险" },
    ])
    const modelPort = createMockModelPort(judgeOutput)
    const input = createInput({
      modelPort,
      premiumConfig: createPremiumEnabledConfig(),
    })
    const verdict = await runConsensusGate(input, "测试正文")
    expect(verdict.pass).toBe(true)
    expect(verdict.manualReview).toBe(false)
    expect(verdict.divergence).toBe(false)
    expect(verdict.judgments.judgeA).toHaveLength(3)
    expect(verdict.judgments.judgeB).toHaveLength(3)
  })

  it("双判官一致但全部 warning → 不放行（pass=false）但无分歧（manualReview=false）", async () => {
    const judgeOutput = JSON.stringify([
      { type: "accept", severity: "warning", reasoning: "ok" },
      { type: "foreshadowing_conflict", severity: "warning", reasoning: "无冲突" },
      { type: "pov_risk", severity: "warning", reasoning: "轻微风险" },
    ])
    const modelPort = createMockModelPort(judgeOutput)
    const input = createInput({
      modelPort,
      premiumConfig: createPremiumEnabledConfig(),
    })
    const verdict = await runConsensusGate(input, "测试正文")
    expect(verdict.pass).toBe(false)
    expect(verdict.manualReview).toBe(false)
    expect(verdict.divergence).toBe(false)
  })

  it("双判官分歧 → manualReview=true, pass=false", async () => {
    const judgeAOutput = JSON.stringify([
      { type: "accept", severity: "pass", reasoning: "ok" },
      { type: "foreshadowing_conflict", severity: "pass", reasoning: "无冲突" },
      { type: "pov_risk", severity: "pass", reasoning: "无风险" },
    ])
    const judgeBOutput = JSON.stringify([
      { type: "accept", severity: "block", reasoning: "有阻断性问题" },
      { type: "foreshadowing_conflict", severity: "pass", reasoning: "无冲突" },
      { type: "pov_risk", severity: "pass", reasoning: "无风险" },
    ])
    const modelPort = createSequentialMockModelPort([judgeAOutput, judgeBOutput])
    const input = createInput({
      modelPort,
      premiumConfig: createPremiumEnabledConfig(),
    })
    const verdict = await runConsensusGate(input, "测试正文")
    expect(verdict.pass).toBe(false)
    expect(verdict.manualReview).toBe(true)
    expect(verdict.divergence).toBe(true)
  })

  it("双判官 parse 失败 → 空数组 → 分歧（manualReview=true）", async () => {
    const modelPort = createMockModelPort("invalid json")
    const input = createInput({
      modelPort,
      premiumConfig: createPremiumEnabledConfig(),
    })
    const verdict = await runConsensusGate(input, "测试正文")
    expect(verdict.pass).toBe(false)
    expect(verdict.manualReview).toBe(true)
    expect(verdict.divergence).toBe(true)
    expect(verdict.judgments.judgeA).toEqual([])
    expect(verdict.judgments.judgeB).toEqual([])
  })

  it("共识门未启用时不在 runPremiumExecution 中调用", async () => {
    const modelPort = createMockModelPort("mock")
    const premiumConfig = {
      ...DEFAULT_PREMIUM_CONFIG,
      premiumMode: true,
      triggers: { ...DEFAULT_PREMIUM_CONFIG.triggers, gcr: false, consensusGate: false },
    }
    const input = createInput({ modelPort, premiumConfig })
    const result = await runPremiumExecution(input)
    expect(result.consensusVerdict).toBeNull()
    expect(modelPort.execute).not.toHaveBeenCalled()
  })
})

// ════════════════════════════════════════════════════════════════════════════
// 门控优先级铁律：P0/P1 不被 P2 覆盖
// ════════════════════════════════════════════════════════════════════════════

describe("门控优先级铁律 (P0/P1 不被 P2 覆盖)", () => {
  it("共识门分歧标记 manualReview 但 continue 执行（不阻断）", async () => {
    // 分歧情况下 consensusGate 返回 manualReview=true 但 pass=false
    // 不 throw，不阻断执行
    const judgeAOutput = JSON.stringify([
      { type: "accept", severity: "pass", reasoning: "A: ok" },
      { type: "foreshadowing_conflict", severity: "pass", reasoning: "A: 无冲突" },
      { type: "pov_risk", severity: "pass", reasoning: "A: 无风险" },
    ])
    const judgeBOutput = JSON.stringify([
      { type: "accept", severity: "block", reasoning: "B: 阻断" },
      { type: "foreshadowing_conflict", severity: "pass", reasoning: "B: 无冲突" },
      { type: "pov_risk", severity: "pass", reasoning: "B: 无风险" },
    ])
    const modelPort = createSequentialMockModelPort([
      "GCR提案",
      "GCR批判",
      "GCR修订",
      "GCR第二轮提案",
      "GCR第二轮批判",
      "GCR第二轮修订",
      judgeAOutput,
      judgeBOutput,
    ])
    const input = createInput({
      modelPort,
      premiumConfig: createPremiumEnabledConfig(),
    })
    const result = await runPremiumExecution(input)
    // 共识门分歧标记 manualReview
    expect(result.consensusVerdict).not.toBeNull()
    expect(result.consensusVerdict!.manualReview).toBe(true)
    expect(result.consensusVerdict!.pass).toBe(false)
    // 但执行继续：finalText 被更新
    expect(result.finalText).toBe("GCR第二轮修订")
    expect(result.manualReviewRequired).toBe(true)
  })

  it("共识门仅 P2 additive，不阻断 P0/P1 的阻断逻辑", async () => {
    // 共识门分歧标记 manualReview 但不阻断执行
    // 调用方（如 deep-chapter-generation）仍然运行其 P0/P1 门控
    const judgeAOutput = JSON.stringify([
      { type: "accept", severity: "block", reasoning: "A: block" },
      { type: "foreshadowing_conflict", severity: "block", reasoning: "A: 伏笔冲突" },
      { type: "pov_risk", severity: "block", reasoning: "A: POV 风险" },
    ])
    const judgeBOutput = JSON.stringify([
      { type: "accept", severity: "pass", reasoning: "B: pass" },
      { type: "foreshadowing_conflict", severity: "pass", reasoning: "B: 无冲突" },
      { type: "pov_risk", severity: "pass", reasoning: "B: 无风险" },
    ])
    const modelPort = createSequentialMockModelPort([
      "GCR提案",
      "GCR批判",
      "GCR修订",
      "GCR第二轮提案",
      "GCR第二轮批判",
      "GCR第二轮修订",
      judgeAOutput,
      judgeBOutput,
    ])
    const input = createInput({
      modelPort,
      premiumConfig: createPremiumEnabledConfig(),
    })
    const result = await runPremiumExecution(input)
    // 共识门分歧标记 manualReview
    expect(result.consensusVerdict!.manualReview).toBe(true)
    // 但执行继续：finalText 应为 GCR 的输出
    expect(result.finalText).toBe("GCR第二轮修订")
    // consensusVerdict.pass = false 但执行不阻断
    // 由调用方决定是否因 consensus 分歧而阻断
  })
})

// ════════════════════════════════════════════════════════════════════════════
// 双提案模式
// ════════════════════════════════════════════════════════════════════════════

describe("双提案模式 (runDualProposal)", () => {
  it("双 writer 并行生成，仲裁选择草稿 A", async () => {
    const modelPort = createSequentialMockModelPort([
      "草稿A正文",
      "草稿B正文",
      '{"selected":"A","reasoning":"A更好"}',
    ])
    const input = createInput({
      modelPort,
      premiumConfig: createPremiumEnabledConfig({ dualProposal: true }),
    })
    const result = await runDualProposal(input)
    expect(result).toBe("草稿A正文")
    expect(modelPort.execute).toHaveBeenCalledTimes(3)
  })

  it("仲裁选择草稿 B", async () => {
    const modelPort = createSequentialMockModelPort([
      "草稿A正文",
      "草稿B正文",
      '{"selected":"B","reasoning":"B更优"}',
    ])
    const input = createInput({
      modelPort,
      premiumConfig: createPremiumEnabledConfig({ dualProposal: true }),
    })
    const result = await runDualProposal(input)
    expect(result).toBe("草稿B正文")
  })

  it("仲裁 JSON 解析失败时默认选 A", async () => {
    const modelPort = createSequentialMockModelPort([
      "草稿A正文",
      "草稿B正文",
      "invalid json",
    ])
    const input = createInput({
      modelPort,
      premiumConfig: createPremiumEnabledConfig({ dualProposal: true }),
    })
    const result = await runDualProposal(input)
    expect(result).toBe("草稿A正文")
  })

  it("双提案在 GCR 循环内被调用（当 dualProposal 启用时）", async () => {
    // GCR 第 0 轮应使用 dualProposal 替代初始 generate
    const modelPort = createSequentialMockModelPort([
      "双提案A",
      "双提案B",
      '{"selected":"A","reasoning":"A更好"}', // arbiter
      "批判意见",
      "修订后正文",
      "第二轮提案",
      "第二轮批判",
      "第二轮修订",
    ])
    const input = createInput({
      modelPort,
      premiumConfig: createPremiumEnabledConfig({ dualProposal: true }),
    })
    const result = await runGcrLoop(input)
    expect(result.rounds[0].proposal).toBe("双提案A")
    expect(result.finalText).toBe("第二轮修订")
    expect(modelPort.execute).toHaveBeenCalledTimes(8)
  })
})

// ════════════════════════════════════════════════════════════════════════════
// 双判官模式
// ════════════════════════════════════════════════════════════════════════════

describe("双判官模式 (runDualJudge)", () => {
  it("双判官并行判定，融合输出", async () => {
    const judgeAOutput = JSON.stringify([
      { type: "accept", severity: "pass", reasoning: "A: ok" },
    ])
    const judgeBOutput = JSON.stringify([
      { type: "accept", severity: "warning", reasoning: "B: 轻微问题" },
    ])
    const fusionOutput = JSON.stringify([
      { type: "accept", severity: "warning", reasoning: "融合：轻微问题" },
    ])
    const modelPort = createSequentialMockModelPort([
      judgeAOutput,
      judgeBOutput,
      fusionOutput,
    ])
    const input = createInput({
      modelPort,
      premiumConfig: createPremiumEnabledConfig({ dualJudge: true }),
    })
    const result = await runDualJudge(input, "测试正文")
    expect(result).toBe(fusionOutput)
    expect(modelPort.execute).toHaveBeenCalledTimes(3)
  })
})

// ════════════════════════════════════════════════════════════════════════════
// 精品执行编排
// ════════════════════════════════════════════════════════════════════════════

describe("精品执行编排 (runPremiumExecution)", () => {
  it("精品模式未启用 → 返回原内容", async () => {
    const modelPort = createMockModelPort("不应被调用")
    const input = createInput({ modelPort })
    const result = await runPremiumExecution(input)
    expect(result.finalText).toBe("原始章节正文。")
    expect(result.gcrRounds).toEqual([])
    expect(result.consensusVerdict).toBeNull()
    expect(result.dualProposalUsed).toBe(false)
    expect(result.dualJudgeUsed).toBe(false)
    expect(result.manualReviewRequired).toBe(false)
    expect(modelPort.execute).not.toHaveBeenCalled()
  })

  it("GCR + 共识门全开 → 完整执行链", async () => {
    const judgeOutput = JSON.stringify([
      { type: "accept", severity: "pass", reasoning: "ok" },
      { type: "foreshadowing_conflict", severity: "pass", reasoning: "无冲突" },
      { type: "pov_risk", severity: "pass", reasoning: "无风险" },
    ])
    const modelPort = createSequentialMockModelPort([
      "GCR提案",
      "GCR批判",
      "GCR修订",
      "GCR第二轮提案",
      "GCR第二轮批判",
      "GCR第二轮修订",
      judgeOutput, // judge A
      judgeOutput, // judge B
    ])
    const input = createInput({
      modelPort,
      premiumConfig: createPremiumEnabledConfig(),
    })
    const result = await runPremiumExecution(input)
    expect(result.finalText).toBe("GCR第二轮修订")
    expect(result.gcrRounds).toHaveLength(2)
    expect(result.consensusVerdict).not.toBeNull()
    expect(result.consensusVerdict!.pass).toBe(true)
    expect(result.consensusVerdict!.manualReview).toBe(false)
    expect(result.dualProposalUsed).toBe(false)
    expect(result.dualJudgeUsed).toBe(false)
    expect(result.manualReviewRequired).toBe(false)
    // 8 次调用：6 次 GCR + 2 次共识门
    expect(modelPort.execute).toHaveBeenCalledTimes(8)
  })

  it("仅双提案 + 双判官（无 GCR 共识门）", async () => {
    const modelPort = createSequentialMockModelPort([
      "提案A",
      "提案B",
      '{"selected":"A","reasoning":"A更好"}',
      "判官A输出",
      "判官B输出",
      "融合输出",
    ])
    const premiumConfig = createPremiumEnabledConfig({
      gcr: false,
      consensusGate: false,
      dualProposal: true,
      dualJudge: true,
    })
    const input = createInput({ modelPort, premiumConfig })
    const result = await runPremiumExecution(input)
    expect(result.finalText).toBe("提案A")
    expect(result.dualProposalUsed).toBe(true)
    expect(result.dualJudgeUsed).toBe(true)
    expect(result.gcrRounds).toEqual([])
    expect(result.consensusVerdict).toBeNull()
    // 6 次调用：2 次双提案 + 1 次仲裁 + 2 次双判官 + 1 次融合
    expect(modelPort.execute).toHaveBeenCalledTimes(6)
  })

  it("中止信号提前终止", async () => {
    const controller = new AbortController()
    controller.abort()
    const modelPort = createMockModelPort("mock")
    const input = createInput({
      modelPort,
      premiumConfig: createPremiumEnabledConfig(),
    })
    await expect(runPremiumExecution(input, controller.signal)).rejects.toThrow("已停止生成")
  })

  it("GCR 启用时 dualProposal 在 GCR 内调用（而非独立执行）", async () => {
    const modelPort = createSequentialMockModelPort([
      "双提案A",
      "双提案B",
      '{"selected":"A","reasoning":"A更好"}',
      "GCR批判",
      "GCR修订",
      "GCR第二轮提案",
      "GCR第二轮批判",
      "GCR第二轮修订",
    ])
    const premiumConfig = createPremiumEnabledConfig({
      gcr: true,
      consensusGate: false,
      dualProposal: true,
    })
    const input = createInput({ modelPort, premiumConfig })
    const result = await runPremiumExecution(input)
    expect(result.finalText).toBe("GCR第二轮修订")
    // GCR 内第 0 轮使用 dualProposal（3 次调用）+ 后续 5 次 = 8 次
    expect(modelPort.execute).toHaveBeenCalledTimes(8)
  })
})