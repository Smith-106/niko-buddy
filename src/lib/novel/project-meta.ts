/**
 * 小说项目元数据持久化模块。
 * MIT licensed implementation.
 *
 * 管理 NovelProject 的完整元数据：标题、题材、目标字数等。
 */

import { readFile, writeFile, createDirectory, fileExists } from "@/commands/fs"
import { normalizePath } from "@/lib/path-utils"

/**
 * Novel 项目元数据接口。
 * MIT licensed implementation.
 */
export interface NovelProjectMeta {
  id: string
  title: string
  genre: string
  targetWords: number
  novelMode: boolean
  createdAt: string
  updatedAt: string
  currentChapter: number
  totalChapters: number
  totalWords: number
  volumes: number
  description: string
}

const NOVEL_META_DIR = ".novel"
const NOVEL_META_FILE = "project-meta.json"

/**
 * 创建默认的 Novel 项目元数据。
 * MIT licensed implementation.
 *
 * @param title - 项目标题
 * @returns 初始化的 NovelProjectMeta 对象
 */
export function createDefaultNovelProjectMeta(title: string): NovelProjectMeta {
  const now = new Date().toISOString()
  return {
    id: `novel-${Date.now()}`,
    title,
    genre: "",
    targetWords: 0,
    novelMode: true,
    createdAt: now,
    updatedAt: now,
    currentChapter: 0,
    totalChapters: 0,
    totalWords: 0,
    volumes: 0,
    description: "",
  }
}

/**
 * 保存 Novel 项目元数据到文件。
 * MIT licensed implementation.
 *
 * @param projectPath - 项目根路径
 * @param meta - 元数据对象
 */
export async function saveNovelProjectMeta(
  projectPath: string,
  meta: NovelProjectMeta,
): Promise<void> {
  const pp = normalizePath(projectPath)
  const dir = `${pp}/${NOVEL_META_DIR}`
  const filePath = `${dir}/${NOVEL_META_FILE}`
  await createDirectory(dir)
  const updated = { ...meta, updatedAt: new Date().toISOString() }
  await writeFile(filePath, JSON.stringify(updated, null, 2))
}

/** 元数据文件状态：不存在 / 存在但读不出或解析失败 / 正常。 */
export type NovelProjectMetaState =
  | { readonly status: "missing" }
  | { readonly status: "corrupt" }
  | { readonly status: "ok"; readonly meta: NovelProjectMeta }

/**
 * 检查 Novel 项目元数据文件。与 loadNovelProjectMeta 的区别：把「文件存在但损坏」
 * 单独报出来，供写入方判断能否用默认值初始化（损坏文件不得被覆盖）。
 * fileExists 抛错时向上抛，不当作 missing。
 */
export async function inspectNovelProjectMeta(projectPath: string): Promise<NovelProjectMetaState> {
  const pp = normalizePath(projectPath)
  const filePath = `${pp}/${NOVEL_META_DIR}/${NOVEL_META_FILE}`
  const exists = await fileExists(filePath)
  if (!exists) return { status: "missing" }
  try {
    const raw = await readFile(filePath)
    return { status: "ok", meta: JSON.parse(raw) as NovelProjectMeta }
  } catch {
    return { status: "corrupt" }
  }
}

/**
 * 加载 Novel 项目元数据。
 * MIT licensed implementation.
 *
 * @param projectPath - 项目根路径
 * @returns NovelProjectMeta 或 null（不存在或损坏时；需要区分两者用 inspectNovelProjectMeta）
 */
export async function loadNovelProjectMeta(
  projectPath: string,
): Promise<NovelProjectMeta | null> {
  const state = await inspectNovelProjectMeta(projectPath)
  return state.status === "ok" ? state.meta : null
}

/**
 * 更新 Novel 项目统计信息。
 * MIT licensed implementation.
 *
 * @param projectPath - 项目根路径
 * @param stats - 部分统计数据（章节数、字数等）
 */
export async function updateNovelProjectStats(
  projectPath: string,
  stats: Partial<Pick<NovelProjectMeta, "currentChapter" | "totalChapters" | "totalWords" | "volumes">>,
): Promise<void> {
  const existing = await loadNovelProjectMeta(projectPath)
  if (!existing) return
  const updated: NovelProjectMeta = {
    ...existing,
    ...stats,
    updatedAt: new Date().toISOString(),
  }
  await saveNovelProjectMeta(projectPath, updated)
}
