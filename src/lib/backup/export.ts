import { invoke } from "@tauri-apps/api/core"
import { save } from "@tauri-apps/plugin-dialog"
import { listen, type UnlistenFn } from "@tauri-apps/api/event"
import { fileExists, listDirectory } from "@/commands/fs"
import { normalizePath } from "@/lib/path-utils"
import { loadRegistry } from "@/lib/project-identity"
import type { FileNode } from "@/types/wiki"
import type {
  ExportParams,
  ExportResult,
  ProjectBackupInfo,
  ProjectBackupScopeInventory,
  BackupProgressCallback,
} from "./types"

const LS_PREFIXES = ["niko-buddy", "lk-"]

/** Keys to exclude from backup collection (sensitive material that must not travel with the backup). */
const EXCLUDE_KEYS = new Set(["niko_buddy_fallback_fingerprint"])

function collectLocalStorage(): Record<string, string> {
  const data: Record<string, string> = {}
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i)
    if (!key) continue
    if (EXCLUDE_KEYS.has(key)) continue
    if (LS_PREFIXES.some((prefix) => key.startsWith(prefix))) {
      const value = localStorage.getItem(key)
      if (value !== null) {
        data[key] = value
      }
    }
  }
  return data
}

async function collectProjects(): Promise<ProjectBackupInfo[]> {
  const registry = await loadRegistry()
  return Object.values(registry).map((entry) => ({
    id: entry.id,
    path: entry.path,
    name: entry.name,
  }))
}

export async function exportBackup(
  onProgress?: BackupProgressCallback,
): Promise<ExportResult> {
  const now = new Date()
  const dateStr = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}`
  const defaultName = `niko-buddy-backup-${dateStr}.zip`

  const savePath = await save({
    defaultPath: defaultName,
    filters: [{ name: "ZIP 备份文件", extensions: ["zip"] }],
  })

  if (!savePath) {
    return {
      success: false,
      warnings: [],
      fileCount: 0,
      totalSize: 0,
      error: "用户取消了导出",
    }
  }

  const localStorageData = collectLocalStorage()
  const projects = await collectProjects()

  const params: ExportParams = {
    savePath,
    localStorageData,
    projects,
  }

  let unlisten: UnlistenFn | undefined
  try {
    if (onProgress) {
      unlisten = await listen("backup-progress", (event) => {
        onProgress(event.payload as never)
      })
    }

    const result = await invoke<ExportResult>("export_backup", { params })
    return result
  } finally {
    unlisten?.()
  }
}

/** Request cancellation of the in-progress export backup. */
export async function cancelBackup(): Promise<void> {
  await invoke<void>("cancel_backup")
}

const BACKUP_ROOT_DOCS = ["soul.md", "schema.md", "purpose.md"] as const

async function safeFileExists(path: string): Promise<boolean> {
  try {
    return await fileExists(path)
  } catch (err) {
    void err
    return false
  }
}

async function safeListDirectory(path: string): Promise<FileNode[]> {
  try {
    return (await listDirectory(path)) ?? []
  } catch (err) {
    void err
    return []
  }
}

function collectLeafRelativePaths(
  nodes: readonly FileNode[],
  prefix = "",
  out: string[] = [],
): string[] {
  for (const node of nodes) {
    const seg = (node.name ?? "").replace(/^[/\\]+|[/\\]+$/g, "")
    const rel = prefix ? (seg ? `${prefix}/${seg}` : prefix) : seg
    if (node.is_dir) {
      if (Array.isArray(node.children) && node.children.length > 0) {
        collectLeafRelativePaths(node.children, rel, out)
      }
      continue
    }
    if (rel) {
      out.push(rel)
    } else if (node.path) {
      out.push(normalizePath(node.path))
    }
  }
  return out
}

async function countFilesInDir(dirPath: string): Promise<number> {
  if (!(await safeFileExists(dirPath))) return 0
  const nodes = await safeListDirectory(dirPath)
  return collectLeafRelativePaths(nodes).length
}

/**
 * 只读盘点项目 8 类可备份内容（正文/大纲/设定/快照/草稿箱 .qm-drafts/状态/事实库/书魂文档）。
 * 零新 Rust IPC；严格遵循 QM/ 优先于 wiki/ 的目录契约（对齐后端 canon/export_fs.rs），
 * 且基于 `FileNode.name` 递归拼接相对路径，兼容 Rust `list_directory` 将 `QM/` 虚拟化为 `wiki/` 的路径重写与 Windows 盘符大小写差异。
 */
export async function inventoryProjectBackupScope(
  projectPath: string,
): Promise<ProjectBackupScopeInventory> {
  const root = normalizePath(projectPath).replace(/\/+$/, "")
  if (!root) {
    return {
      chapters: 0,
      outlines: 0,
      settings: 0,
      snapshots: 0,
      qmDrafts: 0,
      status: 0,
      canonLancedb: 0,
      rootDocs: 0,
      knowledgeRoot: null,
    }
  }

  let knowledgeRoot: "QM" | "wiki" | null = null
  if (await safeFileExists(`${root}/QM`)) {
    knowledgeRoot = "QM"
  } else if (await safeFileExists(`${root}/wiki`)) {
    knowledgeRoot = "wiki"
  }

  let chapters = 0
  let outlines = 0
  let settings = 0
  if (knowledgeRoot) {
    const nodes = await safeListDirectory(`${root}/${knowledgeRoot}`)
    const relFiles = collectLeafRelativePaths(nodes)
    for (const rel of relFiles) {
      const lower = rel.toLowerCase()
      if (lower.startsWith("backups/") || lower.includes("/.t34c-") || lower.startsWith(".t34c-")) {
        continue
      }
      if (lower.startsWith("chapters/")) {
        chapters += 1
      } else if (lower.startsWith("outlines/")) {
        outlines += 1
      } else {
        settings += 1
      }
    }
  }

  const [snapshots, qmDrafts, hasStatus, canonLancedb, rootDocFlags] = await Promise.all([
    countFilesInDir(`${root}/.novel/snapshots`),
    countFilesInDir(`${root}/.qm-drafts`),
    safeFileExists(`${root}/.novel/status.json`),
    countFilesInDir(`${root}/.niko-buddy/lancedb`),
    Promise.all(BACKUP_ROOT_DOCS.map((doc) => safeFileExists(`${root}/${doc}`))),
  ])

  return {
    chapters,
    outlines,
    settings,
    snapshots,
    qmDrafts,
    status: hasStatus ? 1 : 0,
    canonLancedb,
    rootDocs: rootDocFlags.filter(Boolean).length,
    knowledgeRoot,
  }
}
