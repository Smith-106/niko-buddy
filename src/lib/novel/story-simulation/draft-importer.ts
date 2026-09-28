/**
 * 故事草稿导入到章节库
 *
 * 将 StoryDraft 中的章节写入到项目的 wiki/chapters/ 目录下，
 * 使用标准的 chapter-XXX.md 文件格式（带 YAML frontmatter）。
 * 支持选择性导入和覆盖前自动备份。
 */

import { createDirectory, writeFileAtomic, fileExists, readFile } from "@/commands/fs"
import { normalizePath } from "@/lib/path-utils"
import { getNextChapterNumber } from "@/lib/novel/chapter-utils"
import { backupChapterFile } from "@/lib/novel/chapter-backup"
import type { StoryDraft, StoryFramework } from "./types"

interface ImportResult {
  importedCount: number
  chapterPaths: string[]
  startChapter: number
  backedUpPaths: string[]
}

/**
 * 将草稿导入到项目章节库。
 * @returns 导入的章节数量、起始章节号、文件路径列表和备份路径列表
 */
export async function importDraftToChapters(
  projectPath: string,
  framework: StoryFramework,
  draft: StoryDraft,
  options?: {
    /** 指定起始章节号，不指定则自动使用下一个可用章节号 */
    startChapter?: number
    /** 是否覆盖已存在的章节文件（覆盖前自动备份） */
    overwrite?: boolean
    /** 只导入指定索引的章节（0-based），不指定则全部导入 */
    selectedIndices?: number[]
    /** 导入进度回调 */
    onProgress?: (current: number, total: number, chapterTitle: string) => void
    /** 导入后是否自动执行章节摄取（回填快照与 Canon 事实），默认 false */
    autoIngest?: boolean
    /** 用于章节摄取的 LLM 配置 */
    llmConfig?: import("@/stores/wiki-store").LlmConfig
  },
): Promise<ImportResult> {
  const pp = normalizePath(projectPath)
  const chapterDir = `${pp}/wiki/chapters`
  await createDirectory(chapterDir)

  const startChapter = options?.startChapter ?? await getNextChapterNumber(pp)
  const chapterPaths: string[] = []
  const backedUpPaths: string[] = []
  const now = new Date()
  const dateStr = now.toISOString().split("T")[0]

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
    const fileName = `chapter-${String(chapterNum).padStart(3, "0")}.md`
    const filePath = `${chapterDir}/${fileName}`

    // 进度回调
    options?.onProgress?.(i + 1, totalToImport, chapter.title)

    // 检查文件是否已存在
    const exists = await fileExists(filePath)
    if (exists) {
      if (!options?.overwrite) {
        throw new Error(
          `章节文件已存在：${fileName}。请先删除已有章节或选择覆盖模式。`,
        )
      }
      // 覆盖前自动备份原文件
      try {
        const originalContent = await readFile(filePath)
        const backupPath = await backupChapterFile({
          projectPath: pp,
          chapterPath: filePath,
          chapterNumber: chapterNum,
          content: originalContent,
          now,
          source: "template",
        })
        backedUpPaths.push(backupPath)
      } catch {
        // 备份失败不阻塞导入，但记录警告
        console.warn(`[draft-import] 备份 ${fileName} 失败，继续覆盖`)
      }
    }

    // 构建章节标题
    const fullTitle = chapter.title.startsWith("第")
      ? chapter.title
      : `第${chapterNum}章 ${chapter.title}`

    // 构建 frontmatter + 正文
    const content = [
      "---",
      `type: chapter`,
      `chapter_number: ${chapterNum}`,
      `chapter_status: draft`,
      `title: "${fullTitle.replace(/"/g, '\\"')}"`,
      `source: story-simulation`,
      `framework_id: "${framework.id}"`,
      `framework_title: "${framework.title.replace(/"/g, '\\"')}"`,
      `created: ${dateStr}`,
      `---`,
      "",
      `# ${fullTitle}`,
      "",
      chapter.content,
      "",
    ].join("\n")

    await writeFileAtomic(filePath, content)
    chapterPaths.push(filePath)
    chapterNumOffset++
  }

  // 若开启了 autoIngest 且配置了可用模型，自动为导入的章节执行事实摄取与双写
  if (options?.autoIngest && options?.llmConfig) {
    try {
      const [{ ingestChapter }, { defaultCanonDualWriteDeps }] = await Promise.all([
        import("@/lib/novel/chapter-ingest"),
        import("@/lib/novel/canon-dual-write"),
      ])
      for (const chPath of chapterPaths) {
        try {
          await ingestChapter(pp, chPath, options.llmConfig?.model ?? "default", undefined, {
            canonDualWriteDeps: defaultCanonDualWriteDeps(),
          })
        } catch (e) {
          console.warn(`[draft-import] 自动摄取 ${chPath} 失败:`, e)
        }
      }
    } catch (e) {
      console.warn("[draft-import] 加载章节摄取模块失败:", e)
    }
  }

  return {
    importedCount: indices.length,
    chapterPaths,
    startChapter,
    backedUpPaths,
  }
}
