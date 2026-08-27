/**
 * bidirectional-likelihood.ts — v2.6.4 V-02: 双向似然判据接口（诊断因子注册）
 *
 * 蓝图 `docs/p0/blueprint-v264-20260826.md` V-02：
 *   双向似然（Binoculars 系）判据——与 sentenceEntropy 同级注册为诊断因子。
 *   输入文本对 (a, b)，输出 LLR（对数似然比）+ 降级语义。
 *
 * ADR-19 边界（7 团队共识）：
 *   - 本模块为**接口预留 + 纯函数计算层**——LLR 数学计算可测（手工 logits fixture）
 *   - 模型调用（正向/反向条件似然）由调用方注入（离线诊断因子，不进主链门控）
 *   - 无模型时降级：model_available=false / score=null / fallback_reason / degraded 位
 *
 * 执行纪律:
 *   - 零 LLM 推断（模型句柄注入）；零 IO；Draft-first
 */

// ============================================================================
// 类型定义
// ============================================================================

/** 双向似然输入（文本对 + 模型句柄）。 */
export interface BidirectionalLikelihoodInput {
  /** 文本 a（如原文）。 */
  textA: string
  /** 文本 b（如改写后）。 */
  textB: string
  /** 模型句柄（调用方注入——离线诊断用；null = 无模型）。 */
  model: BidirectionalModel | null
}

/** 模型句柄契约（调用方实现——本模块不实现模型调用）。 */
export interface BidirectionalModel {
  /** 正向条件对数似然（模型生成文本的似然）。 */
  forwardLogLikelihood: (text: string) => number
  /** 反向/填空对数似然（Binoculars 式交叉视角）。 */
  backwardLogLikelihood: (text: string) => number
}

/** 双向似然判定结果。 */
export interface BidirectionalLikelihoodResult {
  /** 因子 id。 */
  factorId: "bidirectionalLikelihood"
  /** 对数似然比 LLR = LL_fwd(a) - LL_back(a)（正值 = 偏向 AI 采样）。 */
  llr: number | null
  /** 对称化聚合分（(LLR(a) + LLR(b)) / 2——文本对视角）。 */
  symmetricScore: number | null
  /** 模型可用性。 */
  modelAvailable: boolean
  /** 降级原因（modelAvailable=false 时必填）。 */
  fallbackReason?: string
  /** 降级位（true = 结果不可信，下游应保守处理）。 */
  degraded: boolean
}

// ============================================================================
// LLR 计算（纯函数——数学正确性可测）
// ============================================================================

/**
 * 计算单文本 LLR = forwardLL - backwardLL。
 * 纯数学：输入 logits 值，输出 LLR——不依赖模型实现。
 */
export function computeLLR(forwardLogLikelihood: number, backwardLogLikelihood: number): number {
  return forwardLogLikelihood - backwardLogLikelihood
}

/**
 * 对称化聚合：文本对 (a, b) 的 LLR 均值。
 * 纯数学：输入两个 LLR，输出对称分。
 */
export function symmetricAggregate(llrA: number, llrB: number): number {
  return (llrA + llrB) / 2
}

// ============================================================================
// 判定入口（降级语义）
// ============================================================================

/**
 * 双向似然判定：
 *   - 无模型 → model_available=false / llr=null / degraded=true / fallback_reason
 *   - 有模型 → 计算 LLR + 对称分（纯函数路径）
 */
export function evaluateBidirectionalLikelihood(input: BidirectionalLikelihoodInput): BidirectionalLikelihoodResult {
  if (input.model === null) {
    return {
      factorId: "bidirectionalLikelihood",
      llr: null,
      symmetricScore: null,
      modelAvailable: false,
      fallbackReason: "模型句柄未注入（离线诊断因子——ADR-19 机械层零 LLM）",
      degraded: true,
    }
  }
  const llrA = computeLLR(
    input.model.forwardLogLikelihood(input.textA),
    input.model.backwardLogLikelihood(input.textA),
  )
  const llrB = computeLLR(
    input.model.forwardLogLikelihood(input.textB),
    input.model.backwardLogLikelihood(input.textB),
  )
  return {
    factorId: "bidirectionalLikelihood",
    llr: llrA,
    symmetricScore: symmetricAggregate(llrA, llrB),
    modelAvailable: true,
    degraded: false,
  }
}

// ============================================================================
// 诊断因子注册（与 sentenceEntropy 同级——扩展点）
// ============================================================================

/** 诊断因子描述符（注册契约）。 */
export interface DiagnosticFactorDescriptor {
  id: string
  /** 权重（聚合器加权用——默认 1）。 */
  weight: number
  /** 计算签名（输入文本，输出证据）。 */
  compute: (text: string) => DiagnosticEvidence
  /** 依赖模型句柄（null = 无依赖）。 */
  modelDependency: boolean
}

/** 诊断证据（LLR 表达——正值 = 偏向 AI）。 */
export interface DiagnosticEvidence {
  factorId: string
  llr: number | null
  reliability: number
  degraded: boolean
  fallbackReason?: string
}

/** 因子注册表（纯内存——运行期注册/查询）。 */
export class DiagnosticFactorRegistry {
  private factors = new Map<string, DiagnosticFactorDescriptor>()

  /** 注册因子（重名拒绝）。 */
  register(descriptor: DiagnosticFactorDescriptor): boolean {
    if (this.factors.has(descriptor.id)) return false
    this.factors.set(descriptor.id, descriptor)
    return true
  }

  /** 注销因子。 */
  unregister(id: string): boolean {
    return this.factors.delete(id)
  }

  /** 查询因子。 */
  get(id: string): DiagnosticFactorDescriptor | undefined {
    return this.factors.get(id)
  }

  /** 枚举全部因子（按 id 字典序稳定）。 */
  list(): DiagnosticFactorDescriptor[] {
    return [...this.factors.values()].sort((a, b) => (a.id < b.id ? -1 : 1))
  }

  /** 因子数。 */
  get size(): number {
    return this.factors.size
  }
}
