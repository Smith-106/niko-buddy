/**
 * domain-drift-baseline.ts — v2.6.11 D1: 域漂移基准（三元组锚定 + ±σ 硬基线）
 *
 * 蓝图 `docs/p0/blueprint-v2611-20260828.md` D1：
 *   - key=(章次,模型,提示词) 三元组版本锚定（防漂移门无参照系）
 *   - cosine/KL 距离（哈希+距离——零 LLM）
 *   - 训练分布 ±σ 硬基线（超阈即漂）
 *
 * 执行纪律: ADR-19 零 LLM / 零 IO；纯函数
 */

// ============================================================================
// 域漂移基准（三元组锚定）
// ============================================================================

/** 基准锚定三元组（章次×模型×提示词——版本锚定）。 */
export interface DriftAnchorKey {
  chapter: number
  model: string
  prompt: string
}

/** 分布指纹（特征向量——确定性）。 */
export interface DistributionFingerprint {
  /** 特征均值向量。 */
  mean: number[]
  /** 特征标准差向量。 */
  std: number[]
  /** 样本数。 */
  n: number
}

/** 漂移量（cosine/KL 距离——超阈即漂）。 */
export interface DriftResult {
  /** 漂移量（0-1——cosine 距离）。 */
  drift: number
  /** 是否超阈（>训练分布 ±σ）。 */
  drifted: boolean
}

/** 漂移阈值系数（训练分布 ±σ 硬基线）。 */
export const DRIFT_SIGMA = 1.0

/**
 * 构建分布指纹（纯函数——确定性）。
 * 输入：特征样本集；输出：均值/标准差指纹。
 */
export function buildFingerprint(samples: number[][]): DistributionFingerprint {
  if (samples.length === 0) return { mean: [], std: [], n: 0 }
  const dims = samples[0].length
  const mean = new Array<number>(dims).fill(0)
  for (const s of samples) {
    for (let d = 0; d < dims; d++) mean[d] += s[d]
  }
  for (let d = 0; d < dims; d++) mean[d] /= samples.length
  const std = new Array<number>(dims).fill(0)
  for (const s of samples) {
    for (let d = 0; d < dims; d++) std[d] += (s[d] - mean[d]) ** 2
  }
  for (let d = 0; d < dims; d++) std[d] = Math.sqrt(std[d] / samples.length)
  return { mean, std, n: samples.length }
}

/**
 * 漂移检测（纯函数——确定性）。
 * 输入：基线指纹 + 当前特征；输出：cosine 距离 + 超阈判定（±σ 硬基线）。
 */
export function detectDrift(baseline: DistributionFingerprint, current: number[]): DriftResult {
  if (baseline.mean.length === 0 || current.length === 0) return { drift: 0, drifted: false }
  // cosine 距离（1 - cosine 相似度）
  let dot = 0
  let normA = 0
  let normB = 0
  for (let d = 0; d < current.length; d++) {
    dot += baseline.mean[d] * current[d]
    normA += baseline.mean[d] ** 2
    normB += current[d] ** 2
  }
  const cosine = normA === 0 || normB === 0 ? 0 : dot / (Math.sqrt(normA) * Math.sqrt(normB))
  const drift = 1 - cosine
  // 超阈判定：漂移 > 基线 σ 的 DRIFT_SIGMA 倍
  const baselineSigma = baseline.std.reduce((a, b) => a + b, 0) / Math.max(baseline.std.length, 1)
  const threshold = Math.min(1, baselineSigma * DRIFT_SIGMA + 0.05)
  return { drift, drifted: drift > threshold }
}

/** 三元组锚定校验（纯函数——确定性）。 */
export function verifyAnchorKey(key: DriftAnchorKey): boolean {
  return key.chapter > 0 && key.model.length > 0 && key.prompt.length > 0
}
