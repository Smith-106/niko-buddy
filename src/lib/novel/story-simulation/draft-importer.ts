/**
 * 故事草稿导入到待审草稿箱（Draft-first 边界）
 *
 * 将 StoryDraft 中的推演章节统一通过 writeDraft 写入项目的 .qm-drafts/ 目录，
 * 严禁直接覆写正式章节（wiki/chapters/）或在采纳前触发正式记忆摄取（ingestChapter）。
 * 作者在草稿箱审阅并采纳后，才回填正式正文与正式记忆。
 */

import { parseFrontmatter } from "@/lib/frontmatter"
import { normalizePath } from "@/lib/path-utils"
import { logger, todayStamp } from "@/lib/utils"
import { getNextChapterNumber } from "@/lib/novel/chapter-utils"
import { writeDraft } from "../draft-manager"
import { DRAFTS_DIR } from "../lifecycle-types"
import type { StoryDraft, StoryFramework } from "./types"

export interface ImportResult {
  importedCount: number
  /** 待审草稿文件路径列表（位于 .qm-drafts/ 下） */
  chapterPaths: string[]
  /** 写入的待审草稿 ID 列表 */
  draftIds: string[]
  /** Draft-first 标记：始终为 true，表示已路由至草稿箱待人工审阅采纳 */
  routedToDrafts: true
  startChapter: number
  backedUpPaths: string[]
}

/**
 * 将故事推演草稿导入到项目待审草稿箱（.qm-drafts/）。
 * @returns 导入的章节数量、起始章节号、草稿路径与 ID 列表
 */
export async function importDraftToChapters(
  projectPath: string,
  framework: StoryFramework,
  draft: StoryDraft,
  options?: {
    /** 指定起始章节号，不指定则自动使用下一个可用章节号 */
    startChapter?: number
    /** 保留历史选项签名；Draft-first 模式下所有导入均进入待审草稿箱，不会直接覆写正式章节 */
    overwrite?: boolean
    /** 只导入指定索引的章节（0-based），不指定则全部导入 */
    selectedIndices?: number[]
    /** 导入进度回调 */
    onProgress?: (current: number, total: number, chapterTitle: string) => void
    /** 保留历史选项签名；Draft-first 下禁止采纳前摄取，开启时仅记录延期告警 */
    autoIngest?: boolean
    /** 保留历史选项签名 */
    llmConfig?: import("@/stores/wiki-store").LlmConfig
  },
): Promise<ImportResult> {
  const pp = normalizePath(projectPath)
  const root = pp.replace(/\/+$/, "")

  const startChapter = options?.startChapter ?? await getNextChapterNumber(pp)
  const chapterPaths: string[] = []
  const draftIds: string[] = []
  const backedUpPaths: string[] = []
  const dateStr = todayStamp()
  const safeFrameworkId = (framework.id || "framework").replace(/[^a-zA-Z0-9_-]/g, "_")
  const sourceConversationId = `story-simulation-${safeFrameworkId}-${dateStr}`

  // 确定要导入的章节索引
  const indices = options?.selectedIndices
    ? options.selectedIndices.filter((i) => i >= 0 && i < draft.chapters.length)
    : draft.chapters.map((_, i) => i)

  if (indices.length === 0) {
    throw new Error("未选择任何章节，请至少选择一章导入。")
  }

  // 计算每个导入章节对应的章节号
  // 如果是选择性导入，章节号仍按原顺序连续分配
  let chapterNumOffset = 0
  const totalToImport = indices.length
  for (let i = 0; i < indices.length; i++) {
    const draftIdx = indices[i]
    const chapter = draft.chapters[draftIdx]
    const chapterNum = startChapter + chapterNumOffset
    const chapterName = `chapter-${String(chapterNum).padStart(3, "0")}`

    // 进度回调
    options?.onProgress?.(i + 1, totalToImport, chapter.title)

    // 构建章节标题
    const fullTitle = chapter.title.startsWith("第")
      ? chapter.title
      : `第${chapterNum}章 ${chapter.title}`

    // 剥离任何误入的 YAML frontmatter，仅将纯净正文写入草稿箱
    const parsedContent = parseFrontmatter(chapter.content.replace(/^\uFEFF/, ""))
    const bodyText = parsedContent.rawBlock
      ? parsedContent.body.replace(/^(?:\r?\n)+/, "")
      : chapter.content
    const content = `# ${fullTitle}\n\n${bodyText}\n`

    const writtenDraft = await writeDraft(pp, chapterName, content, {
      sourceConversationId,
    })
    draftIds.push(writtenDraft.id)
    chapterPaths.push(`${root}/${DRAFTS_DIR}/${writtenDraft.id}.md`)
    chapterNumOffset++
  }

  // Draft-first 硬边界：严禁在草稿采纳前调用 ingestChapter 污染正式记忆层
  if (options?.autoIngest) {
    logger.warn(
      "draft-import",
      "Story simulation import deferred autoIngest until Draft-first adoption",
      {
        projectPath: pp,
        importedCount: draftIds.length,
        draftIds,
      },
    )
  }

  return {
    importedCount: indices.length,
    chapterPaths,
    draftIds,
    routedToDrafts: true,
    startChapter,
    backedUpPaths,
  }
}
