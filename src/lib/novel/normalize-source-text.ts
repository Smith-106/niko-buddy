/**
 * normalize-source-text.ts —— 统一字符归一入口 (roadmap A4, 质检公平性窗口)
 *
 * 职责: 为「检测/索引视图」提供一致的文本归一原语; 不用于改写正文存储。
 *  - normalizeText: 零宽剥离 + CJK 同形字还原 (自 mechanical-slop-detector 提升, ABI 兼容)
 *  - normalizeSourceText: NFKC + 软连字符剥离 + normalizeText (检测视图统一入口)
 *
 * 反例警示: 勿引入中文标点→英文归一 (flagdata 取向, 毁文风)。
 *
 * @license MIT © QMAI
 */

/** 零宽字符正则: ZWSP U+200B / ZWNJ U+200C / ZWJ U+200D / WORD JOINER U+2060 / BOM U+FEFF */
const ZERO_WIDTH_RE = /[\u200B-\u200D\u2060\uFEFF]/g

 /**
 * CJK 同形字/混淆字符映射 (中文语境常见 AI-humanizer 绕过: 用异体字/生僻字替换
 * 常见汉字, 使精确字符串检测失效)。子集参考 avoid-ai-writing CYRILLIC_LOOKALIKES
 * 思路的中文版: 只映射高频叙事常用字的常见异体/相似形。
  */
const CJK_HOMOGLYPH_MAP: Readonly<Record<string, string>> = {
  // 全角 → 半角 (数字/字母/标点混淆)
  "０": "0", "１": "1", "２": "2", "３": "3", "４": "4",
  "５": "5", "６": "6", "７": "7", "８": "8", "９": "9",
  // 异体字 → 常用字 (叙事高频)
  "裡": "里", "裏": "里", "牠": "它", "妳": "你", "妳們": "你们",
  "的確": "的确", "彷彿": "仿佛", "傢伙": "家伙", "因為": "因为",
  "已經": "已经", "認識": "认识", "時間": "时间", "媽媽": "妈妈",
  "父親": "父亲", "母親": "母亲", "聲音": "声音", "樣": "样",
  "邊": "边", "隻": "只", "雙": "双", "無": "无", "們": "们",
  "說": "说", "話": "话", "書": "书", "讀": "读", "寫": "写",
  "車": "车", "門": "门", "問": "问", "開": "开", "關": "关",
  "點": "点", "頭": "头", "體": "体", "鳥": "鸟", "馬": "马",
  "魚": "鱼", "鳥瞰": "鸟瞰",
 } as const

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
  /** 还原的同形字字符数 */
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
    homoglyphCount++
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
