import { readFile, writeFileAtomic } from "@/commands/fs"
import { todayStamp } from "@/lib/utils"
import { normalizePath } from "@/lib/path-utils"
import { isMissingFile } from "./chapter-ingest-utils"
import { withProjectLock } from "./novel-locks"

/**
 * 时间线条目结构。
 * MIT licensed implementation.
 */
export interface TimelineEntry {
  chapterNumber: number
  event: string
}

/**
 * Timeline 文件存储结构。
 * MIT licensed implementation.
 */
interface TimelineFile {
  version: 1
  entries: TimelineEntry[]
  serial: number
  updatedAt: string
}

/**
 * 构建 timeline 文件的存储路径。
 * MIT licensed implementation.
 *
 * @param projectPath - 项目根路径
 * @returns timeline JSON 文件的绝对路径
 */
function timelinePath(projectPath: string): string {
  return `${normalizePath(projectPath)}/.novel/timeline.json`
}

/**
 * 加载时间线数据。
 * MIT licensed implementation.
 *
 * @param projectPath - 项目根路径
 * @returns TimelineFile 对象（如果不存在则返回空结构）
 */
export async function loadTimeline(projectPath: string): Promise<TimelineFile> {
  const path = timelinePath(projectPath)
  let raw: string
  try {
    raw = await readFile(path, { exactUtf8: true })
  } catch (error) {
    if (await isMissingFile(path, error)) return { version: 1, entries: [], serial: 0, updatedAt: "" }
    throw error
  }
  const data: TimelineFile = JSON.parse(raw.replace(/^\uFEFF/, ""))
  if (data?.version !== 1 || !Array.isArray(data.entries)
    || !Number.isSafeInteger(data.serial) || data.serial < 0
    || typeof data.updatedAt !== "string"
    || data.entries.some(entry => entry == null || !Number.isSafeInteger(entry.chapterNumber) || typeof entry.event !== "string")) {
    throw new Error(`Invalid timeline document: ${path}`)
  }
  return data
}

/**
 * 保存时间线数据到文件。
 * MIT licensed implementation.
 *
 * @param projectPath - 项目根路径
 * @param data - Timeline 数据对象
 */
async function saveTimeline(projectPath: string, data: TimelineFile): Promise<void> {
  const path = timelinePath(projectPath)
  data.updatedAt = todayStamp()
  await writeFileAtomic(path, JSON.stringify(data, null, 2))
}

/**
 * 合并快照时间线事件（去重）。
 * MIT licensed implementation.
 *
 * @param projectPath - 项目根路径
 * @param chapterNumber - 章节编号
 * @param timelineEvents - 要添加的事件列表
 */
export async function mergeSnapshotTimeline(
  projectPath: string,
  chapterNumber: number,
  timelineEvents: string[],
): Promise<void> {
  if (!timelineEvents || timelineEvents.length === 0) return

  await withProjectLock(`timeline:${normalizePath(projectPath)}`, async () => {
    const tl = await loadTimeline(projectPath)

    // 使用 Set 进行去重
    const existing = new Set(tl.entries.map((e) => `${e.chapterNumber}:${e.event}`))

    for (const event of timelineEvents) {
      const key = `${chapterNumber}:${event}`
      if (!existing.has(key)) {
        if (tl.serial === Number.MAX_SAFE_INTEGER) throw new Error("Timeline serial is exhausted")
        tl.serial++
        tl.entries.push({ chapterNumber, event })
        existing.add(key)
      }
    }

    await saveTimeline(projectPath, tl)
  })
}

/**
 * 移除指定章节的全部时间线事件（短锁 RMW，供删章联动清理）。
 * 文件缺失或无该章事件时零写盘并返回 false；坏文档或读错 fail-loud 上抛。
 */
export async function removeChapterTimelineEvents(
  projectPath: string,
  chapterNumber: number,
): Promise<boolean> {
  const pp = normalizePath(projectPath)
  return withProjectLock(`timeline:${pp}`, async () => {
    const tl = await loadTimeline(pp)
    const remaining = tl.entries.filter((e) => e.chapterNumber !== chapterNumber)
    if (remaining.length === tl.entries.length) return false
    if (tl.serial === Number.MAX_SAFE_INTEGER) throw new Error("Timeline serial is exhausted")
    tl.entries = remaining
    tl.serial++
    await saveTimeline(pp, tl)
    return true
  })
}

/**
 * 获取时间线事件（按章节排序）。
 * MIT licensed implementation.
 *
 * @param projectPath - 项目根路径
 * @returns 排序后的 TimelineEntry 列表
 */
export async function getTimelineEvents(
  projectPath: string,
): Promise<TimelineEntry[]> {
  const tl = await loadTimeline(projectPath)
  return tl.entries.sort((a, b) => a.chapterNumber - b.chapterNumber)
}