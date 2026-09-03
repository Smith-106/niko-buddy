/**
 * R-inkos-4 (23-inkos-coverage roadmap P1): BM25 Ranking — 词项级精确评分.
 *
 * 吸收来源：reference/inkos packages/core/src/retrieval（SQLite FTS5/BM25
 * 关键词投影，与向量检索互补召回）— 23 号覆盖审计 2/3 absorb_now；实码校准
 * 确认 search-adapter 已有 keyword 召回分支（searchWiki，非算法评分）后，
 * 本模块补 BM25 算法级评分，作为 keyword 分支的排序增强（纯函数，可独立
 * 测试，未来可注入 search-adapter 排序）。
 *
 * 中文处理：无第三方分词依赖（桌面单机零外部服务纪律），采用字符 bigram +
 * ASCII 词元混合切分——中文信息检索的确定性基线做法。
 */

/** BM25 参数（标准默认：Okapi k1=1.5, b=0.75）。 */
export const BM25_K1 = 1.5
export const BM25_B = 0.75

export interface RankedDoc {
  id: string
  score: number
}

/**
 * 确定性中文/混合文本切分：连续 ASCII 字母数字串按词元保留（小写化），
 * 其余（CJK 等）按字符 bigram 切分（单字长度文本保留 unigram）。
 */
export function tokenizeForBm25(text: string): string[] {
  const tokens: string[] = []
  const asciiRuns = text.toLowerCase().match(/[a-z0-9]+/g) ?? []
  tokens.push(...asciiRuns)
  // 移除 ASCII run 后对剩余字符做 bigram，并同时收束单字 token：
  // 网文实体名常为单字（如「剑」），纯 bigram 下单字查询恒 0 分（GLM 终验 P1）；
  // 单字 token 的 IDF 偏低不影响多字查询区分度，但对单字查询恢复真实 BM25 排序。
  const cjk = text.replace(/[a-zA-Z0-9]+/g, "\u0000")
  const chars = [...cjk].filter((c) => c !== "\u0000" && /\S/.test(c))
  for (let i = 0; i < chars.length; i++) {
    if (i + 1 < chars.length) {
      tokens.push(chars[i] + chars[i + 1])
      tokens.push(chars[i])
    } else {
      tokens.push(chars[i])
    }
  }
  return tokens
}

export interface Bm25Doc {
  id: string
  text: string
}

/**
 * BM25 排序：对 docs 按 Okapi BM25 相对 query 评分，降序返回。
 * 确定性：同分按输入序稳定（sort 为稳定排序），零分文档仍返回（调用方可截断）。
 */
export function rankByBm25(
  query: string,
  docs: Bm25Doc[],
  opts: { k1?: number; b?: number } = {},
): RankedDoc[] {
  const k1 = opts.k1 ?? BM25_K1
  const b = opts.b ?? BM25_B
  const qTokens = tokenizeForBm25(query)
  if (qTokens.length === 0 || docs.length === 0) {
    return docs.map((d) => ({ id: d.id, score: 0 }))
  }

  const docTokens = docs.map((d) => tokenizeForBm25(d.text))
  const docLens = docTokens.map((t) => t.length)
  const avgLen =
    docLens.reduce((s, l) => s + l, 0) / Math.max(docLens.length, 1)
  const N = docs.length

  // df: 包含词项的文档数
  const df = new Map<string, number>()
  for (const tokens of docTokens) {
    const seen = new Set(tokens)
    for (const t of seen) df.set(t, (df.get(t) ?? 0) + 1)
  }
  const idf = (t: string): number => {
    const n = df.get(t) ?? 0
    return Math.log(1 + (N - n + 0.5) / (n + 0.5))
  }

  const scored = docs.map((d, i) => {
    const tf = new Map<string, number>()
    for (const t of docTokens[i]) tf.set(t, (tf.get(t) ?? 0) + 1)
    const len = docLens[i]
    let score = 0
    for (const q of new Set(qTokens)) {
      const f = tf.get(q) ?? 0
      if (f === 0) continue
      const denom = f + k1 * (1 - b + b * (len / avgLen))
      score += idf(q) * ((f * (k1 + 1)) / denom)
    }
    return { id: d.id, score }
  })

  return scored.sort((a, b2) => b2.score - a.score)
}
