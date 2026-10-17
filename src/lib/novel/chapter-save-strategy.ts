import { parseFrontmatter } from "@/lib/frontmatter"

// C4 门控覆盖守卫（方案 a 落地说明 · B2 审计溯源 run-65559216952f）：
// - decideChapterSaveStrategy 只决定「目标章节编号」；是否覆盖已有正文的判定
//   由 chapterMarkdownHasBody（正文存在性）+ 调用方显式确认对话框承担
//   （见 chat-panel.tsx C4 覆盖守卫注释 + chapter-overwrite 对话框）。
// - 调用方禁止硬编码跳过存在性检查（`generatedTargetExists` 必须由真实路径
//   存在性传入）；「存在但读不出正文」保守视为有正文，需人工确认。

export type ChapterSaveStrategy =
  | {
    action: "direct_next_chapter"
  }
  | {
    action: "direct_explicit_target_new"
    targetChapterNumber: number
  }

export function decideChapterSaveStrategy(input: {
  selectedChapterNumber: number | null
  generatedTargetChapterNumber: number | null
  generatedTargetExists: boolean
}): ChapterSaveStrategy {
  if (
    input.generatedTargetChapterNumber &&
    input.generatedTargetChapterNumber > 0 &&
    input.generatedTargetChapterNumber !== input.selectedChapterNumber
  ) {
    if (!input.generatedTargetExists) {
      return {
        action: "direct_explicit_target_new",
        targetChapterNumber: input.generatedTargetChapterNumber,
      }
    }
  }

  return {
    action: "direct_next_chapter",
  }
}

export function detectGeneratedTargetChapterNumber(content: string): number | null {
  const heading = content
    .replace(/^\uFEFF/, "")
    .replace(/^(?:---\r?\n[\s\S]*?\r?\n---\s*)/, "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean) ?? ""

  const zhMatch = heading.match(/^#?\s*第\s*(\d+)\s*章(?:\s|$)/u)
  if (zhMatch?.[1]) return Number.parseInt(zhMatch[1], 10)

  const enMatch = heading.match(/^#?\s*chapter\s+(\d+)\b/i)
  if (enMatch?.[1]) return Number.parseInt(enMatch[1], 10)

  return null
}

/**
 * 已有章节内容是否包含正文（frontmatter 之外存在非空白内容）。
 *
 * C4 覆盖守卫（方案 a）用：保存目标章节文件已存在且本函数返回 true 时，
 * 调用方必须先取得用户显式确认，才允许走既有 accept 通道覆盖写入。
 * 标题或任何非空白内容都算「已有内容」—— 宁可多确认一次，不可静默覆盖。
 * 纯函数：不做 IO、不做裁决（门控判定不在这里）。
 */
export function chapterMarkdownHasBody(markdown: string): boolean {
  if (!markdown.trim()) return false
  return parseFrontmatter(markdown).body.trim().length > 0
}
