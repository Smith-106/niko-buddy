/**
 * 数据管理器 — 数据域的清空/回收站/统计逻辑。
 *
 * 删除两阶段：
 *  1. moveToTrash：把数据域内容移入 `.niko-buddy/.trash-bin/<stamp>/<domain>/`（可恢复）。
 *  2. purgeTrash：物理删除回收站内容（不可恢复，需用户强确认）。
 *
 * 这样"改方案后整批删"既快又安全 —— 先回收站，确认无误再彻底删。
 */
import {
  copyDirectory,
  copyFile,
  createDirectory,
  deleteFile,
  fileExists,
  getFileSize,
  listDirectory,
  pathIsDirectory,
} from "@/commands/fs"
import type { FileNode } from "@/types/wiki"
import { normalizePath } from "@/lib/path-utils"
import {
  DATA_DOMAINS,
  TRASH_BIN_DIR,
  type DataDomain,
} from "./data-domain-registry"

export interface DomainStat {
  domainId: string
  /** 实际存在的子路径数。 */
  presentPaths: number
  /** 总字节数（递归估算）。 */
  totalBytes: number
}

export interface TrashEntry {
  /** 回收站内的 stamp 目录名。 */
  stamp: string
  /** 该批次包含的域 id。 */
  domainIds: string[]
}

function buddyDir(projectPath: string): string {
  return `${normalizePath(projectPath)}/.niko-buddy`
}

/** 递归估算路径字节数（文件或目录）。 */
async function pathSize(path: string): Promise<number> {
  try {
    if (!(await fileExists(path))) return 0
    // 目录：按真实文件类型判定后递归子项求和（DI-1）。
    // 不能靠 getFileSize 是否失败区分 —— Windows 上目录的 metadata.len()
    // 返回 Ok(0)，旧逻辑会把它当「0 字节文件」直接返回 0。
    if (await isDir(path)) {
      const children = await listDirectory(path).catch(() => [] as FileNode[])
      let total = 0
      for (const child of children) {
        total += await pathSize(child.path)
      }
      return total
    }
    const size = await getFileSize(path).catch(() => 0)
    return size > 0 ? size : 0
  } catch {
    return 0
  }
}

/** 统计某数据域在项目中占用。 */
export async function statDomain(projectPath: string, domain: DataDomain): Promise<DomainStat> {
  const base = buddyDir(projectPath)
  let present = 0
  let bytes = 0
  for (const rel of domain.relPaths) {
    const p = `${base}/${rel}`
    if (await fileExists(p)) {
      present += 1
      bytes += await pathSize(p)
    }
  }
  return { domainId: domain.id, presentPaths: present, totalBytes: bytes }
}

/** 统计所有数据域。 */
export async function statAllDomains(projectPath: string): Promise<DomainStat[]> {
  return Promise.all(DATA_DOMAINS.map((d) => statDomain(projectPath, d)))
}

/**
 * 判断路径是否为目录。
 *
 * DI-1 根因：旧实现用 `getFileSize` 失败推断目录（`size < 0`），但 Rust
 * `do_get_file_size` = `metadata.len()`，对目录在 Windows 上返回 `Ok(0)`，
 * 目录被误判为普通文件 → 走 copyFile 对目录必败（错误被吞）→ 源目录被
 * `deleteFile` 递归物理删除。目录判定的唯一可信来源是 Rust
 * `path_is_directory`（`metadata.file_type().is_dir()`）。
 */
async function isDir(path: string): Promise<boolean> {
  return pathIsDirectory(path).catch(() => false)
}

/** 复制单个路径（目录→copyDirectory / 文件→copyFile）到目标。失败一律上抛。 */
async function copyPath(src: string, dest: string): Promise<void> {
  if (await isDir(src)) {
    await copyDirectory(src, dest)
  } else {
    // 文件：确保父目录存在后复制（create_dir_all 幂等）
    const parent = dest.slice(0, dest.lastIndexOf("/"))
    if (parent) await createDirectory(parent)
    await copyFile(src, dest)
  }
}

/**
 * 把数据域内容移入回收站。返回本批 stamp（若该域无内容返回 null）。
 */
export async function moveDomainToTrash(
  projectPath: string,
  domain: DataDomain,
  stamp: string,
): Promise<boolean> {
  const base = buddyDir(projectPath)
  const trashTarget = `${base}/${TRASH_BIN_DIR}/${stamp}/${domain.id}`
  let moved = false
  for (const rel of domain.relPaths) {
    const src = `${base}/${rel}`
    if (!(await fileExists(src))) continue
    await createDirectory(trashTarget)
    const dest = `${trashTarget}/${rel.split("/").pop()}`
    // DI-1：先复制、复制成功才允许删源；任何 copy 失败都必须上抛中止。
    // （旧实现 `.catch(() => {})` 吞错 + 无条件 deleteFile(src)，对目录
    //  意味着 copy 必败后源目录被递归物理删除 ——「可恢复」名存实亡。）
    await copyPath(src, dest)
    await deleteFile(src)
    moved = true
  }
  return moved
}

/** 列出回收站批次。 */
export async function listTrash(projectPath: string): Promise<TrashEntry[]> {
  const trashRoot = `${buddyDir(projectPath)}/${TRASH_BIN_DIR}`
  if (!(await fileExists(trashRoot))) return []
  const stamps = await listDirectory(trashRoot).catch(() => [] as FileNode[])
  const out: TrashEntry[] = []
  for (const s of stamps) {
    if (!s.is_dir || !s.name) continue
    const sub = await listDirectory(s.path).catch(() => [] as FileNode[])
    out.push({ stamp: s.name, domainIds: sub.map((x) => x.name).filter(Boolean) })
  }
  return out
}

/** 物理删除回收站某批（不可恢复）。 */
export async function purgeTrashStamp(projectPath: string, stamp: string): Promise<void> {
  const p = `${buddyDir(projectPath)}/${TRASH_BIN_DIR}/${stamp}`
  if (await fileExists(p)) await deleteFile(p)
}

/** 从回收站恢复某域到原位置。 */
export async function restoreDomainFromTrash(
  projectPath: string,
  domain: DataDomain,
  stamp: string,
): Promise<void> {
  const base = buddyDir(projectPath)
  const trashTarget = `${base}/${TRASH_BIN_DIR}/${stamp}/${domain.id}`
  if (!(await fileExists(trashTarget))) return
  const children = await listDirectory(trashTarget).catch(() => [] as FileNode[])
  for (const child of children) {
    const name = child.name
    if (!name) continue
    const src = `${trashTarget}/${name}`
    const dest = `${base}/${name}`
    if (await fileExists(dest)) await deleteFile(dest)
    // DI-1：复制成功才删回收站源；copy 失败上抛，回收站内容保留可重试。
    await copyPath(src, dest)
    await deleteFile(src)
  }
}

/** 整项目重置：把所有数据域移入回收站（同一 stamp）。返回 stamp。
 *  DI-1：单个域失败不再静默 —— 记录后继续其余域，最终如有失败则如实抛出
 *  （禁止「失败了却看起来成功」；失败域的源数据因 copy-gate 保持完好）。 */
export async function moveAllToTrash(projectPath: string, stamp: string): Promise<string> {
  const failures: string[] = []
  for (const domain of DATA_DOMAINS) {
    try {
      await moveDomainToTrash(projectPath, domain, stamp)
    } catch (e) {
      failures.push(`${domain.id}: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  if (failures.length > 0) {
    throw new Error(
      `moveAllToTrash: ${failures.length} domain(s) failed to move to trash: ${failures.join("; ")}`,
    )
  }
  return stamp
}
