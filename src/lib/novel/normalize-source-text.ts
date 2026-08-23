/**
 * normalize-source-text.ts —— 统一字符归一入口 (roadmap A4, 质检公平性窗口)
 *
 * 职责: 为「检测/索引视图」提供一致的文本归一原语; 不用于改写正文存储。
 *  - normalizeText: 零宽剥离 + CJK 同形字还原 (自 mechanical-slop-detector 提升, ABI 兼容)
 *  - normalizeSourceText: NFKC + 软连字符剥离 + normalizeText (检测视图统一入口)
 *
 * NFKC 与「中文标点归一」警示的关系 (DEBT-a4-01c):
 *   normalizeSourceText 的 NFKC 会把全角标点 (：；，。！？（）…—、) 也转成半角/ASCII。
 *   这条「全角标点→ASCII」转换 **只发生在检测/索引视图的只读副本**上 —— 本函数返回的
 *   text 只交给 slopScore / detectCharacterActions 等检测器做匹配, 绝不回写正文存储
 *   (chapter body / 正式记忆)。因此它与「勿引入中文标点→英文归一 (flagdata 取向, 毁文风)」
 *   的警示 **不矛盾**: 警示禁止的是把归一后的半角标点落盘进书稿; 检测视图副本用完即弃。
 *   任何把 normalizeSourceText 的返回值写回持久化正文的调用方都是误用, 须在 code review
 *   拦截 (见 docs/decision-log)。正文存储统一真源仍是 draft-first accept 后的原始字节。
 *
 * @license MIT © QMAI
 */

/** 零宽字符正则: ZWSP U+200B / ZWNJ U+200C / ZWJ U+200D / WORD JOINER U+2060 / BOM U+FEFF */
const ZERO_WIDTH_RE = /[\u200B-\u200D\u2060\uFEFF]/g

/**
 * C2 (roadmap batch C2): 「生僻混淆同形字」键集 — 仅这些键计入 homoglyphCount /
 * bypassCount 作为 AI-humanizer 旁路信号。
 *
 * 口径 (roadmap C2 重定义): CJK_HOMOGLYPH_MAP 里绝大多数键是常见「繁简互转字」
 * (裡/說/時間/們/話…) 或全角→半角 (０-９) —— 这些是**合法**繁体/全角叙事文本,
 * 不是 AI 旁路。若把它们也累加进 homoglyphCount, 会把纯繁体段落误判为
 * 「humanizer 绕过痕迹」从而抬高 AI 信号。故只把**真正的生僻混淆字** (西里尔
 * 同形字母 — 人类正常写作不会出现) 归入本集合计数; 文本还原仍走全表映射。
 */
const SUSPICIOUS_HOMOGLYPH_KEYS: ReadonlySet<string> = new Set<string>([
  // 西里尔字母与拉丁字母的同形 — AI-humanizer 用西里尔替换拉丁/ASCII 绕过精确检测。
  // 子集取自 avoid-ai-writing patterns.cjs 的 CYRILLIC_LOOKALIKES (vendored)。
  "а", "е", "о", "р", "с", "х", "у", "к", "м", "н", "в", "т",
  "А", "Е", "О", "Р", "С", "Х", "У", "К", "М", "Н", "В", "Т",
])

export { SUSPICIOUS_HOMOGLYPH_KEYS }

/**
 * CJK 同形字/相似字符映射 (中文语境常见 AI-humanizer 绕过: 用异体字/生僻字替换
 * 常见汉字, 使精确字符串检测失效)。子集参考 avoid-ai-writing CYRILLIC_LOOKALIKES 的
 * 中文版: 既映射高频叙事常用字的常见异体/繁简互转 (纯供文本还原), 也映射西里尔
 * 同形 (见 SUSPICIOUS_HOMOGLYPH_KEYS —— 且只这类计入 bypass 信号)。
 */
const CJK_HOMOGLYPH_MAP: Readonly<Record<string, string>> = {
  // 全角 → 半角 (数字/字母/标点混淆)
  "０": "0", "１": "1", "２": "2", "３": "3", "４": "4",
  "５": "5", "６": "6", "７": "7", "８": "8", "９": "9",
  // 异体字/繁简互转字 → 常用字 (叙事高频, 纯还原不计数)
  "裡": "里", "裏": "里", "牠": "它", "妳": "你", "妳們": "你们",
  "的確": "的确", "彷彿": "仿佛", "傢伙": "家伙", "因為": "因为",
  "已經": "已经", "認識": "认识", "時間": "时间", "媽媽": "妈妈",
  "父親": "父亲", "母親": "母亲", "聲音": "声音", "樣": "样",
  "邊": "边", "隻": "只", "雙": "双", "無": "无", "們": "们",
  "說": "说", "話": "话", "書": "书", "讀": "读", "寫": "写",
  "車": "车", "門": "门", "問": "问", "開": "开", "關": "关",
  "點": "点", "頭": "头", "體": "体", "鳥": "鸟", "馬": "马",
  "魚": "鱼", "鳥瞰": "鸟瞰",
  // 西里尔同形 (suspicious) — 计入 homoglyphCount/bypassCount
  "а": "a", "е": "e", "о": "o", "р": "p", "с": "c", "х": "x",
  "у": "y", "к": "k", "м": "m", "н": "h", "в": "b", "т": "t",
  "А": "A", "Е": "E", "О": "O", "Р": "P", "С": "C", "Х": "X",
  "У": "Y", "К": "K", "М": "M", "Н": "H", "В": "B", "Т": "T",
}

/** 同形字符集: 收集映射中所有键, 构正则一次 */
const CJK_HOMOGLYPH_KEYS = Object.keys(CJK_HOMOGLYPH_MAP).sort((a, b) => b.length - a.length)
const CJK_HOMOGLYPH_RE = new RegExp(`(${CJK_HOMOGLYPH_KEYS.map(k => k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`, "g")

/**
 * normalizeText 结果: 剥离/还原后的文本 + 被剥离的防绕过字符计数。
 * 调用方可用 bypassCount 作为额外的 AI 信号 (humanizer 旁路痕迹)。
 */
export interface NormalizeTextResult {
  text: string
  /** 剥离的零宽字符数 */
  zeroWidthCount: number
  /** 还原的『生僻混淆同形字』字符数 (仅 SUSPICIOUS_HOMOGLYPH_KEYS 内键计入; 常见繁简互转/全角不计数) */
  homoglyphCount: number
  /** 总防绕过字符数 (zeroWidth + homoglyph) */
  bypassCount: number
}

/**
 * 防绕过预处理: 剥离零宽字符 + 还原 CJK 同形字。
 * 零宽字符是 AI-humanizer 工具的常见旁路 (把 \u200B 插入词中使精确匹配失效);
 * 同形字 (异体字/全角) 同样使词库精确匹配失效。检测前先归一, 词库正则才能命中。
 * S1a absorb: 思路来自 avoid-ai-writing patterns.cjs normalizeText (已 vendored)。
 */
export function normalizeText(rawText: string): NormalizeTextResult {
  if (!rawText) return { text: rawText, zeroWidthCount: 0, homoglyphCount: 0, bypassCount: 0 }
  let zeroWidthCount = 0
  let homoglyphCount = 0
  const strippedZeroWidth = rawText.replace(ZERO_WIDTH_RE, () => {
    zeroWidthCount++
    return ""
  })
  const normalized = strippedZeroWidth.replace(CJK_HOMOGLYPH_RE, (m) => {
    // C2: 只对真正的生僻混淆同形字 (西里尔同形) 计数 bypass 信号; 繁简互转/全角
    // 仅还原 (文本归一) 不计入 homoglyphCount, 避免把合法繁体文本误判为 AI 旁路。
    if (SUSPICIOUS_HOMOGLYPH_KEYS.has(m)) homoglyphCount++
    /* v8 ignore next */
    return CJK_HOMOGLYPH_MAP[m as keyof typeof CJK_HOMOGLYPH_MAP] ?? m
  })
  return {
    text: normalized,
    zeroWidthCount,
    homoglyphCount,
    bypassCount: zeroWidthCount + homoglyphCount,
  }
}

/**
 * 统一归一入口 (A4): NFKC → 软连字符剥离(U+00AD) → 零宽剥离 → 同形字还原。
 * 仅用于检测/索引视图; 返回与 normalizeText 同形的计数结构。
 */
export function normalizeSourceText(rawText: string): NormalizeTextResult {
  if (!rawText) return { text: rawText, zeroWidthCount: 0, homoglyphCount: 0, bypassCount: 0 }
  const nfkc = rawText.normalize("NFKC")
  const noSoftHyphen = nfkc.replace(/\u00AD/g, "")
  return normalizeText(noSoftHyphen)
}
