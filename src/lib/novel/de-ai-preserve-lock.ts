/**
 * de-ai-preserve-lock.ts — P1-2 preserve-lock: 改写前锁定关键内容 (零 LLM)
 *
 * 共识 (V3-ds/hy3 P0, V3-glm P1): untell preserve.py 思路 — LLM 改写/去 AI 味时
 * 引用、数字、URL、角色名、对话模板、时间词、专有名词最容易漂移。
 * 本模块在改写前提取这些片段 → 占位符替换 → 改写 → 字节级还原,
 * 保证改写只动「表达方式」不动「关键事实」。
 *
 * 与 Consistency(P0) 直接相关: 防止去 AI 味过程改坏剧情事实/时间线/角色名。
 * A19 机械层 (零 LLM): 提取/替换/还原全部确定性正则, 不调模型。
 *
 * 用法 (调度器接线):
 *   const lock = lockProtectedSpans(text)
 *   改写输入 lock.maskedText
 *   还原 lock.restore(rewritten)
 */

/** 保护片段类型 */
export type ProtectedSpanKind =
  | "url"
  | "number"
  | "quote"
  | "characterName"
  | "dialogueTemplate"
  | "timePhrase"
  | "properNoun"

/** 单个保护片段 */
export interface ProtectedSpan {
  kind: ProtectedSpanKind
  /** 原文精确值 */
  original: string
  /** 占位符 token (改写用) */
  token: string
}

/** 锁定结果 */
export interface PreserveLock {
  /** 替换后的遮蔽文本 (改写输入) */
  maskedText: string
  /** 保护片段列表 */
  spans: ProtectedSpan[]
  /** 还原: 将改写输出中的占位符替换回原文 */
  restore: (rewritten: string) => string
  /** 还原后校验: 关键片段是否全部仍在 */
  verify: (rewritten: string) => { restored: boolean; missing: string[] }
}

/** 角色名表 (与 mechanical-slop-detector CHARACTER_NAMES 同源, 独立维护避免耦合) */
const PRESERVE_CHARACTER_NAMES = [
  "白砚", "王迦", "陈烬", "李昭然", "苏未晞", "陆织锦", "周棠", "白鹭",
] as const

/** 占位符前缀 */
const TOKEN_PREFIX = "⟦LOCK" // 用少见 Unicode 防撞

/** 生成占位符 token */
function makeToken(index: number): string {
  return `${TOKEN_PREFIX}${index}⟧`
}

/** 正则: URL */
const URL_RE = /https?:\/\/[^\s，。]+|www\.[^\s，。]+/g

/** 正则: 数字 (含小数点/百分号/年月日) */
const NUMBER_RE = /\d+(?:年|月|日|号)|[\d０-９]+(?:年|月|日|号)|\d+(?:\.\d+)?%?|\d+/g

/** 正则: 引号引用 (中文全角引号 + ASCII 引号) */
const QUOTE_RE = /((?:[“”‘’「」]|["'])[^"'“”‘’「」\n]{2,80}(?:[“”‘’「」]|["']))/g

/** 时间词 (中文叙事常用) */
const TIME_PHRASES = [
  "三更时分", "五更天", "黄昏时分", "拂晓", "子时", "丑时", "寅时", "卯时",
  "午时", "巳时", "当天夜里", "次日清晨", "半月之后", "三年之后",
] as const
const DIALOGUE_LABEL_RE = /(?:他说|她说|道|说道|答道|问道|低声道|喃喃道|沉声道|笑道)[：:]/g


/** 收集全部匹配 (避免 exec 迭代 + text 变化的索引错位) */
function collectMatches(text: string, re: RegExp): { value: string; at: number }[] {
  const out: { value: string; at: number }[] = []
  const r = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g")
  let m: RegExpExecArray | null
  let guard = 0
  while ((m = r.exec(text)) !== null && guard++ < 5000) {
    out.push({ value: m[0], at: m.index })
    if (m.index === r.lastIndex) r.lastIndex++
  }
  return out
}

/**
 * 锁定保护片段: 提取 → 占位符替换 (从后往前替换, 索引稳定)。
 * 返回 maskedText + spans + restore/verify。
 */
export function lockProtectedSpans(rawText: string): PreserveLock {
  const spans: ProtectedSpan[] = []
  const collected: { kind: ProtectedSpanKind; value: string; at: number }[] = []
  const seen = new Set<string>()

  // 收集全部候选 (基于原始文本)
  // 1. URL
  for (const c of collectMatches(rawText, URL_RE)) collected.push({ kind: "url", value: c.value, at: c.at })
  // 2. 数字/年份
  for (const c of collectMatches(rawText, NUMBER_RE)) collected.push({ kind: "number", value: c.value, at: c.at })
  // 3. 引号引用 (取整体含引号)
  for (const c of collectMatches(rawText, QUOTE_RE)) collected.push({ kind: "quote", value: c.value, at: c.at })
  // 4. 角色名 (长名优先)
  const names = [...PRESERVE_CHARACTER_NAMES].sort((a, b) => b.length - a.length)
  for (const name of names) {
    for (const c of collectMatches(rawText, new RegExp(name, "g"))) {
      collected.push({ kind: "characterName", value: c.value, at: c.at })
    }
  }
  // 5. 时间词 (长优先)
  const times = [...TIME_PHRASES].sort((a, b) => b.length - a.length)
  for (const tp of times) {
    for (const c of collectMatches(rawText, new RegExp(tp, "g"))) {
      collected.push({ kind: "timePhrase", value: c.value, at: c.at })
    }
  }
  // 6. 对白标签
  for (const c of collectMatches(rawText, DIALOGUE_LABEL_RE)) collected.push({ kind: "dialogueTemplate", value: c.value, at: c.at })

  // 排序: 位置降序 → 从后往前替换, 索引不漂移
  collected.sort((a, b) => b.at - a.at)

  // 重叠剪枝: 后替换的 (位置靠前) 若与已替换区间重叠则跳过 (用 seen 记录已屏蔽原文)
  let text = rawText
  const shielded: { from: number; to: number }[] = []
  for (const c of collected) {
    const to = c.at + c.value.length
    if (shielded.some((s) => c.at < s.to && to > s.from)) continue
    if (seen.has(c.value)) continue
    seen.add(c.value)
    const token = makeToken(spans.length)
    spans.push({ kind: c.kind, original: c.value, token })
    text = text.slice(0, c.at) + token + text.slice(to)
    shielded.push({ from: c.at, to: c.at + token.length })
  }

  // 还原: 直接遍历 spans 独立替换 (token 编号与收集顺序一一对应)
  const restore = (rewritten: string): string => {
    let out = rewritten
    for (const s of spans) {
      out = out.split(s.token).join(s.original)
    }
    return out
  }

  const verify = (rewritten: string): { restored: boolean; missing: string[] } => {
    const missing = spans
      .filter((s) => !rewritten.includes(s.original))
      .map((s) => s.original)
    return { restored: missing.length === 0, missing }
  }

  return { maskedText: text, spans, restore, verify }
}

/** 生成 preserve 指令 (注入 LLM 改写 prompt) */
export function buildPreserveDirective(spans: ProtectedSpan[]): string {
  if (spans.length === 0) {
    return "## 保留要求: 不增删剧情事实、人物关系、时间线; 只改写作方式。"
  }
  const kinds = new Set(spans.map((s) => s.kind))
  const kindName: Record<ProtectedSpanKind, string> = {
    url: "链接",
    number: "数字/日期",
    quote: "引用",
    characterName: "角色名",
    dialogueTemplate: "对白引语",
    timePhrase: "时间表达",
    properNoun: "专有名词",
  }
  const list = [...kinds].map((k) => kindName[k]).join("、")
  return `## 保留要求 (preserve-lock)\n改写时必须原样保留以下内容类型: ${list}。\n占位符形式为 ${TOKEN_PREFIX}n⟧ 的片段是受保护内容, 必须原样保留占位符, 不得改写、删除、重排。\n输出仅返回改写后的正文, 不要解释。`
}

/** 文本化保护报告 (供审计) */
export function preserveLockToText(lock: PreserveLock): string {
  if (lock.spans.length === 0) return ""
  const byKind = new Map<ProtectedSpanKind, number>()
  for (const s of lock.spans) {
    byKind.set(s.kind, (byKind.get(s.kind) ?? 0) + 1)
  }
  const parts = [...byKind.entries()].map(([k, n]) => `${k}:${n}`)
  return `preserve-lock: ${lock.spans.length} spans (${parts.join(" ")})`
}
