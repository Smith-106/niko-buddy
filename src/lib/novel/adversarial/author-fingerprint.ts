/**
 * author-fingerprint.ts — v2.6.4 V-07: 原笔指纹基线（抽取纯函数）
 *
 * 蓝图 `docs/p0/blueprint-v264-20260826.md` V-07：
 *   作者写作指纹抽取（纯函数）+ 基线落库（不引入门逻辑）。
 *   用途：判官池漂移检测的「原笔」参照——作者风格基线 vs 判官评分锚点。
 *
 * 执行纪律:
 *   - ADR-19 零 LLM / 零 IO（抽取纯函数；落库由调用方）
 *   - Draft-first
 */

// ============================================================================
// 类型定义
// ============================================================================

/** 原笔指纹（抽取结果）。 */
export interface AuthorFingerprint {
  /** 平均句长（字符）。 */
  meanSentenceLength: number
  /** 句长标准差（句式多样性代理）。 */
  sentenceLengthStd: number
  /** 标点密度（每千字符标点数）。 */
  punctuationDensity: number
  /** 对话占比（引号内字符比例）。 */
  dialogueRatio: number
  /** 段落平均长度（字符）。 */
  meanParagraphLength: number
  /** 样本量（句子数）。 */
  sampleSize: number
}

// ============================================================================
// 抽取（纯函数）
// ============================================================================

/** 按中文标点切句（。！？；……）——纯函数。 */
export function splitSentences(text: string): string[] {
  return text
    .split(/[。！？；…]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
}

/** 抽取原笔指纹。 */
export function extractAuthorFingerprint(text: string): AuthorFingerprint {
  const sentences = splitSentences(text)
  const n = sentences.length
  if (n === 0) {
    return {
      meanSentenceLength: 0,
      sentenceLengthStd: 0,
      punctuationDensity: 0,
      dialogueRatio: 0,
      meanParagraphLength: 0,
      sampleSize: 0,
    }
  }
  const lengths = sentences.map((s) => s.length)
  const meanSentenceLength = lengths.reduce((a, b) => a + b, 0) / n
  const variance = lengths.reduce((a, l) => a + (l - meanSentenceLength) ** 2, 0) / n
  const sentenceLengthStd = Math.sqrt(variance)

  const punctuationCount = (text.match(/[，。！？；：、""''（）—…]/g) ?? []).length
  const punctuationDensity = (punctuationCount / Math.max(text.length, 1)) * 1000

  const dialogueChars = (text.match(/["""'][^""""']*["""']/g) ?? []).reduce((a, m) => a + m.length, 0)
  const dialogueRatio = dialogueChars / Math.max(text.length, 1)

  const paragraphs = text.split(/\n+/).filter((p) => p.trim().length > 0)
  const meanParagraphLength = paragraphs.length > 0
    ? paragraphs.reduce((a, p) => a + p.length, 0) / paragraphs.length
    : 0

  return {
    meanSentenceLength,
    sentenceLengthStd,
    punctuationDensity,
    dialogueRatio,
    meanParagraphLength,
    sampleSize: n,
  }
}

/**
 * 指纹漂移检测（纯函数）：当前指纹 vs 基线指纹的归一化偏差。
 * 返回 0-1 偏差（>0.3 触发重标定告警——7 团队共识阈值）。
 */
export function fingerprintDrift(current: AuthorFingerprint, baseline: AuthorFingerprint): number {
  if (baseline.sampleSize === 0) return 0
  const dims: Array<[number, number]> = [
    [current.meanSentenceLength, baseline.meanSentenceLength],
    [current.sentenceLengthStd, baseline.sentenceLengthStd],
    [current.punctuationDensity, baseline.punctuationDensity],
    [current.dialogueRatio, baseline.dialogueRatio],
    [current.meanParagraphLength, baseline.meanParagraphLength],
  ]
  const deviations = dims.map(([c, b]) => (b === 0 ? 0 : Math.abs(c - b) / Math.max(b, 1e-9)))
  return deviations.reduce((a, d) => a + d, 0) / deviations.length
}
