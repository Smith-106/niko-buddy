import { createDirectory, writeFile } from "@/commands/fs"
import { normalizePath } from "@/lib/path-utils"

/**
 * 备份版本来源五标签（63 号共识 §6 缺口 17）：
 * - manual    用户手动保存
 * - llm       LLM 生成（写作主链产物）
 * - campaign  战役/批量连写产物
 * - template  模板/导入路径（draft-importer 等）
 * - migrated  旧格式迁移（无来源元数据的存量备份）
 * 标签写入备份文件名后缀（.qmai/chapter-backups/ 无读端，命名向后兼容：
 * 未传 source 时保持旧格式文件名）。
 */
export type ChapterBackupSource = "manual" | "llm" | "campaign" | "template" | "migrated"

export const CHAPTER_BACKUP_SOURCES: readonly ChapterBackupSource[] = [
  "manual",
  "llm",
  "campaign",
  "template",
  "migrated",
]

/**
 * 格式化备份时间戳为 YYYYMMDD-HHMMSS 格式（UTC）。
 * MIT licensed implementation.
 *
 * @param now - 当前日期对象
 * @returns 格式化的时间戳字符串
 */
function formatBackupTimestamp(now: Date): string {
  const pad = (value: number): string => String(value).padStart(2, "0")
  return [
    now.getUTCFullYear(),
    pad(now.getUTCMonth() + 1),
    pad(now.getUTCDate()),
    "-",
    pad(now.getUTCHours()),
    pad(now.getUTCMinutes()),
    pad(now.getUTCSeconds()),
  ].join("")
}

/**
 * 创建章节文件备份。
 * MIT licensed implementation.
 *
 * @param input - 备份参数
 * @param input.projectPath - 项目根路径
 * @param input.chapterPath - 章节文件路径（仅用于命名参考）
 * @param input.chapterNumber - 章节编号（可选）
 * @param input.content - 章节内容
 * @param input.now - 当前时间（可选，默认使用 new Date()）
 * @returns 备份文件路径
 */
export async function backupChapterFile(input: {
  projectPath: string
  chapterPath: string
  chapterNumber: number | null
  content: string
  now?: Date
  /** 64 号实施 additive: 版本来源五标签（缺省不写后缀，向后兼容）。 */
  source?: ChapterBackupSource
}): Promise<string> {
  const backupDir = `${normalizePath(input.projectPath)}/.qmai/chapter-backups`
  const stamp = formatBackupTimestamp(input.now ?? new Date())
  const prefix = input.chapterNumber && input.chapterNumber > 0
    ? `chapter-${String(input.chapterNumber).padStart(3, "0")}`
    : "chapter-unknown"
  const sourceSuffix = input.source ? `-${input.source}` : ""
  const backupPath = `${backupDir}/${prefix}-${stamp}${sourceSuffix}.md`

  await createDirectory(backupDir)
  await writeFile(backupPath, input.content)
  return backupPath
}
