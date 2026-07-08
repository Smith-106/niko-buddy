/**
 * 移动端灵感记录 (最小可行结构, 本地文件交换非云同步)
 *
 * S5 多端入口：移动灵感 -> 桌面深写。非并发模型，单用户本地交换，
 * 无锁无冲突解决 (boundary_contract MUST NOT cloud-sync)。
 * 灵感是 task-router 的辅助输入，不直接改 status.json 正文。
 */

import { randomUUID } from "node:crypto"
import { createDirectory, fileExists, readFile, writeFileAtomic } from "@/commands/fs"
import { normalizePath } from "@/lib/path-utils"

/** 移动端灵感记录 (最小可行结构, 本地文件交换非云同步) */
export interface InspirationEntry {
  id: string
  content: string
  category: "character" | "plot" | "scene" | "setting" | "dialogue" | "other"
  createdAt: string  // ISO timestamp
  source: "mobile" | "desktop"
  tags?: string[]
}

/** 灵感集合 (一个 .novel/inspirations.json 文件) */
export interface InspirationCollection {
  schemaVersion: 1
  entries: InspirationEntry[]
  updatedAt: string
}

const INSPIRATIONS_RELATIVE_PATH = ".novel/inspirations.json"

const CATEGORY_LABELS: Record<InspirationEntry["category"], string> = {
  character: "人物",
  plot: "剧情",
  scene: "场景",
  setting: "设定",
  dialogue: "对白",
  other: "其他",
}

const CATEGORY_ORDER: InspirationEntry["category"][] = [
  "character",
  "plot",
  "scene",
  "setting",
  "dialogue",
  "other",
]

function inspirationsPath(projectPath: string): string {
  return `${normalizePath(projectPath)}/${INSPIRATIONS_RELATIVE_PATH}`
}

function emptyCollection(): InspirationCollection {
  return {
    schemaVersion: 1,
    entries: [],
    updatedAt: new Date().toISOString(),
  }
}

/** 创建灵感条目 (移动端记录) */
export function createInspirationEntry(
  content: string,
  category: InspirationEntry["category"],
  tags?: string[],
): InspirationEntry {
  const trimmed = content.trim()
  if (!trimmed) {
    throw new Error("inspiration content must not be empty")
  }
  return {
    id: `inspiration-${randomUUID()}`,
    content: trimmed,
    category,
    createdAt: new Date().toISOString(),
    source: "mobile",
    tags: tags && tags.length > 0 ? tags : undefined,
  }
}

/**
 * 渲染灵感集合为 task-router 可消费的辅助提示 (桌面深写导入)。
 * 空 (或无 mobile 条目) 集合返回 ""，避免污染空 prompt。
 */
export function renderInspirationsForRouting(collection: InspirationCollection): string {
  const entries = collection.entries
  if (entries.length === 0) return ""

  const byCategory = new Map<InspirationEntry["category"], InspirationEntry[]>()
  for (const entry of entries) {
    const list = byCategory.get(entry.category) ?? []
    list.push(entry)
    byCategory.set(entry.category, list)
  }

  const sections: string[] = []
  for (const category of CATEGORY_ORDER) {
    const list = byCategory.get(category)
    if (!list || list.length === 0) continue
    const label = CATEGORY_LABELS[category]
    const lines = list.map((entry) => {
      const tags = entry.tags && entry.tags.length > 0 ? ` [${entry.tags.join(", ")}]` : ""
      return `- ${entry.content}${tags}`
    })
    sections.push(`### ${label}\n${lines.join("\n")}`)
  }

  if (sections.length === 0) return ""

  return `# 移动端灵感 (导入桌面深写)\n\n${sections.join("\n\n")}`
}

/**
 * 从 .novel/inspirations.json 加载灵感集合 (桌面端导入移动端记录)。
 * 文件不存在返回空集合。文件存在但解析失败 (截断 / 损坏 — 写中途崩溃
 * 留下的 truncated .json) 降级为空集合并 warn, 不抛出 — 与
 * loadEmotionalArcs 一致 (BP-003 fix: 裸 writeFile 改 writeFileAtomic
 * 后, 崩溃截断不再可能, 但 load 仍需防御历史/外部损坏, 非阻断)。
 */
export async function loadInspirationCollection(projectPath: string): Promise<InspirationCollection> {
  const filePath = inspirationsPath(projectPath)
  const exists = await fileExists(filePath)
  if (!exists) return emptyCollection()

  try {
    const raw = await readFile(filePath)
    const parsed = JSON.parse(raw) as Partial<InspirationCollection>
    if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.entries)) {
      console.warn(`[Inspiration] invalid inspirations.json at ${filePath}, falling back to empty collection`)
      return emptyCollection()
    }
    return {
      schemaVersion: 1,
      entries: parsed.entries as InspirationEntry[],
      updatedAt: parsed.updatedAt ?? new Date().toISOString(),
    }
  } catch (error) {
    // 截断 / 损坏文件 — 降级而非中断移动端灵感导入 (BP-003 crash-safety)。
    console.warn(`[Inspiration] failed to parse inspirations.json at ${filePath}, falling back to empty collection:`, error instanceof Error ? error.message : error)
    return emptyCollection()
  }
}

/**
 * 追加灵感到集合并持久化 (移动端记录 / 桌面端补充)。
 * 非并发安全：单用户本地交换，无锁无冲突解决 (boundary_contract 非并发模型)。
 */
export async function appendInspiration(
  projectPath: string,
  entry: InspirationEntry,
): Promise<InspirationCollection> {
  const filePath = inspirationsPath(projectPath)
  const dir = filePath.slice(0, filePath.lastIndexOf("/"))
  await createDirectory(dir)

  // loadInspirationCollection 降级返回空集合 (不抛), 故这里直接 await —
  // 文件不存在或解析失败都已在上层转为 emptyCollection (BP-003 crash-safety)。
  const collection = await loadInspirationCollection(projectPath)
  collection.entries.push(entry)
  collection.updatedAt = new Date().toISOString()

  // BP-003 fix: writeFileAtomic (temp + fsync + rename) — 写中途崩溃不留
  // 截断 inspirations.json, 与 .novel/ 下所有其他投影 (emotional-arcs /
  // subplot-board / resource-ledger / projection-status / cognition) 一致。
  await writeFileAtomic(filePath, JSON.stringify(collection, null, 2))
  return collection
}
