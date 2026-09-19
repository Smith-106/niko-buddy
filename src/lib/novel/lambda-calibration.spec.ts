/**
 * lambda-calibration.spec.ts — B2 λ 标定纯函数面（批准计划 r3 §T4）。
 *
 * 断言面：
 *   1. 手算对照（最小二乘斜率的解析值）；
 *   2. n < 30 硬拒绝（不降级）；
 *   3. x 方差为 0（Δpp 全零）→ 无信号 pass=false，reason=x_zero_variance；
 *   4. R² 不足 → pass=false，reason=r2_below_threshold（不放宽门限）；
 *   5. 不翻位硬断言：RETRIEVAL_LAMBDA_INITIAL.calibrated === false 且 value=25，
 *      RETRIEVAL_LAMBDA_SCHEMA 形状不变；R2 阈值常量未被本模块改写。
 *
 * @license MIT © Niko Buddy
 */
import { describe, expect, it } from "vitest"
import { RETRIEVAL_LAMBDA_INITIAL, RETRIEVAL_LAMBDA_SCHEMA, LAMBDA_MS_PER_PP_INITIAL } from "./retrieval-budget"
import {
  LAMBDA_MIN_POINTS,
  LAMBDA_R2_MIN,
  LambdaCalibrationError,
  fitLambda,
  formatLambdaFit,
} from "./lambda-calibration"

/** 构造 n 个配对点：y = 2x 的完美线性（λ=2）+ 可选零信号点。 */
function perfectPair(n: number, slope = 2) {
  return Array.from({ length: n }, (_, i) => ({
    queryId: `q${i}`,
    deltaPp: i + 1,
    deltaMs: slope * (i + 1),
  }))
}

describe("B2 λ 标定纯函数（fitLambda）", () => {
  it("手算对照：完美线性 y=2x → slope=2、intercept=0、R²=1、pass", () => {
    const fit = fitLambda({ measurements: perfectPair(40, 2) })
    expect(fit.n).toBe(40)
    expect(fit.slope).toBeCloseTo(2, 10)
    expect(fit.intercept).toBeCloseTo(0, 10)
    expect(fit.r2).toBeCloseTo(1, 10)
    expect(fit.pass).toBe(true)
    expect(fit.reason).toBe("ok")
    expect(fit.signalPoints).toBe(40)
    expect(formatLambdaFit(fit)).toContain("verdict=达门限")
  })

  it("手算对照：含噪声时斜率为最小二乘解析值（不取平均比）", () => {
    // x = [1,2,3,4...30], y = 3x + 噪声交替 ±1 → 斜率应接近 3 且 R² 高
    const measurements = Array.from({ length: 30 }, (_, i) => ({
      queryId: `q${i}`,
      deltaPp: i + 1,
      deltaMs: 3 * (i + 1) + (i % 2 === 0 ? 1 : -1),
    }))
    const fit = fitLambda({ measurements })
    expect(fit.slope).toBeGreaterThan(2.9)
    expect(fit.slope).toBeLessThan(3.1)
    expect(fit.r2).toBeGreaterThan(0.99)
    expect(fit.pass).toBe(true)
  })

  it("点数硬校验：n < 30 抛错（不得降级标定）", () => {
    expect(() => fitLambda({ measurements: perfectPair(LAMBDA_MIN_POINTS - 1) })).toThrow(
      LambdaCalibrationError,
    )
    expect(LAMBDA_MIN_POINTS).toBe(30)
  })

  it("无信号：Δpp 全零 → pass=false / x_zero_variance（不伪造斜率）", () => {
    const measurements = Array.from({ length: 35 }, (_, i) => ({
      queryId: `q${i}`,
      deltaPp: 0,
      deltaMs: 1 + (i % 3),
    }))
    const fit = fitLambda({ measurements })
    expect(fit.slope).toBe(0)
    expect(fit.r2).toBe(0)
    expect(fit.pass).toBe(false)
    expect(fit.reason).toBe("x_zero_variance")
    expect(fit.signalPoints).toBe(0)
  })

  it("R² 不足 → pass=false / r2_below_threshold（门限不放宽）", () => {
    // x 与 y 无关（y 由 (i*7)%5 决定）→ R² ≈ 0
    const measurements = Array.from({ length: 40 }, (_, i) => ({
      queryId: `q${i}`,
      deltaPp: i + 1,
      deltaMs: ((i * 7) % 5) - 2,
    }))
    const fit = fitLambda({ measurements })
    expect(fit.r2).toBeLessThan(LAMBDA_R2_MIN)
    expect(fit.pass).toBe(false)
    expect(fit.reason).toBe("r2_below_threshold")
    expect(formatLambdaFit(fit)).toContain("未达标")
  })

  it("近零信号：非零 Δpp 占比 < 10% → slope 标注「不可采信」（不把噪声斜率当标定值）", () => {
    const measurements = [
      ...Array.from({ length: 40 }, (_, i) => ({ queryId: `z${i}`, deltaPp: 0, deltaMs: 1 + (i % 4) })),
      { queryId: "one", deltaPp: 100, deltaMs: 5 },
    ]
    const fit = fitLambda({ measurements })
    expect(fit.signalPoints).toBe(1)
    expect(fit.pass).toBe(false)
    expect(formatLambdaFit(fit)).toContain("不可采信")
    // 高信号面不得出现该标注
    expect(formatLambdaFit(fitLambda({ measurements: perfectPair(40, 2) }))).not.toContain("不可采信")
  })

  it("输入校验：schema strict（未知键/缺字段/非有限数均抛错）", () => {
    expect(() =>
      fitLambda({ measurements: [...perfectPair(30), { queryId: "x", deltaPp: 1, deltaMs: 2, extra: 1 }] as never }),
    ).toThrow(LambdaCalibrationError)
    expect(() => fitLambda({ measurements: [{ queryId: "x", deltaPp: Number.NaN, deltaMs: 1 }] } as never)).toThrow(
      LambdaCalibrationError,
    )
    expect(() => fitLambda({ measurements: [] })).toThrow(LambdaCalibrationError)
  })

  it("不翻位硬断言：λ 初值 calibrated=false / value=25ms_per_pp / schema 形状不变", () => {
    expect(RETRIEVAL_LAMBDA_INITIAL.calibrated).toBe(false)
    expect(RETRIEVAL_LAMBDA_INITIAL.value).toBe(25)
    expect(RETRIEVAL_LAMBDA_INITIAL.value).toBe(LAMBDA_MS_PER_PP_INITIAL)
    expect(RETRIEVAL_LAMBDA_INITIAL.unit).toBe("ms_per_pp")
    expect(Object.keys(RETRIEVAL_LAMBDA_SCHEMA.shape).sort()).toEqual([
      "basis",
      "calibrated",
      "unit",
      "value",
    ])
    // 拟合结果不得自动回写常量（fit 是值对象，无副作用面）
    const fit = fitLambda({ measurements: perfectPair(30, 99) })
    expect(fit.slope).toBeCloseTo(99, 8)
    expect(RETRIEVAL_LAMBDA_INITIAL.value).toBe(25)
    expect(RETRIEVAL_LAMBDA_INITIAL.calibrated).toBe(false)
  })
})
