/**
 * style-scaffold.ts — v2.6.12 W4: 风格脚手架（静态签名 + 软约束注入）
 *
 * 蓝图 `docs/p0/blueprint-v2612-20260828.md` W4：
 *   - 可选+可关闭的风格骨架（语气/节奏/句式静态签名）
 *   - 不自动重写既有章节（软约束——防同质化）
 *
 * 执行纪律: ADR-19 零 LLM / 零 IO；纯函数
 */

// ============================================================================
// 风格脚手架（W4）
// ============================================================================

/** 风格签名（静态指纹——句长/对话密度/叙事节奏）。 */
export interface StyleSignature {
  /** 平均句长（字）。 */
  avgSentenceLength: number
  /** 对话密度（0-1）。 */
  dialogueDensity: number
  /** 叙事节奏（0-1——快节奏=高）。 */
  pacing: number
}

/** 脚手架结果。 */
export interface ScaffoldResult {
  /** 风格签名。 */
  signature: StyleSignature
  /** 软约束注入（可选+可关闭）。 */
  enabled: boolean
}

/**
 * 风格签名抽取（纯函数——确定性）。
 * 输入：已 accept 正文样本（句长/对话/节奏统计）；输出：静态签名。
 */
export function extractStyleSignature(
  samples: Array<{ sentenceLength: number; dialogue: boolean; fastPaced: boolean }>,
): StyleSignature {
  if (samples.length === 0) return { avgSentenceLength: 0, dialogueDensity: 0, pacing: 0 }
  const avgSentenceLength = samples.reduce((a, s) => a + s.sentenceLength, 0) / samples.length
  const dialogueDensity = samples.filter((s) => s.dialogue).length / samples.length
  const pacing = samples.filter((s) => s.fastPaced).length / samples.length
  return { avgSentenceLength, dialogueDensity, pacing }
}

/**
 * 脚手架注入（纯函数——确定性）。
 * 输入：签名 + 开关；输出：脚手架（enabled=false 时零注入——可选+可关闭）。
 */
export function buildScaffold(signature: StyleSignature, enabled: boolean): ScaffoldResult {
  return { signature, enabled }
}
