/**
 * 55 号设计 W2-6 (B-03): 文本内自重复率 rep_2/3/4 (RLCracker 模式借鉴, Apache-2.0 只借模式)。
 *
 * rep_n = 1 − unique_n/total_n (n=2/3/4), diversity = Π(1−rep_n),
 * log_diversity = −log(max(1−div, e⁻²⁰))。纯 token 统计, 零 LLM。
 *
 * 中文无分词器 (无 jieba/Intl.Segmenter) → 按字 n-gram; 阈值必须经
 * anti-ai-thresholds.generated 基线归一化 + 百分位标定, 严禁直套英文阈值。
 * 初始权重 0 (不参与 ANTI_AI_COMBINED_FACTORS warn), 靠 anti-ai-shadow-telemetry
 * 旁路计量出标定值后再给权重。
 */

export interface SelfRepetitionResult {
  rep2: number
  rep3: number
  rep4: number
  diversity: number
  logDiversity: number
}

function charNGrams(text: string, n: number): string[] {
  const chars = Array.from(text.replace(/\s+/g, ""))
  if (chars.length < n) return []
  const out: string[] = []
  for (let i = 0; i <= chars.length - n; i += 1) {
    out.push(chars.slice(i, i + n).join(""))
  }
  return out
}

function repN(ngrams: string[]): number {
  if (ngrams.length === 0) return 0
  const unique = new Set(ngrams).size
  return 1 - unique / ngrams.length
}

/**
 * 计算文本内自重复率 (按字 n-gram)。
 * 空/过短文本 → 全 0 (零开销路径)。
 */
export function computeSelfRepetition(text: string): SelfRepetitionResult {
  const rep2 = repN(charNGrams(text, 2))
  const rep3 = repN(charNGrams(text, 3))
  const rep4 = repN(charNGrams(text, 4))
  if (rep2 === 0 && rep3 === 0 && rep4 === 0) {
    return { rep2: 0, rep3: 0, rep4: 0, diversity: 0, logDiversity: 0 }
  }
  const diversity = Math.max(0, (1 - rep2) * (1 - rep3) * (1 - rep4))
  const logDiversity = -Math.log(Math.max(1 - diversity, Math.exp(-20)))
  return { rep2, rep3, rep4, diversity, logDiversity }
}
