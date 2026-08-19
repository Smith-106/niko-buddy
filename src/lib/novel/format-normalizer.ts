/**
 * format-normalizer.ts — S1b absorb: character-arc humanizer-zh 格式规范化 +
 * 替换执行器 (roadmap S1 P1 机械层 · R03 中文机械层防绕过+替换字典)
 *
 * 格式规则 (humanizer-zh 格式规范化表):
 *   - 对话引号统一为「」
 *   - 引用引号统一为『』
 *   - 省略号统一为 ……
 *   - 破折号统一为 ——
 *   - 年份/月日阿拉伯数字 → 中文 (一九八七年 / 三月十五日)
 *   - 感叹号每章 ≤5 个 (超出部分降级为句号)
 *   - 连续标点禁止 (！！！→！)
 *
 * 替换纪律:
 *   - 替换优先于惩罚: formatNormalize 先做替换, 再对替换结果做 slop 复检时,
 *     已替换的原词不再计罚 (原词已不存在); 若替换词本身命中 TIER 词库
 *     ("然而"→"但是", 二者均在 TIER2), 由调用方决定是否豁免 — 本模块提供
 *     REPLACEMENT_WHITELIST 供 de-ai 层对替换后文本豁免对应词。
 *   - draft-first: 本模块只产出规范化文本 (应写入 pending/ready 草稿),
 *     不直接回填正式正文。
 *   - 保留口癖: 口语化替换默认关闭 (enableColloquial=false), 避免强制改写对话。
 *
 * 零 LLM: 纯正则+算术, 与 mechanical-slop-detector 同一机械层。
 */

import { pangu } from "pangu"
import {
  ALL_REPLACEMENTS,
  DELETE_ON_SIGHT,
  ReplacementEntry,
  buildReplacementIndex,
} from "./replacement-dict"

// ============================================================================
// 格式规则常量
// ============================================================================

/** 感叹号上限: 每章 ≤5 (humanizer-zh 格式规范) */
export const MAX_EXCLAMATION_PER_CHAPTER = 5

/** 连续感叹号/问号等重复标点 → 单个 (禁止连续标点) */
const REPEATED_PUNCT_RE = /([！？。]){2,}/g

/** 半角感叹号/问号 → 全角 */
const HALF_PUNCT_RE = /[!?]{1,}/g

/** 省略号: .../… 变体 → …… (两个 U+2026) */
const ELLIPSIS_RE = /…{1,}|\.{3,}/g

/** 破折号: 单/双横线 → —— */
const DASH_RE = /[—–-]{2,}|—(?!—)/g

/** 阿拉伯数字年份 (4 位或 2 位年) */
const YEAR_RE = /(\d{4})年/g

/** 月日: M月D日 */
const MONTH_DAY_RE = /(\d{1,2})月(\d{1,2})日/g

// ============================================================================
// 中文数字转换 (年份/月日)
// ============================================================================

const CN_DIGITS = ["零", "一", "二", "三", "四", "五", "六", "七", "八", "九"] as const

/** 阿拉伯数字 → 中文数字 (简单直转, 支持 1-9999) */
export function arabicToChineseDigits(num: number): string {
  if (num < 0 || num > 9999 || !Number.isInteger(num)) return String(num)
  if (num === 0) return "零"
  // 10-99: 十进位; 100-999: 百进位; 1000-9999: 年份直读或千进位?
  // humanizer-zh 规范: 年份直读 (一九八七), 月日进位 (十五/二十)。
  // 本函数服务月日/年份两用: 年份走 formatYearToChinese (直读),
  // 月日走本函数 (进位)。
  if (num < 10) return CN_DIGITS[num]
  if (num < 100) {
    const tens = Math.floor(num / 10)
    const ones = num % 10
    return `${tens === 1 ? "" : CN_DIGITS[tens]}十${ones === 0 ? "" : CN_DIGITS[ones]}`
  }
  if (num < 1000) {
    const hundreds = Math.floor(num / 100)
    const rest = num % 100
    return `${CN_DIGITS[hundreds]}百${rest === 0 ? "" : arabicToChineseDigits(rest)}`
  }
  // 千位: 月日不涉及, 年份直读
  return String(num).split("").map((d) => CN_DIGITS[Number(d)]).join("")
}

/** 年份 1987 → 一九八七年; 2000 → 二零零零年 */
export function formatYearToChinese(year: number): string {
  if (year < 1000 || year > 9999) return String(year)
  return `${arabicToChineseDigits(year)}年`
}

/** 月日 3月15日 → 三月十五日 */
export function formatMonthDayToChinese(month: number, day: number): string {
  if (month < 1 || month > 12 || day < 1 || day > 31) return `${month}月${day}日`
  return `${arabicToChineseDigits(month)}月${arabicToChineseDigits(day)}日`
}

// ============================================================================
// 替换执行
// ============================================================================

export interface FormatNormalizeOptions {
  /** 启用口语化替换 (默认 false — 保留口癖约束, 不强制改写对话) */
  enableColloquial?: boolean
  /** 启用删除清单 (默认 true — AI 套话直接删除) */
  enableDeleteOnSight?: boolean
  /** 最大替换次数 (防无限/过度改写, 默认 200) */
  maxReplacements?: number
  /** 启用 pangu 中英文自动空格 (默认 false — 保向后兼容, 可选的排版增强) */
  enablePangu?: boolean
  /** 自定义替换索引 (默认 ALL_REPLACEMENTS) */
  replacements?: readonly ReplacementEntry[]
}

export interface FormatNormalizeResult {
  /** 规范化后的文本 */
  text: string
  /** 执行的替换/删除次数 */
  replacementCount: number
  /** 删除的套话数 */
  deleteCount: number
  /** 感叹号处理: 超过上限被降级的数量 */
  exclamationReduced: number
  /** 修复的连续标点数 */
  repeatedPunctFixed: number
  /** pangu 中英空格插入数 */
  panguSpaced: number
  /** 归一化的数字 (年/月日) 数 */
  numberNormalized: number
  /** 是否发生了任何改动 (供 draft-first 判断是否需草稿) */
  changed: boolean
}

/** 单次替换扫描: 返回替换后的文本与计数 (长优先, 不重叠替换) */
function applyReplacements(
  text: string,
  index: Map<string, ReplacementEntry>,
  options: Pick<FormatNormalizeOptions, "enableColloquial" | "maxReplacements">,
): { text: string; count: number; deleteCount: number } {
  let out = text
  let count = 0
  let deleteCount = 0
  const max = options.maxReplacements ?? 200
  const enableColloquial = options.enableColloquial ?? false

  // 按索引遍历 (已长优先排序)
  for (const entry of index.values()) {
    if (count >= max) break
    const from = entry.from
    // 口语化条目只在启用时生效
    const isColloquial = COLLOQUIAL_FROM.has(from)
    if (isColloquial && !enableColloquial) continue

    if (entry.deleteInstead) {
      let occurrences = 0
      const after = out.split(from).join("")
      occurrences = (out.match(new RegExp(escapeRegExp(from), "g")) ?? []).length
      if (occurrences > 0) {
        deleteCount += occurrences
        count += occurrences
        out = after
      }
      continue
    }

    const replacement = entry.to[0] ?? ""
    if (!replacement) continue
    if (!out.includes(from)) continue
    /* v8 ignore next */
    const occurrences = (out.match(new RegExp(escapeRegExp(from), "g")) ?? []).length
    const after = out.split(from).join(replacement)
    if (after !== out) {
      count += occurrences
      out = after
    }
  }
  return { text: out, count, deleteCount }
}

/** 口语化条目 from 集合 (用于开关) */
const COLLOQUIAL_FROM = new Set(
  ALL_REPLACEMENTS.slice(
    ALL_REPLACEMENTS.findIndex((e) => e.from === "非常"),
  ).map((e) => e.from),
)

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

/**
 * 引号成对规范化: 交替出现的弯引号/直角引号 → 「」/『』。
 * 开引号 (奇数位) → 「/『, 闭引号 (偶数位) → 」/』。
 * 兼容双弯 (“”), 单弯 (‘’), 直角 (「」『』)。
 */
function normalizeQuotes(text: string): string {
  let out = ""
  let doubleOpen = false
  let singleOpen = false
  for (const ch of text) {
    if (ch === "\u201C" || ch === "\u201D" || ch === "「" || ch === "」") {
      if (ch === "\u201D" || ch === "」") {
        if (doubleOpen) {
          out += "」"
          doubleOpen = false
        } else {
          out += "「"
          doubleOpen = true
        }
      } else {
        // 开引号: 若已在开状态则视为闭 (容错)
        out += doubleOpen ? "」" : "「"
        doubleOpen = !doubleOpen
      }
    } else if (ch === "\u2018" || ch === "\u2019" || ch === "『" || ch === "』") {
      if (ch === "\u2019" || ch === "』") {
        if (singleOpen) {
          out += "』"
          singleOpen = false
        } else {
          out += "『"
          singleOpen = true
        }
      } else {
        out += singleOpen ? "』" : "『"
        singleOpen = !singleOpen
      }
    } else {
      out += ch
    }
  }
  return out
}

/** 删除清单执行 (AI 套话直接删除) */
function applyDeleteOnSight(text: string): { text: string; count: number } {
  let out = text
  let count = 0
  for (const phrase of DELETE_ON_SIGHT) {
    if (!out.includes(phrase)) continue
    /* v8 ignore next */
    const occurrences = (out.match(new RegExp(escapeRegExp(phrase), "g")) ?? []).length
    out = out.split(phrase).join("")
    count += occurrences
  }
  return { text: out, count }
}

/**
 * 格式规范化 + 替换执行 (零 LLM)。
 * 顺序: 删除套话 → 替换字典 → 标点规范化 → 数字转中文 → 感叹号限额。
 * 输出应写入 pending/ready 草稿, 不直接回填正式正文 (draft-first)。
 */
export function formatNormalize(rawText: string, options: FormatNormalizeOptions = {}): FormatNormalizeResult {
  if (!rawText) {
    return { text: rawText, replacementCount: 0, deleteCount: 0, exclamationReduced: 0, repeatedPunctFixed: 0, panguSpaced: 0, numberNormalized: 0, changed: false }
  }

  let text = rawText
  let deleteCount = 0
  let exclamationReduced = 0
  let repeatedPunctFixed = 0
  let numberNormalized = 0
  let panguSpaced = 0

  // 1. 删除 AI 套话
  if (options.enableDeleteOnSight !== false) {
    const del = applyDeleteOnSight(text)
    text = del.text
    deleteCount = del.count
  }

  // 2. 替换字典 (短语+词汇, 可选口语化); deleteInstead 条目随 deleteOnSight 开关
  const index = options.replacements
    ? buildReplacementIndex(options.replacements)
    : buildReplacementIndex()
  const effectiveEntries = options.enableDeleteOnSight === false
    ? [...index.values()].filter((e) => !e.deleteInstead)
    : [...index.values()]
  const effectiveIndex = new Map(effectiveEntries.map((e) => [e.from, e]))
  const rep = applyReplacements(text, effectiveIndex, options)
  text = rep.text

  // 3. 连续标点修复 (！！！→！)
  const beforeRepeated = text
  text = text.replace(REPEATED_PUNCT_RE, (m) => m[0])
  repeatedPunctFixed = countDiff(beforeRepeated, text)

  // 4. 引号/省略号/破折号统一 (成对: 开引号→「 闭引号→」; 单引号同理 『』)
  text = normalizeQuotes(text)
  text = text.replace(ELLIPSIS_RE, "……")
  text = text.replace(DASH_RE, "——")

  // 5. 半角标点转全角
  text = text.replace(HALF_PUNCT_RE, (m) => (m.includes("?") ? "？" : "！"))

  // 6. 数字转中文 (年份/月日)
  let yearCount = 0
  let monthDayCount = 0
  text = text.replace(YEAR_RE, (_m, y: string) => {
    yearCount++
    return `${formatYearToChinese(Number(y))}`
  })
  text = text.replace(MONTH_DAY_RE, (_m, mo: string, d: string) => {
    monthDayCount++
    return formatMonthDayToChinese(Number(mo), Number(d))
  })
  numberNormalized = yearCount + monthDayCount

  // 7. 感叹号限额 (每章 ≤5, 超出降级为句号)
  const exclamationMatches = text.match(/！/g)
  if (exclamationMatches && exclamationMatches.length > MAX_EXCLAMATION_PER_CHAPTER) {
    // 保留前 5 个, 其余降级 (从后往前)
    let remaining = MAX_EXCLAMATION_PER_CHAPTER
    text = text.replace(/！/g, () => {
      if (remaining > 0) {
        remaining--
        return "！"
      }
      exclamationReduced++
      return "。"
    })
  }

  // 8. pangu 中英文自动空格 (可选, 默认关闭保向后兼容)
  if (options.enablePangu) {
    const before = text
    text = pangu.spacingText(text)
    if (text.length > before.length) {
      /* v8 ignore next -- pangu 只插入空格，text 必有空格，?? [] 为防御性死分支 */
      panguSpaced = (text.match(/ /g) ?? []).length - (before.match(/ /g) ?? []).length
      /* v8 ignore next -- pangu 只增不减，panguSpaced 恒 >= 0 */
      if (panguSpaced < 0) panguSpaced = 0
    }
  }

  const replacementCount = rep.count
  const changed = replacementCount > 0 || deleteCount > 0 || exclamationReduced > 0 || repeatedPunctFixed > 0 || numberNormalized > 0 || panguSpaced > 0 || text !== rawText
  return {
    text,
    replacementCount,
    deleteCount,
    exclamationReduced,
    repeatedPunctFixed,
    panguSpaced,
    numberNormalized,
    changed,
  }
}

function countDiff(before: string, after: string): number {
  if (before.length === after.length) return 0
  return Math.abs(before.length - after.length)
}

/**
 * 替换白名单: 替换词命中 TIER 词库时的豁免键。
 * 例如 "然而"→"但是": 二者都在 TIER2_SUSPICIOUS — 替换后文本若出现 "但是",
 * 调用方可查此表判断该 "但是" 是否来自替换 (豁免惩罚)。
 * 键 = 替换词, 值 = 来源原词。
 */
export const REPLACEMENT_WHITELIST: Readonly<Record<string, string[]>> = {
  "但是": ["然而"],
  "可是": ["然而"],
  "不过": ["然而"],
  "于是": ["因此"],
  "所以": ["因此"],
  "显然": ["毫无疑问"],
  "其实": ["事实上"],
  "简单来说": ["换言之"],
  "忍不住": ["不由自主", "情不自禁"],
}
