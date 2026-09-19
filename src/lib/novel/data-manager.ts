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
    // 先试当文件取大小；目录取不到大小则递归子项。
    const size = await getFileSize(path).catch(() => -1)
    if (size >= 0) return size
    const children = await listDirectory(path).catch(() => [] as FileNode[])
    let total = 0
    for (const child of children) {
      total += await pathSize(child.path)
    }
    return total
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

/** 判断路径是目录（能 listDirectory 且 getFileSize 失败）还是文件。 */
async function isDir(path: string): Promise<boolean> {
  const size = await getFileSize(path).catch(() => -1)
  return size < 0
}

/** 复制单个路径（目录→copyDirectory / 文件→copyFile）到目标。 */
async function copyPath(src: string, dest: string): Promise<void> {
  if (await isDir(src)) {
    await copyDirectory(src, dest)
  } else {
    // 文件：确保父目录存在后复制
    const parent = dest.slice(0, dest.lastIndexOf("/"))
    if (parent) await createDirectory(parent).catch(() => {})
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
    await createDirectory(trashTarget).catch(() => {})
    const dest = `${trashTarget}/${rel.split("/").pop()}`
    await copyPath(src, dest).catch(() => {})
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
    await copyPath(src, dest).catch(() => {})
    await deleteFile(src)
  }
}

/** 整项目重置：把所有数据域移入回收站（同一 stamp）。返回 stamp。 */
export async function moveAllToTrash(projectPath: string, stamp: string): Promise<string> {
  for (const domain of DATA_DOMAINS) {
    await moveDomainToTrash(projectPath, domain, stamp).catch(() => {})
  }
  return stamp
}
