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
 *
 * 64 号实施（63 号共识 §6 缺口 10）：zero-LLM 查询分解（fidelis 模式）——
 * 查询分类/verbatim 前置闸门/子查询分解，全部确定性纯函数零 LLM，与既有
 * BM25 评分拼成纯本地检索路径。
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

// ============================================================================
// 64 号实施（63 号共识 §6 缺口 10）：zero-LLM 查询分解（fidelis 模式吸收）
// ============================================================================

/**
 * 查询分解结果：verbatim 字面量 / 实体提及 / 残查询。
 * 纯函数零 LLM：引号提取 + 实体前缀识别 + 残查询裁剪。
 */
export interface QueryDecomposition {
  original: string
  /** 引号字面量（「」“”『』"" 提取，长度≥1 的非空白串）。 */
  verbatim: string[]
  /** 实体前缀提及（character:/location:/item: 前缀标记，或已知别名命中）。 */
  entityMentions: string[]
  /** 实体分面（最多各 1）。 */
  facets: { character?: string; location?: string; item?: string }
  /** 去除 verbatim/实体后的残查询（空白归一）。 */
  rest: string
}

const QUOTE_PAIRS: Array<[string, string]> = [
  ["「", "」"],
  ["“", "”"],
  ["『", "』"],
  ['"', '"'],
]

const ENTITY_PREFIXES: Array<[keyof QueryDecomposition["facets"], string]> = [
  ["character", "character:"],
  ["location", "location:"],
  ["item", "item:"],
]

/**
 * 分解查询为 verbatim 字面量 + 实体提及 + 残查询。
 * 确定性：同输入同输出；无引号/实体时 rest 为原始查询。
 */
export function decomposeNovelQuery(
  query: string,
  opts: { aliases?: ReadonlyMap<string, string> } = {},
): QueryDecomposition {
  const original = query
  let work = query
  const verbatim: string[] = []

  // 引号字面量提取（支持四组引号；括号内不得含嵌套同组引号）
  for (const [open, close] of QUOTE_PAIRS) {
    for (;;) {
      const start = work.indexOf(open)
      if (start === -1) break
      const end = work.indexOf(close, start + open.length)
      if (end === -1) break
      const literal = work.slice(start + open.length, end).trim()
      if (literal) verbatim.push(literal)
      work = work.slice(0, start) + " " + work.slice(end + close.length)
    }
  }

  // 实体前缀提及 + 别名命中
  const entityMentions: string[] = []
  const facets: QueryDecomposition["facets"] = {}
  for (const [facet, prefix] of ENTITY_PREFIXES) {
    // 实体名：中文/字母数字/下划线，非贪婪；不跨连接词（和/与/及/在/的/和空白）
    const re = new RegExp(prefix + "([^\\s和与及在的,，。！？、:：]{1,24})", "g")
    let m: RegExpExecArray | null
    while ((m = re.exec(work)) !== null) {
      const name = m[1]
      entityMentions.push(prefix + name)
      if (!facets[facet]) facets[facet] = name
      work = work.replace(m[0], " ")
    }
  }
  if (opts.aliases) {
    for (const [alias, canon] of opts.aliases) {
      if (alias && work.includes(alias)) {
        entityMentions.push(`character:${canon}`)
        if (!facets.character) facets.character = canon
        work = work.split(alias).join(" ")
      }
    }
  }

  const rest = work.replace(/\s+/g, " ").trim()
  return { original, verbatim, entityMentions, facets, rest }
}

/**
 * 查询意图分类（确定性规则表，零 LLM）：
 * - verbatim_lookup：存在 verbatim 字面量 → 字面量精确查找优先
 * - entity_fact：存在实体分面 → 实体事实查询
 * - continuity_check：残查询含时序词 → 连续性核查
 * - style_lookup：含风格/文风词 → 风格查询
 * - scene_search：其余 → 场景/剧情搜索
 */
export type QueryIntent =
  | "verbatim_lookup"
  | "entity_fact"
  | "continuity_check"
  | "style_lookup"
  | "scene_search"

export function classifyNovelIntent(d: QueryDecomposition): QueryIntent {
  if (d.verbatim.length > 0) return "verbatim_lookup"
  if (d.facets.character || d.facets.location || d.facets.item) return "entity_fact"
  const r = d.rest
  if (/(之前|之后|后来|先|顺序|几天前|何时|哪一(chapter|章)|时序)/.test(r)) return "continuity_check"
  if (/(文风|风格|写法|口吻|笔触|腔调)/.test(r)) return "style_lookup"
  return "scene_search"
}

/**
 * 查询计划：intent + 分解 + 分支路由剪枝 + verbatim 前置闸门结果。
 * 纯函数零 LLM；verbatim 闸门：字面量逐条对 corpusTitles 做精确子串匹配，
 * 全部命中 → pass（keyword 保底直出）；部分/未命中 → 普通路径。
 */
export interface QueryPlan {
  intent: QueryIntent
  decomposition: QueryDecomposition
  /** 各分支是否参与检索（按 intent 剪枝）。 */
  route: { keyword: boolean; vector: boolean; canon: boolean; graph: boolean; recentChapters: boolean }
  verbatimGate: { pass: boolean; hits: string[]; missed: string[] }
}

export function buildQueryPlan(
  query: string,
  corpusTitles?: ReadonlySet<string>,
): QueryPlan {
  const decomposition = decomposeNovelQuery(query)
  const intent = classifyNovelIntent(decomposition)

  let route: QueryPlan["route"]
  switch (intent) {
    case "verbatim_lookup":
      route = { keyword: true, vector: false, canon: true, graph: false, recentChapters: true }
      break
    case "entity_fact":
      route = { keyword: true, vector: true, canon: true, graph: true, recentChapters: false }
      break
    case "continuity_check":
      route = { keyword: true, vector: true, canon: true, graph: false, recentChapters: true }
      break
    case "style_lookup":
      route = { keyword: true, vector: false, canon: false, graph: false, recentChapters: false }
      break
    default:
      route = { keyword: true, vector: true, canon: true, graph: true, recentChapters: true }
  }

  // verbatim 前置闸门
  const hits: string[] = []
  const missed: string[] = []
  if (corpusTitles) {
    for (const v of decomposition.verbatim) {
      const found = [...corpusTitles].some((t) => t.includes(v) || v.includes(t))
      if (found) hits.push(v)
      else missed.push(v)
    }
  }
  const pass = decomposition.verbatim.length > 0 && hits.length === decomposition.verbatim.length

  return { intent, decomposition, route, verbatimGate: { pass, hits, missed } }
}
