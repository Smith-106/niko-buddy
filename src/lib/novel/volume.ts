import { searchWiki } from "@/lib/search"
import { readFile } from "@/commands/fs"
import { normalizePath } from "@/lib/path-utils"

/**
 * 卷册元数据结构。
 * MIT licensed implementation.
 */
export interface VolumeMeta {
  volumeNumber: number
  title: string
  summary: string
  chapterRangeStart: number | undefined
  chapterRangeEnd: number | undefined
}

/**
 * 从 Frontmatter 对象解析卷册元数据。
 * MIT licensed implementation.
 *
 * @param fm - frontmatter 键值对对象
 * @returns VolumeMeta 或 null（无效数据）
 */
export function parseVolumeMeta(fm: Record<string, unknown>): VolumeMeta | null {
  const rawVolumeNumber = fm.volume_number
  const volumeNumber = typeof rawVolumeNumber === "string" ? Number(rawVolumeNumber) : typeof rawVolumeNumber === "number" ? rawVolumeNumber : null
  if (volumeNumber === null || !Number.isFinite(volumeNumber) || volumeNumber <= 0) return null

  return {
    volumeNumber,
    title: typeof fm.title === "string" ? fm.title : `第${volumeNumber}卷`,
    summary: typeof fm.summary === "string" ? fm.summary : "",
    chapterRangeStart: typeof fm.chapter_range_start === "number" ? fm.chapter_range_start
      : typeof fm.chapter_range_start === "string" ? Number(fm.chapter_range_start) : undefined,
    chapterRangeEnd: typeof fm.chapter_range_end === "number" ? fm.chapter_range_end
      : typeof fm.chapter_range_end === "string" ? Number(fm.chapter_range_end) : undefined,
  }
}

/**
 * 判断页面是否为卷册类型。
 * MIT licensed implementation.
 *
 * @param fm - frontmatter 键值对对象
 * @returns true 如果是卷册页面
 */
export function isVolumePage(fm: Record<string, unknown>): boolean {
  if (fm.type === "volume") return true
  if (fm.outline_type === "volume-outline") return true
  if (typeof fm.volume_number === "number" || typeof fm.volume_number === "string") {
    return true
  }
  return false
}

/**
 * 获取包含指定章节的卷册列表。
 * MIT licensed implementation.
 *
 * @param projectPath - 项目根路径
 * @param chapterNumber - 章节编号
 * @returns 包含该章节的卷册元数据列表
 */
export async function getChapterVolumes(
  projectPath: string,
  chapterNumber: number,
): Promise<VolumeMeta[]> {
  const pp = normalizePath(projectPath)
  const results: VolumeMeta[] = []
  try {
    const searchResults = await searchWiki(pp, "volume 第 卷 chapter_range")
    for (const r of searchResults) {
      try {
        const content = await readFile(r.path)
        const fm = parseFrontmatterFromMarkdown(content)
        if (!fm) continue
        const meta = parseVolumeMeta(fm)
        if (!meta) continue
        if (
          meta.chapterRangeStart !== undefined &&
          meta.chapterRangeEnd !== undefined &&
          chapterNumber >= meta.chapterRangeStart &&
          chapterNumber <= meta.chapterRangeEnd
        ) {
          results.push(meta)
        }
      } catch {}
    }
  } catch {}
  return results
}

/**
 * 从 Markdown 内容中解析 Frontmatter。
 * MIT licensed implementation.
 *
 * @param content - Markdown 文件内容
 * @returns frontmatter 键值对或 null
 */
function parseFrontmatterFromMarkdown(content: string): Record<string, unknown> | null {
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---/)
  if (!fmMatch) return null

  const fmRaw = fmMatch[1]
  const result: Record<string, unknown> = {}

  const scalarMatches = fmRaw.matchAll(/^(\w[\w_]*):\s*["']?([^"'\n]+)["']?\s*$/gm)
  for (const m of scalarMatches) {
    const key = m[1]
    const value = m[2].trim()
    if (value === "true") result[key] = true
    else if (value === "false") result[key] = false
    else if (/^\d+$/.test(value)) result[key] = Number(value)
    else result[key] = value
  }

  return result
}