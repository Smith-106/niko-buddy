// MIT License - Copyright (c) 2026 Niko Buddy Contributors
// SPDX-License-Identifier: MIT

/** 设置页数字输入的纯函数：解析文本并夹到范围内。 */

/** 解析并夹到 [min, max]；空串或非数字返回 null（交给调用方回退）。integer 为 true 时四舍五入取整。 */
export function parseClampedNumber(raw: string, min: number, max: number, integer: boolean): number | null {
  const trimmed = raw.trim()
  if (trimmed === "") return null
  const n = Number(trimmed)
  if (!Number.isFinite(n)) return null
  const v = integer ? Math.round(n) : n
  return Math.max(min, Math.min(max, v))
}

/**
 * 输入过程中是否标红：只看是否超过上限。
 * 低于下限可能只是没输完（想输 18 先敲 1），不标红；
 * 超过上限再多敲也只会更大，提前提示。失焦时统一夹值，不会留下红框。
 */
export function exceedsMax(raw: string, max: number): boolean {
  const trimmed = raw.trim()
  if (trimmed === "") return false
  const n = Number(trimmed)
  return Number.isFinite(n) && n > max
}

/** 整数版。 */
export function parseClampedInt(raw: string, min: number, max: number): number | null {
  return parseClampedNumber(raw, min, max, true)
}

/** 小数版（权重类字段）。 */
export function parseClampedDecimal(raw: string, min: number, max: number): number | null {
  return parseClampedNumber(raw, min, max, false)
}
