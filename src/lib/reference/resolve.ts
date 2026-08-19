/**
 * Wave 2 @引用系统 — 纯函数解析层（零 IO、零 LLM、零 store import）。
 *
 * typing-time 路径（parse + score + resolve）为同步纯函数，保证输入框零延迟。
 */

import type { ReferenceCandidate, ReferenceKind, ReferenceToken, ResolvedReference } from "./types"
// 复用 character-aura-utils 的匹配基建（不平行实现）
import { normalizeCharacterText, toPinyin, toSimplified } from "@/lib/novel/character-aura-utils"

/**
 * @ 引用语法：`@` + 名称，终止符为空白/标点/行尾。
 * `@@` 视为转义（不解析）；CJK 名无空格，靠标点终止。
 */
const REFERENCE_TOKEN_RE = /@([^\s@，。！？、；：""''（）()【】\[\]]+)/g

/** 章节数字通道：@第N章 / @chN / @chapter N / @N（纯数字） */
const CHAPTER_TOKEN_RE = /^(?:第\s*([0-9一二三四五六七八九十百千万]+)\s*章|ch\s*(\d+)|chapter\s*(\d+)|(\d+))$/i

const CN_NUMERALS: Record<string, number> = {
  零: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10,
  百: 100, 千: 1000, 万: 10000,
}

/** 中文数字 → 阿拉伯数字（支持 一~九十九 及 百/千/万 组合） */
export function chineseNumberToInt(text: string): number | null {
  if (/^\d+$/.test(text)) return parseInt(text, 10)
  if (!/^[零一二三四五六七八九十百千万]+$/.test(text)) return null
  let total = 0
  let section = 0
  let number = 0
  for (const ch of text) {
    const digit = CN_NUMERALS[ch]
    if (digit === undefined) return null
    if (digit === 0) continue // 零 占位跳过
    if (digit >= 100) {
      section += (number || 1) * digit
      number = 0
    } else if (digit === 10) {
      number = (number || 1) * 10
    } else {
      number += digit
    }
  }
  total = section + number
  return total > 0 ? total : null
}

/**
 * 从输入文本解析 @ 引用 token（同步纯函数）。
 * 章节数字通道提前判定 kind="chapter"；其余 kind 待候选匹配。
 */
export function parseReferences(text: string): ReferenceToken[] {
  const tokens: ReferenceToken[] = []
  let match: RegExpExecArray | null
  REFERENCE_TOKEN_RE.lastIndex = 0
  while ((match = REFERENCE_TOKEN_RE.exec(text)) !== null) {
    // @@ 转义：前一个字符是 @ 则跳过（不解析）
    if (match.index > 0 && text[match.index - 1] === "@") continue
    const raw = match[1]!.trim()
    if (!raw) continue
    const chapterMatch = raw.match(CHAPTER_TOKEN_RE)
    if (chapterMatch) {
      const num = chapterMatch[1] ?? chapterMatch[2] ?? chapterMatch[3] ?? chapterMatch[4]
      const chapterNumber = num ? chineseNumberToInt(num) : null
      if (chapterNumber !== null) {
        tokens.push({ raw, full: match[0], kind: "chapter" })
        continue
      }
    }
    tokens.push({ raw, full: match[0] })
  }
  return tokens
}

/**
 * 候选命中打分（五级权重）：
 * 精确 100 > 别名 90 > 前缀 70 > 拼音 50 > 简繁 40。
 * 复用 character-aura-utils 的 normalizeCharacterText / toPinyin / toSimplified。
 */
export function scoreCandidate(name: string, query: string, aliases: string[] = []): number {
  const q = query.trim()
  if (!q) return 0
  const normalizedName = normalizeCharacterText(name)
  const normalizedQuery = normalizeCharacterText(q)
  if (normalizedName === normalizedQuery) return 100
  if (aliases.some((a) => normalizeCharacterText(a) === normalizedQuery)) return 90
  if (normalizedName.startsWith(normalizedQuery) && normalizedQuery.length >= 1) return 70
  if (toPinyin(normalizedName) === toPinyin(normalizedQuery)) return 50
  if (toSimplified(normalizedName) === toSimplified(normalizedQuery)) return 40
  return 0
}

/**
 * 解析引用：对每个 token 在候选集中打分排序，产出确定性结果。
 * - 最高分唯一 → 直接选定
 * - top-2 分差 < 15 → 歧义（ambiguity=true，携带 top-3 候选）
 * - 零候选 → 不产出（调用方降级为纯文本）
 */
export function resolveReferences(
  tokens: ReferenceToken[],
  candidates: ReferenceCandidate[],
): ResolvedReference[] {
  const resolved: ResolvedReference[] = []
  for (const token of tokens) {
    // 章节数字通道：直接构造候选（id = chapter number）
    if (token.kind === "chapter") {
      const num = chineseNumberToInt(token.raw.replace(/^(?:第\s*|ch\s*|chapter\s*)/i, "").replace(/章$/, ""))
      if (num !== null) {
        resolved.push({
          token,
          kind: "chapter",
          id: String(num),
          name: `第${num}章`,
          score: 100,
          ambiguity: false,
        })
        continue
      }
    }

    const scored = candidates
      .map((c) => ({ ...c, score: scoreCandidate(c.name, token.raw, c.aliases) }))
      .filter((c) => c.score > 0)
      .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name, "zh-CN"))

    if (scored.length === 0) continue

    const top = scored[0]!
    const second = scored[1]
    const ambiguity = second !== undefined && top.score - second.score < 15
    resolved.push({
      token,
      kind: top.kind,
      id: top.id,
      name: top.name,
      score: top.score,
      ambiguity,
      candidates: ambiguity ? scored.slice(0, 3) : undefined,
    })
  }
  return resolved
}
