/**
 * 55 号设计 W2-1 (54② 收尾): 大纲线 body-only 规范化。
 *
 * format-normalizer 无 frontmatter 感知 (已实证)——引号统一/感叹号降级会破坏
 * `---` 头块 (如 `title: "..."`)。本模块按 `^---\n[\s\S]*?\n---\n?` 切头,
 * 仅 body 过 formatNormalize, frontmatter 原样回接。
 * 纯函数零 LLM; 无 frontmatter 的输入等价于直接 normalize。
 */

import { formatNormalize } from "./format-normalizer"

const FRONTMATTER_RE = /^---\n[\s\S]*?\n---\n?/

/**
 * 对 Markdown 正文做规范化, frontmatter 头块逐字节保留。
 * @returns 规范化后的完整文本 (frontmatter 原样 + body 规范化)。
 */
export function normalizeMarkdownBody(content: string): string {
  const match = content.match(FRONTMATTER_RE)
  if (!match) return formatNormalize(content).text
  const frontmatter = match[0]
  const body = content.slice(frontmatter.length)
  return frontmatter + formatNormalize(body).text
}
