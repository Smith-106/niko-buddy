/**
 * Novel 项目导出模块。
 * MIT licensed implementation.
 *
 * 将项目章节、快照、元数据导出到指定目录。
 */

import { readFile, writeFile, listDirectory, createDirectory } from "@/commands/fs"
import { invoke } from "@tauri-apps/api/core"
import { normalizePath } from "@/lib/path-utils"
import { flattenMdFilesBase } from "./chapter-utils"
import { parseFrontmatter } from "@/lib/frontmatter"
import { listSnapshots, loadSnapshot } from "./chapter-ingest"
import { loadCharacterStates } from "./character-state"
import { loadForeshadowingTracker } from "./foreshadowing-tracker"
import { loadCognitionState } from "./character-cognition"

/**
 * 导出配置选项。
 * MIT licensed implementation.
 */
export interface ExportOptions {
  projectPath: string
  exportPath: string
  includeChapters?: boolean
  includeSnapshots?: boolean
  includeMeta?: boolean
}

/**
 * 导出结果。
 * MIT licensed implementation.
 */
export interface ExportResult {
  success: boolean
  exportedPath: string
  chapterCount: number
  message: string
}

/**
 * 导出整个 Novel 项目。
 * MIT licensed implementation.
 *
 * @param options - 导出配置选项
 * @returns 导出结果
 */
export async function exportProject(options: ExportOptions): Promise<ExportResult> {
  const pp = normalizePath(options.projectPath)
  const {
    exportPath,
    includeChapters = true,
    includeSnapshots = true,
    includeMeta = true,
  } = options

  try {
    await createDirectory(exportPath)
    let chapterCount = 0

    if (includeChapters) {
      const chaptersDir = `${pp}/wiki/chapters`
      let files: { name: string; path: string }[] = []
      try {
        const tree = await listDirectory(chaptersDir)
        files = flattenMdFilesBase(tree)
      } catch {
        files = []
      }

      const chapters: { num: number; title: string; content: string }[] = []

      // 并行 readFile + parseFrontmatter（Promise.all 保序，按 i 还原）；
      // 最终 sort by num 后写盘，输出顺序确定性不因并行完成顺序改变。
      const loaded = await Promise.all(
        files.map(async (file, i) => {
          try {
            const raw = await readFile(file.path)
            const parsed = parseFrontmatter(raw)
            const fm = parsed.frontmatter as Record<string, unknown> | null
            const status = fm?.chapter_status as string | undefined
            if (status && status !== "final") return { i, data: null }
            /* v8 ignore next */
            const num = typeof fm?.chapter_number === "number" ? fm.chapter_number as number : 0
            const title = (typeof fm?.title === "string" ? fm.title : file.name.replace(/\.md$/, "")) as string
            const body = parsed.body.trim()
            return { i, data: { num, title, content: body } }
          } catch {
            // skip unreadable files
            return { i, data: null }
          }
        }),
      )
      for (const entry of loaded) {
        if (entry.data) {
          chapters.push(entry.data)
          chapterCount++
        }
      }

      chapters.sort((a, b) => a.num - b.num)

      const mergedContent = chapters
        .map(c => `# ${c.title}\n\n${c.content}`)
        .join("\n\n---\n\n")
      await writeFile(`${exportPath}/complete-novel.md`, mergedContent)
    }

    if (includeSnapshots) {
      const snapshotsDir = `${exportPath}/snapshots`
      await createDirectory(snapshotsDir)
      try {
        const nums = await listSnapshots(pp)
        // 并行 loadSnapshot（Promise.all 保序）；按 num 依序写盘（padStart 文件名），
        // 输出顺序确定性不因并行完成顺序改变。
        const loaded = await Promise.all(
          nums.map(async (num) => {
            const snap = await loadSnapshot(pp, num)
            return { num, snap }
          }),
        )
        for (const { num, snap } of loaded) {
          if (snap) {
            await writeFile(
              `${snapshotsDir}/${String(num).padStart(3, "0")}.snapshot.json`,
              JSON.stringify(snap, null, 2),
            )
          }
        }
      } catch {
        // snapshots optional
      }
    }

    if (includeMeta) {
      const metaDir = `${exportPath}/meta`
      await createDirectory(metaDir)

      try {
        const chars = await loadCharacterStates(pp)
        await writeFile(`${metaDir}/character-states.json`, JSON.stringify(chars, null, 2))
      } catch {
        // optional
      }

      try {
        const foreshadows = await loadForeshadowingTracker(pp)
        await writeFile(`${metaDir}/foreshadowing-tracker.json`, JSON.stringify(foreshadows, null, 2))
      } catch {
        // optional
      }

      try {
        const cognition = await loadCognitionState(pp)
        if (cognition) {
          await writeFile(`${metaDir}/cognition-state.json`, JSON.stringify(cognition, null, 2))
        }
      } catch {
        // optional
      }
    }

    return {
      success: true,
      exportedPath: exportPath,
      chapterCount,
      message: `导出完成：${chapterCount} 个章节`,
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { success: false, exportedPath: exportPath, chapterCount: 0, message }
  }
}

/**
 * DOCX 导出配置选项。
 * MIT licensed implementation.
 */
export interface DocxExportOptions {
  projectPath: string
  exportPath: string
}

/**
 * EPUB 导出选项（54 号设计 ⑥）：与 DOCX 同形，复用章节加载逻辑。
 */
export interface EbookExportOptions {
  projectPath: string
  exportPath: string
}

/**
 * EPUB 导出结果。
 * MIT licensed implementation.
 */
export interface EbookExportResult {
  success: boolean
  exportedPath: string
  chapterCount: number
  message: string
}

/**
 * Load final-status chapters (wiki/chapters, `chapter_status: final`) ordered by
 * chapter number. Shared by the Markdown/DOCX exporters and the settings
 * section that counts chapters to gate empty-state exports.
 */
async function loadFinalChapters(projectPath: string): Promise<{ num: number; title: string; body: string }[]> {
  const pp = normalizePath(projectPath)
  const chaptersDir = `${pp}/wiki/chapters`
  let files: { name: string; path: string }[] = []
  try {
    const tree = await listDirectory(chaptersDir)
    files = flattenMdFilesBase(tree)
  } catch {
    files = []
  }

  const chapters: { num: number; title: string; body: string }[] = []

  // 并行 readFile + parseFrontmatter（Promise.all 保序，按 i 还原）；
  // 最终 sort by num 后传给 Rust，输出顺序确定性不因并行完成顺序改变。
  const loaded = await Promise.all(
    files.map(async (file, i) => {
      try {
        const raw = await readFile(file.path)
        const parsed = parseFrontmatter(raw)
        const fm = parsed.frontmatter as Record<string, unknown> | null
        const status = fm?.chapter_status as string | undefined
        if (status && status !== "final") return { i, data: null }
        /* v8 ignore next */
        const num = typeof fm?.chapter_number === "number" ? fm.chapter_number as number : 0
        const title = (typeof fm?.title === "string" ? fm.title : file.name.replace(/\.md$/, "")) as string
        const body = parsed.body.trim()
        return { i, data: { num, title, body } }
      } catch {
        // skip unreadable files
        return { i, data: null }
      }
    }),
  )
  for (const entry of loaded) {
    if (entry.data) chapters.push(entry.data)
  }

  chapters.sort((a, b) => a.num - b.num)
  return chapters
}

/**
 * Count final-status chapters in a novel project (0 when the project has
 * no chapters or the chapters directory is missing). Settings uses this to
 * disable the DOCX export button with an empty-state hint.
 */
export async function countFinalChapters(projectPath: string): Promise<number> {
  try {
    const chapters = await loadFinalChapters(projectPath)
    return chapters.length
  } catch {
    return 0
  }
}

/**
 * 将项目 final 状态章节导出为单个 .docx 文件（Word 可打开）。
 *
 * 复用 exportProject 的章节加载逻辑（wiki/chapters 下 final 状态章节，
 * 按章节号排序），通过 Rust 端 `export_novel_docx` 命令（docx-rs 库）
 * 生成 OOXML 并写盘。标题映射为 Heading1，正文按空行分段。
 *
 * 守 Draft-first：导出只读正式层，不写回任何内容。
 */
export async function exportNovelDocx(options: DocxExportOptions): Promise<DocxExportResult> {
  const pp = normalizePath(options.projectPath)
  const { exportPath } = options

  try {
    const chapters = await loadFinalChapters(pp)

    const result = await invoke<DocxExportResult>("export_novel_docx", {
      chapters: chapters.map((c) => ({ title: c.title, body: c.body })),
      exportPath,
    })
    return {
      success: result.success,
      exportedPath: result.exportedPath,
      chapterCount: result.chapterCount,
      message: result.message,
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { success: false, exportedPath: exportPath, chapterCount: 0, message }
  }
}

/**
 * 将项目 final 状态章节导出为单个 .epub 文件（EPUB3 最小合规）。
 *
 * 复用 loadFinalChapters（wiki/chapters 下 final 状态章节，按章节号排序），
 * 通过 Rust 端 `export_novel_epub` 命令（zip crate 自写容器，零新依赖）
 * 生成 EPUB3：mimetype 必须为 ZIP 首条目且 stored，container.xml → content.opf
 * manifest/spine，章节 XHTML5 转义。导出期间 Rust 侧 emit epub-export-progress。
 *
 * 守 Draft-first：导出只读正式层，不写回任何内容。
 */
export async function exportNovelEpub(options: EbookExportOptions): Promise<EbookExportResult> {
  const pp = normalizePath(options.projectPath)
  const { exportPath } = options

  try {
    const chapters = await loadFinalChapters(pp)

    const result = await invoke<EbookExportResult>("export_novel_epub", {
      chapters: chapters.map((c) => ({ title: c.title, body: c.body })),
      exportPath,
    })
    return {
      success: result.success,
      exportedPath: result.exportedPath,
      chapterCount: result.chapterCount,
      message: result.message,
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { success: false, exportedPath: exportPath, chapterCount: 0, message }
  }
}