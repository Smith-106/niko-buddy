/**
 * Character Aura Utilities Module
 * 
 * Copyright © 2024 QMAI Team
 * 
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 * 
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 * 
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

import { pinyin } from "pinyin-pro"
import { normalizePath } from "@/lib/path-utils"
export { normalizePath }

/**
 * 把中文文本转为无音调小写拼音，用于拼音模糊匹配
 * 使用 pinyin-pro 库（MIT licensed）
 */
export function toPinyin(text: string): string {
  try {
    return pinyin(text, { toneType: "none", type: "array" }).join("").toLowerCase()
  } catch {
    return text.toLowerCase()
  }
}

/**
 * 繁体中文到简体中文映射表
 * 覆盖 400+ 常用繁体字（146 基础表 + 精选扩展，scripts/gen-t2s-map.mjs 自动生成）
 */
import { T2S_MAP } from "./t2s-map.generated"

const TRADITIONAL_TO_SIMPLIFIED_MAP: Readonly<Record<string, string>> = T2S_MAP

/**
 * 繁体中文转简体中文
 * 使用本地映射表，无需外部依赖
 * 基于 GB18030 规范推导的字符映射规则
 * @param text 输入文本
 * @returns 转换后的简体文本
 */
export function toSimplified(text: string): string {
  if (!text || text.length <= 2) return text
  
  let result = ''
  for (let i = 0; i < text.length; i++) {
    const char = text[i]
    result += TRADITIONAL_TO_SIMPLIFIED_MAP[char] ?? char
  }
  return result
}

export function safeSkillSlug(id: string, name: string): string {
  const cleanedName = name.trim().toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]+/g, "-").replace(/^-+|-+$/g, "")
  return cleanedName ? `${id}-${cleanedName}` : id
}

export function clipText(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, " ").trim()
  if (normalized.length <= maxLength) return normalized
  return `${normalized.slice(0, maxLength)}……`
}

export function markdownToPlainText(markdown: string): string {
  return markdown
    .replace(/^#+\s*/gm, "")
    .replace(/^\-\s*/gm, "")
    .replace(/\*\*/g, "")
    .replace(/`/g, "")
    .replace(/\[(.*?)\]\((.*?)\)/g, "$1")
    .replace(/\s+/g, " ")
    .trim()
}

export function htmlToPlainText(raw: string): string {
  return raw
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 20000)
}

export function splitSourceLines(value: string | undefined): string[] {
  return (value ?? "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
}

export function normalizeCharacterText(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/\s+/g, "")
    .replace(/[，。、"'\u2018\u2019\u201c\u201d「」『』：:；;（）()\[\]【】《》<>！？!?,.·-]/g, "")
    .toLowerCase()
}

export function compressMarkdownForAuraContext(markdown: string, maxLength: number): string {
  const cleanedLines = markdown
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("---") && !line.startsWith("name:") && !line.startsWith("description:"))
  const structuredLines = cleanedLines.filter((line) => line.startsWith("#") || line.startsWith("-") || line.includes("：") || line.includes(":"))
  const sourceLines = structuredLines.length > 0 ? structuredLines : cleanedLines
  const compact = sourceLines.join(" ").replace(/\s+/g, " ").slice(0, maxLength)
  return compact.length === maxLength ? `${compact}…` : compact
}

export function storePath(projectPath: string): string {
  return `${normalizePath(projectPath)}/.qmai/character-aura.json`
}
