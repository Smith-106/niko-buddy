import { listDirectory, fileExists } from "@/commands/fs"
import { normalizePath } from "@/lib/path-utils"
import { flattenMdFilesBase } from "./chapter-utils"
import type { FileNode } from "@/types/wiki"

/**
 * entity_subtype → 物理子目录名（entities/<subdir>/）。
 * 双态兼容层：迁移期 entities/ 顶层仍可能存散装 .md，读面回退扁平。
 * 代码侧统一使用 wiki/ 逻辑名（fs.rs resolve_project_storage_path 透明落 QM/）。
 */
export const ENTITY_SUBDIRS = [
  "characters",
  "items",
  "locations",
  "organizations",
  "events",
] as const

export type EntitySubdir = (typeof ENTITY_SUBDIRS)[number]

/** entity_subtype / tags 值 → 子目录。event|record|system 统一入 events。 */
const SUBTYPE_TO_DIR: Record<string, EntitySubdir> = {
  character: "characters",
  item: "items",
  location: "locations",
  organization: "organizations",
  event: "events",
  record: "events",
  system: "events",
}

export function entitySubdirOf(subtype?: string | null): EntitySubdir | null {
  if (!subtype) return null
  return SUBTYPE_TO_DIR[subtype] ?? null
}

/** tags[] → 子目录（无 entity_subtype 时的回退推导；优先级 character>organization>location>item）。 */
export function entitySubdirFromTags(tags?: readonly string[]): EntitySubdir | null {
  if (!tags || tags.length === 0) return null
  for (const t of ["character", "organization", "location", "item"]) {
    if (tags.includes(t)) return SUBTYPE_TO_DIR[t]
  }
  return null
}

function entityFileName(nameOrSlug: string): string {
  const base = nameOrSlug.replace(/\.md$/i, "")
  return `${base}.md`
}

export interface ResolveEntityPathOptions {
  /** 写路径：给出实体 subtype（优先）或 tags，决定落子目录；读路径省略。 */
  subtype?: string | null
  tags?: readonly string[]
  /** true=写路径（按 subtype/tags 选子目录，不探测存在性）；false=读路径（探测存在性，子目录→扁平回退）。 */
  forWrite?: boolean
}

/**
 * 解析实体的 wiki/entities 下物理相对路径。
 * - 写（forWrite）：按 subtype/tags 返回 `wiki/entities/<subdir>/<name>.md`；无分类信息回退扁平 `wiki/entities/<name>.md`。
 * - 读：优先探测子目录命中（全子目录扫一次找同名），未中回退扁平路径。双态兼容迁移期旧扁平文件。
 * 返回值为**逻辑 wiki/ 相对路径**（供 readFile/writeFileAtomic；fs 层负责 wiki→QM）。
 */
export async function resolveEntityPath(
  projectPath: string,
  nameOrSlug: string,
  options: ResolveEntityPathOptions = {},
): Promise<string> {
  const pp = normalizePath(projectPath).replace(/\/+$/, "")
  const fname = entityFileName(nameOrSlug)
  const base = `${pp}/wiki/entities`

  if (options.forWrite) {
    const subdir = entitySubdirOf(options.subtype) ?? entitySubdirFromTags(options.tags)
    return subdir ? `${base}/${subdir}/${fname}` : `${base}/${fname}`
  }

  // 读：先在各子目录找同名文件（覆盖已迁移），命中即用；否则回退扁平。
  // 每个 fileExists 独立 try——子目录探测失败（权限/不存在父目录）不中断，落到下一候选。
  for (const subdir of ENTITY_SUBDIRS) {
    const candidate = `${base}/${subdir}/${fname}`
    try {
      if (await fileExists(candidate)) return candidate
    } catch {
      // 子目录探测异常 → 继续下一候选
    }
  }
  return `${base}/${fname}`
}

/**
 * 聚合列举 entities 下全部 .md：顶层散装 + 各子目录。
 * 替代原 `listDirectory(wiki/entities)` 直读——子目录化后 nodes 变 dir、.md 过滤会丢，
 * 故统一经此聚合（双态：迁移期顶层散装与子目录并存）。
 * 返回扁平 {name, path}[]，name 为去 .md 的 slug。
 */
export async function listEntityFiles(
  projectPath: string,
): Promise<Array<{ name: string; path: string }>> {
  const pp = normalizePath(projectPath).replace(/\/+$/, "")
  const base = `${pp}/wiki/entities`
  let tree: FileNode[] = []
  try {
    tree = await listDirectory(base)
  } catch {
    return []
  }
  // flattenMdFilesBase 已递归处理 is_dir/children——天然聚合子目录+顶层散装。
  return flattenMdFilesBase(tree).map((f) => ({
    name: f.name.replace(/\.md$/i, ""),
    path: f.path,
  }))
}
