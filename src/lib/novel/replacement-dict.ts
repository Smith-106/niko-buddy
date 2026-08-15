/**
 * replacement-dict.ts — S1b absorb: character-arc humanizer-zh 替换字典
 * (roadmap S1 P1 机械层 · R03 中文机械层防绕过+替换字典)
 *
 * 来源 (reference/ 只读): character-arc/resources/skills/community-skills/
 *   humanizer-zh/references/replacement-dict.md — 纯数据字典 (Markdown 表),
 *   非可执行代码。本模块将其转为 TS 数据, 供 format-normalizer / de-ai 机械层
 *   替换使用。文档声称 148 短语 + 105 词汇 + 19 口语化, 但可获取文件为"摘录"
 *   (30 短语 + 30 词汇 + 19 口语化) — 只迁移可获取部分, 不虚构缺失条目。
 *
 * 使用纪律 (draft-first 安全边界):
 *   - 替换文本必须先进 pending/ready 草稿, 用户 accept 后才回填正式正文
 *   - 替换优先于惩罚: 若替换词命中 TIER 词库 (如 "然而"→"但是", 二者都在
 *     TIER2_SUSPICIOUS), 替换后的文本不再对已替换原词计惩罚 — 由调用方在
 *     slop 检测前应用替换, 白名单豁免逻辑在 format-normalizer 处理。
 *   - 保留口癖约束: 口语化替换只对书面语触发, 不强制替换对话内自然口语。
 */

export interface ReplacementEntry {
  /** 原短语/原词 (触发替换的文本) */
  from: string
  /** 替换选项 (按优先级排序; 调用方可按上下文选择或轮换) */
  to: string[]
  /** true 表示该条目建议直接删除而非替换 (humanizer-zh "（删除）") */
  deleteInstead?: boolean
}

/**
 * AI 套话/结构/元叙述/指纹词 — 直接删除清单
 * (humanizer-zh 第一层 23 条禁止模式中的可删除项; 与 mechanical-slop-detector
 * TIER1 词库互补 — 检测层罚分, 替换层删除/替换)
 */
export const DELETE_ON_SIGHT: readonly string[] = [
  "值得注意的是", "需要指出的是", "众所周知", "不难发现",
  "综上所述", "总而言之", "总的来说",
  "毫无疑问", "不可否认", "显而易见",
  "在某种程度上", "从某种意义上说",
  "正如前文所述", "如上所述",
  "本章将讲述", "接下来我们看到", "让我们来看看", "读者可能会注意到",
  "全方位", "多维度", "深层次", "底层逻辑", "顶层设计",
  "赋能", "凸显", "彰显", "淋漓尽致", "不言而喻", "毋庸置疑",
] as const

/** 短语级替换 (humanizer-zh 第三层, 30 条摘录) */
export const PHRASE_REPLACEMENTS: readonly ReplacementEntry[] = [
  { from: "值得一提的是", to: ["有意思的是", "说来也巧"] },
  { from: "毫无疑问", to: ["显然", "明摆着"] },
  { from: "在某种程度上", to: ["多少", "算是"] },
  { from: "与此同时", to: ["这时候", "就在这时"] },
  { from: "不可否认", to: ["确实", "没错"] },
  { from: "事实上", to: ["其实", "说白了"] },
  { from: "从某种意义上说", to: ["换句话说", "说穿了"] },
  { from: "尽管如此", to: ["话虽这么说", "但是"] },
  { from: "换言之", to: ["也就是说", "简单来说"] },
  { from: "由此可见", to: ["所以", "这么看来"] },
  { from: "不言而喻", to: ["明摆着", "谁都看得出"] },
  { from: "归根结底", to: ["说到底", "根子上"] },
  { from: "众所周知", to: ["大家都知道"], deleteInstead: true },
  { from: "不难发现", to: ["一看就知道"], deleteInstead: true },
  { from: "令人印象深刻", to: ["挺厉害", "有两下子"] },
  { from: "引人注目", to: ["扎眼", "显眼"] },
  { from: "至关重要", to: ["关键", "要紧"] },
  { from: "与日俱增", to: ["越来越多", "一天比一天"] },
  { from: "截然不同", to: ["完全不一样", "天差地别"] },
  { from: "息息相关", to: ["有关系", "分不开"] },
  { from: "不约而同", to: ["一起", "同时"] },
  { from: "恍然大悟", to: ["明白了", "想通了"] },
  { from: "心旷神怡", to: ["舒坦", "痛快"] },
  { from: "迫不及待", to: ["急着", "等不及"] },
  { from: "不知所措", to: ["懵了", "不知道咋办"] },
  { from: "若有所思", to: ["想着什么", "出神"] },
  { from: "不由自主", to: ["忍不住", "没忍住"] },
  { from: "情不自禁", to: ["忍不住", "没控制住"] },
  { from: "理所当然", to: ["应该的", "本来就是"] },
  { from: "毫不犹豫", to: ["二话不说", "想都没想"] },
] as const

/** 词汇级替换 (humanizer-zh 第四层, 30 条摘录) */
export const WORD_REPLACEMENTS: readonly ReplacementEntry[] = [
  { from: "因此", to: ["所以", "于是"] },
  { from: "然而", to: ["但是", "可是", "不过"] },
  { from: "尽管", to: ["虽然", "哪怕"] },
  { from: "此外", to: ["另外", "还有"] },
  { from: "显然", to: ["明显", "一看就"] },
  { from: "迅速", to: ["赶紧", "麻利", "飞快"] },
  { from: "缓慢", to: ["慢吞吞", "磨蹭"] },
  { from: "愤怒", to: ["火大", "来气", "窝火"] },
  { from: "悲伤", to: ["难受", "心里堵"] },
  { from: "恐惧", to: ["发毛", "心里发慌"] },
  { from: "美丽", to: ["好看", "漂亮", "水灵"] },
  { from: "巨大", to: ["老大", "硕大"] },
  { from: "仿佛", to: ["好像", "像是"] },
  { from: "似乎", to: ["好像", "大概"] },
  { from: "忽然", to: ["猛地", "冷不丁"] },
  { from: "立刻", to: ["马上", "赶紧", "立马"] },
  { from: "注视", to: ["盯着", "瞅着"] },
  { from: "思考", to: ["琢磨", "寻思"] },
  { from: "感受", to: ["觉得", "感觉"] },
  { from: "认为", to: ["觉得", "寻思"] },
  { from: "决定", to: ["打定主意", "拿定主意"] },
  { from: "发现", to: ["看见", "注意到"] },
  { from: "表示", to: ["说", "道"] },
  { from: "进行", to: [], deleteInstead: true },
  { from: "实施", to: ["干", "搞", "做"] },
  { from: "目前", to: ["现在", "眼下"] },
  { from: "已然", to: ["已经", "都"] },
  { from: "亦", to: ["也", "同样"] },
  { from: "甚至", to: ["连", "居然"] },
  { from: "极其", to: ["特别", "贼", "老"] },
] as const

/** 口语化替换 (humanizer-zh 第五层, 19 条 — 完整) */
export const COLLOQUIAL_REPLACEMENTS: readonly ReplacementEntry[] = [
  { from: "非常", to: ["特别", "贼/老"] },
  { from: "可能", to: ["估计", "八成"] },
  { from: "应该", to: ["该", "得"] },
  { from: "已经", to: ["都", "早就"] },
  { from: "突然", to: ["猛地", "冷不丁"] },
  { from: "虽然", to: ["虽说", "话说回来"] },
  { from: "但是", to: ["可", "不过"] },
  { from: "如果", to: ["要是", "万一"] },
  { from: "因为", to: ["是因为", "就是"] },
  { from: "所以", to: ["所以说", "这才"] },
  { from: "或者", to: ["要不", "不然"] },
  { from: "什么", to: ["啥", "什么玩意"] },
  { from: "怎么", to: ["咋", "怎么着"] },
  { from: "这样", to: ["这么着", "就这样"] },
  { from: "那样", to: ["那么着", "那个样"] },
  { from: "不要", to: ["别", "甭"] },
  { from: "知道", to: ["晓得", "清楚"] },
  { from: "明白", to: ["懂", "整明白"] },
] as const

/** 全部替换条目 (短语+词汇+口语化), 供 format-normalizer 单次遍历 */
export const ALL_REPLACEMENTS: readonly ReplacementEntry[] = [
  ...PHRASE_REPLACEMENTS,
  ...WORD_REPLACEMENTS,
  ...COLLOQUIAL_REPLACEMENTS,
] as const

/** 按原文本构建查找索引 (短语优先于词, 长优先) */
export function buildReplacementIndex(
  entries: readonly ReplacementEntry[] = ALL_REPLACEMENTS,
): Map<string, ReplacementEntry> {
  const sorted = [...entries].sort((a, b) => b.from.length - a.from.length)
  return new Map(sorted.map((e) => [e.from, e]))
}

/** 条目统计 (供 spec/审计) */
export function replacementDictStats(): {
  phraseCount: number
  wordCount: number
  colloquialCount: number
  totalCount: number
  deleteCount: number
} {
  return {
    phraseCount: PHRASE_REPLACEMENTS.length,
    wordCount: WORD_REPLACEMENTS.length,
    colloquialCount: COLLOQUIAL_REPLACEMENTS.length,
    totalCount: ALL_REPLACEMENTS.length,
    deleteCount: ALL_REPLACEMENTS.filter((e) => e.deleteInstead).length,
  }
}
