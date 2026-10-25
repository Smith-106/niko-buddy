/**
 * ISS-20260708-002：字符串空守卫公共收敛点。
 *
 * 收敛前三处重复内联：
 * - `has-usable-llm.ts:isNonEmpty` — `typeof value === "string" && value.trim().length > 0`
 * - `llm-health.ts:isBlank` — `!s || s.trim().length === 0`
 * - `preset-resolver.ts:hasAnthropicApiKey` — 同模板 trim().length 判定 + env 回退
 *
 * 本模块为唯一真源；三处调用方均委托至此，语义零变更。
 * MIT License — independently implemented.
 */

/** True 当值为非空、去空白后仍有内容（仅 string 视为有效）。 */
export function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0
}

/** isNonEmptyString 的严格取反（含非 string 输入视为 blank）。 */
export function isBlankString(value: unknown): boolean {
  return !isNonEmptyString(value)
}
