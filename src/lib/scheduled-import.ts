/**
 * @license MIT © QMAI
 *
 * Scheduled import — periodic file-system scan that copies new or
 * changed files from a watched directory into the project's source
 * tree and enqueues them for LLM ingestion.
 */
import {
  copyFile,
  fileExists,
  getFileMd5,
  getFileSize,
  listDirectory,
  preprocessFile,
  readFile,
  writeFileAtomic,
} from "@/commands/fs"
import type { FileNode, WikiProject } from "@/types/wiki"
import { isAbsolutePath, normalizePath } from "@/lib/path-utils"
import { useWikiStore } from "@/stores/wiki-store"
import { resolveDefaultModel } from "@/lib/novel/model-resolver"
import type { ScheduledImportConfig } from "@/stores/wiki-store"
import {
  loadScheduledImportConfig,
  saveScheduledImportConfig,
} from "@/lib/project-store"
import {
  enqueueSourceIngest,
  isIngestableSourcePath,
} from "@/lib/source-lifecycle"

// ── Types ──────────────────────────────────────────────────────────

interface ImportDb {
  files: Record<string, string>
  lastScan: number | null
}

interface ImportDbStore {
  version: 1
  directories: Record<string, ImportDb>
}

type ScanOptions = { runId?: number }

const EMPTY_DB: ImportDb = { files: {}, lastScan: null }

let scanTimer: ReturnType<typeof setInterval> | null = null
let scanning = false
let activeRunId = 0

const DB_PATH = ".qmai/scheduled-import-db.json"
const LEGACY_DB_DIR = ".llm-wiki-imported"
const SI_DIR = "scheduled-import"
const MAX_BYTES = 100 * 1024 * 1024
const SENSITIVE_EXTS = new Set(["json", "yaml", "yml", "xml"])
const RESERVED_NAMES = new Set([
  "con", "prn", "aux", "nul",
  "com1", "com2", "com3", "com4", "com5", "com6", "com7", "com8", "com9",
  "lpt1", "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9",
])

// ── Helpers ────────────────────────────────────────────────────────

function emptyStore(): ImportDbStore { return { version: 1, directories: {} } }

function dbFilePath(pp: string): string { return `${normalizePath(pp)}/${DB_PATH}` }

function dbKey(importPath: string): string {
  const n = normalizePath(importPath)
  return /^[A-Za-z]:\//.test(n) || n.startsWith("//") ? n.toLowerCase() : n
}

function cloneDb(db: ImportDb): ImportDb { return { files: { ...db.files }, lastScan: db.lastScan } }

function isInside(path: string, parent: string): boolean {
  const np = normalizePath(path)
  const pp = normalizePath(parent).replace(/\/+$/, "")
  return np === pp || np.startsWith(`${pp}/`)
}

function subpath(pp: string, rel: string): string { return `${normalizePath(pp)}/${rel}` }

function stableSuffix(input: string): string {
  let hash = 2166136261
  for (let i = 0; i < input.length; i++) { hash ^= input.charCodeAt(i); hash = Math.imul(hash, 16777619) }
  return (hash >>> 0).toString(36).slice(0, 6)
}

function sanitiseSegment(seg: string): string {
  let v = seg.replace(/[<>:"|?*\x00-\x1F]/g, "_").replace(/[. ]+$/g, "").trim()
  if (!v) v = "_"
  const stem = v.split(".")[0]?.toLowerCase() ?? v.toLowerCase()
  if (RESERVED_NAMES.has(stem)) v = `_${v}`
  return v
}

function appendSuffix(name: string, suffix: string): string {
  const dot = name.lastIndexOf(".")
  return dot > 0 ? `${name.slice(0, dot)}-${suffix}${name.slice(dot)}` : `${name}-${suffix}`
}

function safeRelPath(path: string): string {
  const norm = normalizePath(path)
  const parts = norm.split("/").filter((p) => p && p !== "." && p !== "..")
  const safe = parts.map(sanitiseSegment)
  if (safe.length === 0) return "_"
  const joined = safe.join("/")
  if (joined !== parts.join("/")) {
    const last = safe[safe.length - 1]
    safe[safe.length - 1] = appendSuffix(last, stableSuffix(norm))
  }
  return safe.join("/")
}

export function isScheduledImportInternalPath(path: string): boolean {
  const parts = normalizePath(path).split("/")
  return parts.includes(LEGACY_DB_DIR) || parts.includes(".qmai") || parts.includes(".llm-wiki")
}

export function shouldSkipScheduledImportFile(projectPath: string, filePath: string): boolean {
  const path = normalizePath(filePath)
  const pp = normalizePath(projectPath)
  if (isScheduledImportInternalPath(path)) return true
  if (isInside(path, subpath(pp, "wiki"))) return true
  if (isInside(path, subpath(pp, "raw/sources/.cache"))) return true
  const name = path.split("/").pop() ?? ""
  return name.startsWith(".")
}

function isSensitiveConfig(path: string): boolean {
  const name = normalizePath(path).split("/").pop() ?? ""
  const ext = name.includes(".") ? name.split(".").pop()?.toLowerCase() : ""
  return Boolean(ext && SENSITIVE_EXTS.has(ext))
}

export function resolveImportPath(projectPath: string, configPath: string): string {
  const path = normalizePath(configPath || "raw/sources")
  return isAbsolutePath(path) ? path : `${normalizePath(projectPath)}/${path}`
}

export function scheduledImportDestinationForFile(
  projectPath: string,
  importPath: string,
  file: Pick<FileNode, "path" | "name">,
): string {
  const pp = normalizePath(projectPath)
  const src = normalizePath(file.path)
  const sourcesRoot = subpath(pp, "raw/sources")
  if (isInside(src, sourcesRoot)) return src

  const root = normalizePath(importPath).replace(/\/+$/, "")
  const rel = src === root || !src.startsWith(`${root}/`) ? file.name : src.slice(root.length + 1)
  return `${sourcesRoot}/${SI_DIR}/${safeRelPath(rel)}`
}

function collectFiles(nodes: FileNode[]): FileNode[] {
  const out: FileNode[] = []
  for (const n of nodes) {
    if (!n.is_dir) out.push(n)
    else if (n.children) out.push(...collectFiles(n.children))
  }
  return out
}

// ── DB persistence ─────────────────────────────────────────────────

async function loadDbStore(pp: string): Promise<ImportDbStore> {
  try {
    if (!(await fileExists(dbFilePath(pp)))) return emptyStore()
    const parsed = JSON.parse(await readFile(dbFilePath(pp))) as Partial<ImportDbStore>
    if (!parsed.directories || typeof parsed.directories !== "object") return emptyStore()
    return { version: 1, directories: parsed.directories as Record<string, ImportDb> }
  } catch { return emptyStore() }
}

async function loadDb(pp: string, importPath: string): Promise<ImportDb> {
  const store = await loadDbStore(pp)
  return cloneDb(store.directories[dbKey(importPath)] ?? EMPTY_DB)
}

async function saveDb(pp: string, importPath: string, db: ImportDb): Promise<void> {
  const store: ImportDbStore = { version: 1, directories: { [dbKey(importPath)]: cloneDb(db) } }
  await writeFileAtomic(dbFilePath(pp), JSON.stringify(store, null, 2))
}

function isCurrentProject(projectId: string): boolean {
  return useWikiStore.getState().project?.id === projectId
}

function isCurrentRun(projectId: string, runId?: number): boolean {
  return isCurrentProject(projectId) && (runId === undefined || runId === activeRunId)
}

// ── Public API ─────────────────────────────────────────────────────

export async function scanAndImport(
  project: WikiProject,
  importPath: string,
  options: ScanOptions = {},
): Promise<void> {
  if (!importPath || scanning) return
  scanning = true
  const pp = normalizePath(project.path)
  const importRoot = resolveImportPath(pp, importPath)

  try {
    if (!isCurrentRun(project.id, options.runId)) return

    const tree = await listDirectory(importRoot)
    const db = await loadDb(pp, importRoot)
    const nextDb: ImportDb = { files: {}, lastScan: Date.now() }
    const llmConfig = resolveDefaultModel(useWikiStore.getState().llmConfig)
    const changed: Array<{ key: string; md5: string; destPath: string }> = []

    for (const file of collectFiles(tree)) {
      try {
        const srcPath = normalizePath(file.path)
        if (shouldSkipScheduledImportFile(pp, srcPath) || isSensitiveConfig(srcPath) || !isIngestableSourcePath(srcPath)) continue
        if (!isCurrentRun(project.id, options.runId)) return

        const size = await getFileSize(srcPath)
        if (size > MAX_BYTES) { console.warn(`[scheduled-import] skipping ${srcPath}: ${(size / 1024 / 1024).toFixed(1)} MB exceeds 100 MB limit`); continue }

        const key = srcPath
        const md5 = await getFileMd5(srcPath)
        if (db.files[key] === md5) { nextDb.files[key] = md5; continue }

        const destPath = scheduledImportDestinationForFile(pp, importRoot, file)
        if (normalizePath(destPath) !== srcPath) await copyFile(srcPath, destPath)
        changed.push({ key, md5, destPath })
      } catch (err) { console.warn(`[scheduled-import] skipped ${file.path}:`, err) }
    }

    if (!isCurrentRun(project.id, options.runId)) return

    if (changed.length > 0) {
      const destPaths = changed.map((c) => c.destPath)
      await Promise.all(destPaths.map((p) => preprocessFile(p).catch(() => {})))
      if (isCurrentRun(project.id, options.runId)) {
        const ids = await enqueueSourceIngest(project, destPaths, llmConfig)
        if (ids.length > 0) {
          for (const c of changed) nextDb.files[c.key] = c.md5
          const projectTree = await listDirectory(pp)
          useWikiStore.getState().setFileTree(projectTree)
          useWikiStore.getState().bumpDataVersion()
        } else {
          console.warn("[scheduled-import] LLM is not configured; changed files were not marked imported")
        }
      }
    }

    await saveDb(pp, importRoot, nextDb)
    const currentConfig = await loadScheduledImportConfig(pp)
    if (currentConfig) {
      await saveScheduledImportConfig(pp, { ...currentConfig, lastScan: nextDb.lastScan })
    }
    if (isCurrentProject(project.id) && currentConfig) {
      useWikiStore.getState().setScheduledImportConfig({ ...currentConfig, lastScan: nextDb.lastScan })
    }
  } catch (err) {
    console.error("Scheduled import scan failed:", err)
  } finally {
    scanning = false
  }
}

export function startScheduledImport(project: WikiProject, config: ScheduledImportConfig): void {
  stopScheduledImport()
  if (!config.enabled || !config.path || config.interval <= 0) return

  const runId = ++activeRunId
  const ms = Math.max(1, Math.min(1440, config.interval)) * 60_000
  void scanAndImport(project, config.path, { runId })
  scanTimer = setInterval(() => { void scanAndImport(project, config.path, { runId }) }, ms)
}

export function stopScheduledImport(): void {
  activeRunId += 1
  if (scanTimer) { clearInterval(scanTimer); scanTimer = null }
}
