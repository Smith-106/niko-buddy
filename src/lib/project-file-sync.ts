/**
 * @license MIT © QMAI
 *
 * Project file-system synchronisation — watches for external file
 * changes, processes raw-source ingest, and cascades wiki-page cleanup
 * on external deletions.
 */
import { listen, type UnlistenFn } from "@tauri-apps/api/event"
import { readFile, listDirectory } from "@/commands/fs"
import {
  rescanProjectFiles,
  startProjectFileWatcher,
  stopProjectFileWatcher,
  type FileSyncPayload,
} from "@/commands/file-sync"
import { useFileSyncStore } from "@/stores/file-sync-store"
import { useWikiStore } from "@/stores/wiki-store"
import { getFileStem, normalizePath } from "@/lib/path-utils"
import { resolveDefaultModel } from "@/lib/novel/model-resolver"
import type { WikiProject } from "@/types/wiki"
import type { SourceWatchConfig } from "@/stores/wiki-store"
import type { FileChangeTask } from "@/commands/file-sync"
import {
  cleanupDeletedWikiPages,
  deleteSourceFiles,
  enqueueSourceIngest,
  isIngestableSourcePath,
} from "@/lib/source-lifecycle"
import { isPathAllowedBySourceWatch, normalizeSourceWatchConfig } from "@/lib/source-watch-config"

let unlistenQueue: UnlistenFn | null = null
let unlistenChanged: UnlistenFn | null = null
let startSeq = 0
let refreshTimer: ReturnType<typeof setTimeout> | null = null
let pendingPaths = new Set<string>()
let pendingTasks = new Map<string, FileChangeTask>()
let activeWatchConfig = normalizeSourceWatchConfig()

export async function startProjectFileSync(
  project: WikiProject,
  sourceWatchConfig?: SourceWatchConfig,
): Promise<void> {
  await stopProjectFileSync()
  const seq = ++startSeq
  activeWatchConfig = normalizeSourceWatchConfig(sourceWatchConfig)
  useFileSyncStore.getState().setRunning(true)
  useFileSyncStore.getState().setLastError(null)

  unlistenQueue = await listen<FileSyncPayload>("file-sync://queue-updated", (event) => {
    if (event.payload.projectId !== useWikiStore.getState().project?.id) return
    useFileSyncStore.getState().setTasks(event.payload.tasks)
  })

  unlistenChanged = await listen<FileSyncPayload>("file-sync://changed", (event) => {
    const current = useWikiStore.getState().project
    if (!current || event.payload.projectId !== current.id) return
    scheduleRefresh(event.payload.tasks)
  })

  try {
    const queue = await startProjectFileWatcher(project.id, normalizePath(project.path), activeWatchConfig)
    if (seq !== startSeq || project.id !== useWikiStore.getState().project?.id) return
    useFileSyncStore.getState().setTasks(queue.tasks)
  } catch (err) {
    unlistenQueue?.(); unlistenChanged?.()
    unlistenQueue = null; unlistenChanged = null
    useFileSyncStore.getState().setLastError(String(err))
    throw err
  } finally {
    if (seq === startSeq) useFileSyncStore.getState().setRunning(false)
  }
}

export async function stopProjectFileSync(): Promise<void> {
  startSeq++
  unlistenQueue?.(); unlistenChanged?.()
  unlistenQueue = null; unlistenChanged = null
  if (refreshTimer) { clearTimeout(refreshTimer); refreshTimer = null }
  pendingPaths.clear(); pendingTasks.clear()
  useFileSyncStore.getState().clear()
  try { await stopProjectFileWatcher() } catch { /* stale watcher */ }
}

export async function rescanProjectFileSync(
  project: WikiProject,
  sourceWatchConfig?: SourceWatchConfig,
): Promise<void> {
  const config = normalizeSourceWatchConfig(sourceWatchConfig ?? useWikiStore.getState().sourceWatchConfig)
  activeWatchConfig = config

  const result = await rescanProjectFiles(project.id, normalizePath(project.path), config)
  if (useWikiStore.getState().project?.id !== project.id) return
  useFileSyncStore.getState().setTasks(result.queue.tasks)

  if (useWikiStore.getState().project?.id !== project.id) return
  if (result.changedTasks.length > 0) {
    const paths = [...new Set(result.changedTasks.map((t) => t.path))]
    await processBatch(project, paths, result.changedTasks)
  } else {
    await refreshTree(project, [])
  }
}

function scheduleRefresh(tasks: FileChangeTask[]): void {
  for (const task of tasks) {
    pendingPaths.add(task.path)
    pendingTasks.set(task.path, task)
  }
  if (refreshTimer) return
  refreshTimer = setTimeout(() => {
    refreshTimer = null
    const project = useWikiStore.getState().project
    if (!project) { pendingPaths.clear(); pendingTasks.clear(); return }
    const paths = [...pendingPaths]
    const tasks = [...pendingTasks.values()]
    pendingPaths.clear(); pendingTasks.clear()
    void processBatch(project, paths, tasks)
  }, 250)
}

async function processBatch(project: WikiProject, paths: string[], tasks: FileChangeTask[]): Promise<void> {
  await cleanupDeleted(project, tasks)
  await enqueueRawChanges(project, tasks)
  await refreshTree(project, paths)
}

async function refreshTree(project: WikiProject, relativePaths: string[]): Promise<void> {
  const pp = normalizePath(project.path)
  const store = useWikiStore.getState()
  try {
    const tree = await listDirectory(pp)
    useWikiStore.getState().setFileTree(tree)
  } catch (err) { console.warn("[file-sync] failed to refresh file tree:", err) }

  store.bumpDataVersion()

  const selected = store.selectedFile ? normalizePath(store.selectedFile) : null
  if (!selected) return

  const rel = selected.startsWith(`${pp}/`) ? selected.slice(pp.length + 1) : selected
  if (!relativePaths.includes(rel)) return

  try {
    const content = await readFile(selected)
    const current = useWikiStore.getState().fileContent
    if (current && current !== content) {
      console.warn("[file-sync] 检测到编辑器有未保存内容，跳过文件刷新:", selected)
      return
    }
    useWikiStore.getState().setFileContent(content)
  } catch {
    useWikiStore.getState().setSelectedFile(null)
    useWikiStore.getState().setFileContent("")
  }
}

async function enqueueRawChanges(project: WikiProject, tasks: FileChangeTask[]): Promise<void> {
  const config = normalizeSourceWatchConfig(activeWatchConfig)
  if (!config.enabled || !config.autoIngest) return

  const candidates = tasks
    .filter((t) => t.projectId === project.id)
    .filter((t) => t.kind === "created" || t.kind === "modified")
    .map((t) => t.path)
    .filter(isIngestableRaw)

  const paths = candidates.filter((rel) => isPathAllowedBySourceWatch(rel, config))
  if (paths.length === 0) return

  try {
    await enqueueSourceIngest(project, paths, resolveDefaultModel(useWikiStore.getState().llmConfig))
  } catch (err) { console.error("[file-sync] failed to enqueue raw source ingest:", err) }
}

function isIngestableRaw(relativePath: string): boolean {
  const path = normalizePath(relativePath)
  if (!path.startsWith("raw/sources/")) return false
  return isIngestableSourcePath(path)
}

async function cleanupDeleted(project: WikiProject, tasks: FileChangeTask[]): Promise<void> {
  const deleted = tasks
    .filter((t) => t.projectId === project.id && t.kind === "deleted")
    .map((t) => normalizePath(t.path))
  if (deleted.length === 0) return

  const rawSources = deleted.filter(isRawSourceForCascade)
  const wikiPages = deleted.filter(isWikiPageForCascade)

  let deletedSlugs = new Set<string>()
  if (rawSources.length > 0) {
    try {
      const result = await deleteSourceFiles(project.path, rawSources, {
        fileAlreadyDeleted: true,
        logReason: rawSources.length === 1 ? "external delete" : "external batch delete",
      })
      deletedSlugs = new Set(result.deletedWikiPaths.map((p) => getFileStem(p)))
    } catch (err) { console.error("[file-sync] failed to clean deleted raw sources:", err) }
  }

  const wikiToClean = wikiPages.filter((p) => !deletedSlugs.has(getFileStem(p)))
  if (wikiToClean.length > 0) {
    try { await cleanupDeletedWikiPages(project.path, wikiToClean) }
    catch (err) { console.error("[file-sync] failed to clean deleted wiki pages:", err) }
  }
}

function isRawSourceForCascade(relativePath: string): boolean {
  const path = normalizePath(relativePath)
  if (!path.startsWith("raw/sources/")) return false
  if (path.includes("/.cache/")) return false
  const name = path.split("/").pop() ?? ""
  return Boolean(name && !name.startsWith("."))
}

function isWikiPageForCascade(relativePath: string): boolean {
  const path = normalizePath(relativePath)
  const lc = path.toLowerCase()
  if (!lc.startsWith("wiki/") || !lc.endsWith(".md")) return false
  const name = lc.split("/").pop()
  if (name === "index.md" || name === "log.md" || name === "overview.md") return false
  return !lc.startsWith("wiki/media/")
}

