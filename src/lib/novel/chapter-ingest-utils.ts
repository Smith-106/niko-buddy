/**
 * chapter-ingest-utils — 章节摄入纯工具函数子模块（arch-risk W4 god-object 拆分）。
 *
 * 从 chapter-ingest.ts 抽出的无模块依赖纯函数：事实主语解析/canon 双写资格/
 * frontmatter 字段提取。主文件只做编排——这些工具独立可测可复用。
 * extractFrontmatter* 顺带收敛 canonical parseFrontmatter（arch-risk W3）。
 */

import { parseFrontmatter } from "@/lib/frontmatter"

/** 事实陈述 → 主语（：/:/是/属于/为 谓词前缀，无谓词回退前20字）。 */
export function parseFactsSubject(rawFact: string): string {
  const subjectMatch = rawFact.match(/^(.+?)(：|:|是|属于|(?<![名称作因])为)/)
  return subjectMatch ? subjectMatch[1]!.trim() : rawFact.slice(0, 20).trim()
}

/** frontmatter 是否 canon 双写资格（chapter_status final/accepted）。 */
export function isCanonDualWriteEligible(fm: Record<string, unknown>): boolean {
  const status = fm.chapter_status
  return status === "final" || status === "accepted"
}

/** frontmatter 字段 → string（canonical parseFrontmatter）。 */
export function extractFrontmatterString(content: string, key: string): string | null {
  const { frontmatter } = parseFrontmatter(content)
  const v = frontmatter?.[key]
  if (typeof v === "string") return v.trim() || null
  if (v === null || v === undefined) return null
  return String(v).trim() || null
}

/** frontmatter 字段 → number（canonical，可转 number 的 string 也算）。 */
export function extractFrontmatterNumber(content: string, key: string): number | null {
  const { frontmatter } = parseFrontmatter(content)
  const v = frontmatter?.[key]
  if (typeof v === "number" && Number.isFinite(v)) return v
  if (typeof v === "string") {
    const parsed = Number(v)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}
