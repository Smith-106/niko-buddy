import { estimateCompactTokens } from "./context-compact"

/**
 * §GAP-89-02 口径统一：委托 context-compact.ts 的 CJK 估算器
 * （中文 ≈1.5 字符/token，与 contextPackToPrompt 内联公式同源——
 * ainovel CJK token 估算模式：中文按 runes×1.5，不用 bytes/4 低估）。
 *
 * 旧实现（nonAscii 1:1 + ascii/4）对中文 prose 的既有断言逐字成立
 * （见 token-estimator.spec.ts：同一输入两口径同值）；新口径额外修正
 * 非 CJK 非 ASCII（emoji/杂类符号）被 1:1 高估的问题（改按 /4）。
 * 生产调用方仅 spec（零生产依赖），切换零回归面。
 */
export function estimateContextTokens(text: string): number {
  return estimateCompactTokens(text)
}
