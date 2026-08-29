/**
 * Persistent serial queue for duplicate merge operations.
 *
 * Why a queue instead of direct execution:
 * - Merges rewrite cross-references across entire wiki; concurrent merges race on same files
 * - LLM calls take seconds; users want to queue multiple merges and continue working
 * - Queue survives app restarts so interrupted merges resume on next launch
 *
 * Architecture mirrors ingest-queue.ts with identical lifecycle, persistence format,
 * retry policy (up to 3 attempts), and registry-based path resolution.
 *
 * @license MIT © QMAI
 */

import { readFile, writeFile } from "@/commands/fs"
import { useWikiStore } from "@/stores/wiki-store"
import { normalizePath } from "@/lib/path-utils"
import { getProjectPathById } from "@/lib/project-identity"
import { hasUsableLlm } from "@/lib/has-usable-llm"
import { resolveDefaultModel } from "@/lib/novel/model-resolver"
import { executeMerge } from "@/lib/dedup-runner"
import type { DuplicateGroup } from "@/lib/dedup"

// ── Types ─────────────────────────────────────────────────────────────────────

export interface DedupTask {
  id: string
  projectId: string
  group: DuplicateGroup
  canonicalSlug: string
  status: "pending" | "processing" | "done" | "failed"
  addedAt: number
  error: string | null
  retryCount: number
}

// ── State ─────────────────────────────────────────────────────────────────────

let queue: DedupTask[] = []
let processing = false
let currentProjectId = ""
let currentProjectPath = ""
let currentAbortController: AbortController | null = null

// ── Persistence ───────────────────────────────────────────────────────────────

function queueFilePath(projectPath: string): string {
  return `${normalizePath(projectPath)}/.qmai/dedup-queue.json`
}

async function saveQueue(projectPath: string): Promise<void> {
  try {
    const toSave = queue.filter((t) => t.status !== "done")
    await writeFile(queueFilePath(projectPath), JSON.stringify(toSave, null, 2))
  } catch {
    // Non-critical failure
  }
}

async function loadQueue(
  projectPath: string,
  projectId: string,
): Promise<DedupTask[]> {
  try {
    const raw = await readFile(queueFilePath(projectPath))
    const tasks = JSON.parse(raw) as DedupTask[]
    return tasks.map((t) => ({
      ...t,
      projectId: t.projectId ?? projectId,
    }))
  } catch {
    return []
  }
}

// ── Queue Operations ──────────────────────────────────────────────────────────

function generateId(): string {
  return `dedup-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

/**
 * Generate stable sorting key for duplicate group matching.
 * Order-independent lowercase join using same logic as dedup-storage.
 */
export function groupKey(slugs: readonly string[]): string {
  return [...slugs].map((s) => s.toLowerCase()).sort().join(",")
}

/**
 * Add a merge task to the queue. Project must be currently active.
 * Idempotent: returns existing task id if same slug-set already queued/processing/failed.
 */
export async function enqueueMerge(
  projectId: string,
  group: DuplicateGroup,
  canonicalSlug: string,
): Promise<string> {
  if (!currentProjectId || currentProjectId !== projectId) {
    throw new Error(
      `enqueueMerge: project ${projectId} is not the active project (current: ${currentProjectId || "<none>"})`,
    )
  }

  const key = groupKey(group.slugs)
  const existing = queue.find(
    (t) =>
      t.projectId === projectId &&
      t.status !== "done" &&
      groupKey(t.group.slugs) === key,
  )
  if (existing) return existing.id

  const task: DedupTask = {
    id: generateId(),
    projectId,
    group,
    canonicalSlug,
    status: "pending",
    addedAt: Date.now(),
    error: null,
    retryCount: 0,
  }

  queue.push(task)
  await saveQueue(currentProjectPath)
  processNext(currentProjectId)
  return task.id
}

/**
 * Reset a failed task to pending, clearing error and resetting retry count.
 * Gives user full 3 attempts again.
 */
export async function retryTask(taskId: string): Promise<void> {
  const task = queue.find((t) => t.id === taskId)
  if (!task) return
  if (task.projectId !== currentProjectId) return

  task.status = "pending"
  task.error = null
  task.retryCount = 0
  await saveQueue(currentProjectPath)
  processNext(currentProjectId)
}

/**
 * Cancel/delete a task. If currently running, abort the LLM call first.
 * Backup snapshots already on disk are preserved regardless.
 */
export async function cancelTask(taskId: string): Promise<void> {
  const task = queue.find((t) => t.id === taskId)
  if (!task) return
  if (task.projectId !== currentProjectId) return

  if (task.status === "processing") {
    if (currentAbortController) {
      currentAbortController.abort()
      currentAbortController = null
    }
    processing = false
  }

  queue = queue.filter((t) => t.id !== taskId)
  await saveQueue(currentProjectPath)
  processNext(currentProjectId)
}

export function getQueue(): readonly DedupTask[] {
  return queue
}

export function getQueueSummary(): {
  pending: number
  processing: number
  failed: number
  total: number
} {
  return {
    pending: queue.filter((t) => t.status === "pending").length,
    processing: queue.filter((t) => t.status === "processing").length,
    failed: queue.filter((t) => t.status === "failed").length,
    total: queue.length,
  }
}

/**
 * Test helper: wipe in-memory state without touching disk.
 * Production code should use pauseQueue() to persist state first.
 */
export function clearQueueState(): void {
  if (currentAbortController) {
    currentAbortController.abort()
  }
  queue = []
  processing = false
  currentProjectId = ""
  currentProjectPath = ""
  currentAbortController = null
}

/**
 * Project-switch handshake: flush active project's queue to disk
 * (reverting any in-flight task to pending), then clear in-memory state.
 */
export async function pauseQueue(): Promise<void> {
  if (!currentProjectId || !currentProjectPath) return

  const pausedProjectPath = currentProjectPath

  if (currentAbortController) {
    currentAbortController.abort()
    currentAbortController = null
  }
  processing = false

  for (const task of queue) {
    if (task.status === "processing") {
      task.status = "pending"
    }
  }

  await saveQueue(pausedProjectPath)

  queue = []
  currentProjectId = ""
  currentProjectPath = ""
}

/**
 * Load a project's queue from disk and resume processing.
 * Tasks left in "processing" by abrupt exit revert to "pending".
 */
export async function restoreQueue(
  projectId: string,
  projectPath: string,
): Promise<void> {
  const pp = normalizePath(projectPath)
  queue = []
  processing = false
  currentAbortController = null
  currentProjectId = projectId
  currentProjectPath = pp

  const saved = await loadQueue(pp, projectId)
  if (saved.length === 0) return

  const mine = saved.filter((t) => t.projectId === projectId)
  if (mine.length !== saved.length) {
    console.warn(
      `[Dedup Queue] Dropped ${saved.length - mine.length} cross-project tasks during restore`,
    )
  }

  let restored = 0
  for (const task of mine) {
    if (task.status === "processing") {
      task.status = "pending"
      restored++
    }
  }

  queue = mine
  await saveQueue(pp)

  const pending = queue.filter((t) => t.status === "pending").length
  if (pending > 0 || restored > 0) {
    processNext(projectId)
  }
}

// ── Processing ────────────────────────────────────────────────────────────────

const MAX_RETRIES = 3

async function processNext(projectId: string): Promise<void> {
  if (processing) return
  if (currentProjectId !== projectId) return

  const next = queue.find(
    (t) => t.projectId === projectId && t.status === "pending",
  )
  if (!next) return

  const registryPath = await getProjectPathById(projectId)
  const pp = registryPath ? normalizePath(registryPath) : ""
  if (currentProjectId !== projectId) return

  if (!pp) {
    next.status = "failed"
    next.error = "Project not found in registry (was it deleted?)"
    await saveQueue(currentProjectPath)
    processNext(projectId)
    return
  }

  processing = true
  next.status = "processing"
  await saveQueue(pp)
  if (currentProjectId !== projectId) return

  const llmConfig = resolveDefaultModel(useWikiStore.getState().llmConfig)

  if (!hasUsableLlm(llmConfig)) {
    next.status = "failed"
    next.error = "LLM not configured — set API key in Settings"
    processing = false
    await saveQueue(pp)
    return
  }


  currentAbortController = new AbortController()

  try {
    await executeMerge(pp, next.group, next.canonicalSlug, llmConfig, {
      signal: currentAbortController.signal,
    })
    if (currentProjectId !== projectId) return

    currentAbortController = null
    queue = queue.filter((t) => t.id !== next.id)
    await saveQueue(pp)
    // Notify rest of app that wiki tree changed.
    useWikiStore.getState().bumpDataVersion()

  } catch (err) {
    if (currentProjectId !== projectId) return
    currentAbortController = null
    const message = err instanceof Error ? err.message : String(err)
    next.retryCount++
    next.error = message

    if (next.retryCount >= MAX_RETRIES) {
      next.status = "failed"
      console.log(
        `[Dedup Queue] Failed (${next.retryCount}x): ${next.group.slugs.join(",")} — ${message}`,
      )
    } else {
      next.status = "pending"
      console.log(
        `[Dedup Queue] Error (retry ${next.retryCount}/${MAX_RETRIES}): ${next.group.slugs.join(",")} — ${message}`,
      )
    }
    await saveQueue(pp)
  }

  processing = false
  processNext(projectId)
}
