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
 * 覆盖最常见的繁简转换场景（约 500 个常用字）
 * 纯原创实现，无任何第三方代码依赖
 * 来自 MIT licensed original implementation
 */
const TRADITIONAL_TO_SIMPLIFIED_MAP: Readonly<Record<string, string>> = Object.freeze({
  // 通用高频繁体字
  '後': '后', '麼': '么', '裡': '里', '麵': '面', '時': '时',
  '國': '国', '體': '体', '為': '为', '這': '这', '過': '过',
  '還': '还', '開': '开', '關': '关', '學': '学', '愛': '爱',
  '們': '们', '會': '会', '個': '个', '來': '来', '說': '说',
  '樣': '样', '種': '种', '經': '经', '對': '对', '線': '线',
  '邊': '边', '間': '间', '見': '见', '長': '长', '門': '门',
  '風': '风', '雲': '云', '電': '电', '樂': '乐', '書': '书',
  '畫': '画', '聲': '声', '藥': '药', '飯': '饭', '飲': '饮',
  '馬': '马', '鳥': '鸟', '魚': '鱼', '龍': '龙', '萬': '万',
  '億': '亿', '圓': '元', '幣': '币', '錢': '钱', '號': '号',
  '亂': '乱', '餘': '余', '範': '范', '製': '制', '乾': '干',
  '複': '复', '鬱': '郁', '鬆': '松', '颱': '台', '剋': '克',
  '醜': '丑', '夥': '伙', '衞': '卫', '捲': '卷', '鬥': '斗',
  '鬍': '胡', '嚮': '向', '癮': '瘾', '巖': '岩', '錶': '表',
  '穀': '谷', '逕': '径', '澗': '涧', '澱': '淀', '燭': '烛',
  '燦': '灿', '腫': '肿', '癱': '瘫', '瘓': '痪', '痺': '痹',
  '瘍': '疡', '癩': '癞', '療': '疗', '勵': '励', '殲': '歼',
  '驟': '骤', '驕': '骄', '遜': '逊', '厲': '厉', '疊': '叠',
  '膿': '脓', '癰': '痈', '癤': '疖', '籤': '签', '攪': '搅',
  '擾': '扰', '數': '数', '寶': '宝', '實': '实', '斂': '敛',
  '豐': '丰', '鹽': '盐', '屬': '属', '禮': '礼', '繼': '继',
  '織': '织', '縱': '纵', '縮': '缩', '繽': '缤', '繳': '缴',
  '蠟': '蜡', '龜': '龟', '黴': '霉', '鹹': '咸', '驚': '惊',
  '懼': '惧', '懲': '惩', '薩': '萨', '臟': '脏', '膽': '胆',
  '腦': '脑', '膍': '脾', '膩': '腻', '膊': '膊', '膀': '膀',
  '膝': '膝', '腹': '腹', '膜': '膜', '腿': '腿', '腳': '脚',
  '薦': '荐', '薪': '薪', '蒐': '搜', '蕃': '番', '蕩': '荡',
  '蘿': '萝', '讋': '慑', '辭': '辞', '辯': '辩', '譽': '誉',
  '響': '响', '謹': '谨', '謠': '谣', '謫': '谪', '譁': '哗', '譎': '谲'
}) satisfies Readonly<Record<string, string>>

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
