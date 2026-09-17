/**
 * lambda-calibration.ts — B2 λ 标定纯函数面（批准计划 r3 §T4）。
 *
 * 语义（与 retrieval-budget.ts 的 λ 口径对齐）：
 *   MMR 净增益(pp) = 簇内 top3 增益(pp) − p95 延迟增量(ms) / λ(ms_per_pp)
 *   → 无差异点（净增益 = 0）时 Δms = λ · Δpp，故以 **y = Δms(ms) 对 x = Δpp(pp) 的
 *     最小二乘斜率**为 λ 估计（单位 ms_per_pp 自洽）。
 *
 * 硬边界（ADR-19 机械层）：
 *   - 纯函数：零 IO / 零时钟 / 零模型调用；zod strict 校验；
 *   - **只产出证据**：本模块不写 λ 默认值、不翻 `calibrated`、不改 R2 阈值。
 *     `RETRIEVAL_LAMBDA_INITIAL.calibrated` 恒 false（由 spec 断言锁死）。
 *   - 点数 < 30 直接抛错（硬校验不降级）；x 方差为 0（Δpp 全零）→ 无信号，pass=false。
 *
 * @license MIT © QMAI
 */
import { z } from "zod"

/** 拟合最小点数（治理口径：样本不足不得标定）。 */
export const LAMBDA_MIN_POINTS = 30

/** R² 门限（解释力下限；未达即「未达标」，**不放宽门限**）。 */
export const LAMBDA_R2_MIN = 0.5

/** 近零信号门限：非零 Δpp 占比 < 10% 时，斜率无判别基础（不可采信）。 */
export const LAMBDA_MIN_SIGNAL_RATIO = 0.1

export class LambdaCalibrationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "LambdaCalibrationError"
  }
}

/** 单个配对点：同一 query 的 Δ义务召回(pp) 与 Δ延迟(ms)。 */
export const LAMBDA_MEASUREMENT_SCHEMA = z
  .object({
    queryId: z.string().min(1),
    deltaPp: z.number().finite(),
    deltaMs: z.number().finite(),
  })
  .strict()

export type LambdaMeasurement = z.infer<typeof LAMBDA_MEASUREMENT_SCHEMA>

export const LAMBDA_CALIBRATION_INPUT_SCHEMA = z
  .object({
    measurements: z.array(LAMBDA_MEASUREMENT_SCHEMA),
    r2Min: z.number().min(0).max(1).optional(),
  })
  .strict()

/** 拟合失败理由码（可观测，不抛错以避免门控面崩溃）。 */
export const LAMBDA_FIT_REASON_SCHEMA = z.enum(["ok", "x_zero_variance", "r2_below_threshold"])
export type LambdaFitReason = z.infer<typeof LAMBDA_FIT_REASON_SCHEMA>

export interface LambdaFit {
  /** 配对点数。 */
  n: number
  /** 斜率 = λ 估计（ms_per_pp）。 */
  slope: number
  /** 截距（ms；理论值应近 0）。 */
  intercept: number
  /** 决定系数（x 方差为 0 时定义为 0）。 */
  r2: number
  /** 是否达标定门限（n ≥ 30 且 R² ≥ 门限）。 */
  pass: boolean
  reason: LambdaFitReason
  /** 非零 Δpp 的点数（信号量：全零即无判别信号）。 */
  signalPoints: number
}

/**
 * λ 最小二乘拟合（纯函数）。
 * @throws LambdaCalibrationError 输入 schema 非法或点数 < LAMBDA_MIN_POINTS
 */
export function fitLambda(input: z.input<typeof LAMBDA_CALIBRATION_INPUT_SCHEMA>): LambdaFit {
  const parsed = LAMBDA_CALIBRATION_INPUT_SCHEMA.safeParse(input)
  if (!parsed.success) {
    throw new LambdaCalibrationError(`λ 拟合输入非法：${parsed.error.message}`)
  }
  const { measurements } = parsed.data
  const r2Min = parsed.data.r2Min ?? LAMBDA_R2_MIN
  if (measurements.length < LAMBDA_MIN_POINTS) {
    throw new LambdaCalibrationError(
      `λ 拟合点数不足：n=${measurements.length} < ${LAMBDA_MIN_POINTS}（样本不足不得标定）`,
    )
  }
  const n = measurements.length
  const meanX = measurements.reduce((s, m) => s + m.deltaPp, 0) / n
  const meanY = measurements.reduce((s, m) => s + m.deltaMs, 0) / n
  let ssXX = 0
  let ssXY = 0
  let ssYY = 0
  for (const m of measurements) {
    const dx = m.deltaPp - meanX
    const dy = m.deltaMs - meanY
    ssXX += dx * dx
    ssXY += dx * dy
    ssYY += dy * dy
  }
  const signalPoints = measurements.filter((m) => m.deltaPp !== 0).length
  if (ssXX === 0) {
    // Δpp 全同（通常全零）：无法求解斜率 → 无信号，不构成标定
    return {
      n,
      slope: 0,
      intercept: meanY,
      r2: 0,
      pass: false,
      reason: "x_zero_variance",
      signalPoints,
    }
  }
  const slope = ssXY / ssXX
  const intercept = meanY - slope * meanX
  const r2 = ssYY === 0 ? 1 : 1 - (ssYY - slope * ssXY) / ssYY
  const pass = r2 >= r2Min
  return {
    n,
    slope,
    intercept,
    r2,
    pass,
    reason: pass ? "ok" : "r2_below_threshold",
    signalPoints,
  }
}

/** 人类可读拟合摘要（可观测输出；零副作用）。
 * 近零信号（非零 Δpp 占比 < 10%）时显式声明斜率不可采信——避免把噪声斜率当标定值读。 */
export function formatLambdaFit(fit: LambdaFit, r2Min = LAMBDA_R2_MIN): string {
  const signalRatio = fit.n === 0 ? 0 : fit.signalPoints / fit.n
  const unreliable = signalRatio < LAMBDA_MIN_SIGNAL_RATIO
  return [
    `λ-fit n=${fit.n} signal=${fit.signalPoints}/${fit.n}`,
    `slope=${fit.slope.toFixed(4)} ms_per_pp${unreliable ? "（不可采信：近零信号）" : ""} intercept=${fit.intercept.toFixed(4)} ms`,
    `r2=${fit.r2.toFixed(4)} 门限=${r2Min} verdict=${fit.pass ? "达门限" : `未达标(${fit.reason})`}`,
    "标定状态：calibrated=false（本证据不翻位，阈值 1000/1e4/30/0pp 不变）",
  ].join(" / ")
}
