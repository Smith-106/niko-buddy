/**
 * @license MIT © QMAI
 *
 * Soft-delete trash system: move files to `.trash/`, restore them,
 * and periodically purge expired items.
 */
import { createDirectory, deleteFile, fileExists, readFile, writeFile } from "@/commands/fs"
import { normalizePath } from "@/lib/path-utils"
import { makeChapterFileStem, makeSafeFileSlug } from "@/lib/wiki-filename"

export type TrashItemKind = "chapter" | "outline" | "page" | "file" | "history"

export interface TrashItem {
  id: string
  name: string
  originalPath: string
  trashPath: string
  deletedAt: number
  expiresAt: number
  kind: TrashItemKind
}

export interface RestoreTrashResult {
  item: TrashItem
  restoredPath: string
  renamed: boolean
}

const RETENTION_DAYS = 30
const DAY_MS = 86_400_000

// ── Path helpers ───────────────────────────────────────────────────

function trashRoot(pp: string): string {
  return `${normalizePath(pp)}/.trash`
}
function trashFilesDir(pp: string): string {
  return `${trashRoot(pp)}/files`
}
function trashIndexFile(pp: string): string {
  return `${trashRoot(pp)}/items.json`
}

// ── String helpers ─────────────────────────────────────────────────

function basename(p: string): string {
  const n = normalizePath(p)
  return n.slice(n.lastIndexOf("/") + 1)
}
function dirname(p: string): string {
  const n = normalizePath(p)
  const i = n.lastIndexOf("/")
  return i >= 0 ? n.slice(0, i) : ""
}
function extOf(name: string): string {
  const i = name.lastIndexOf(".")
  return i > 0 ? name.slice(i) : ""
}
function stemOf(name: string): string {
  const ext = extOf(name)
  return ext ? name.slice(0, -ext.length) : name
}

function formatTimestamp(ts: number): string {
  const d = new Date(ts)
  const p = (n: number) => String(n).padStart(2, "0")
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`
}

function generateId(now: number): string {
  return `${formatTimestamp(now)}-${Math.random().toString(36).slice(2, 8)}`
}

// ── Frontmatter extraction ─────────────────────────────────────────

function readFrontmatterField(content: string, field: string): string | null {
  const esc = field.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  return content.match(new RegExp(`^${esc}:\\s*["']?(.+?)["']?\\s*$`, "m"))?.[1]?.trim() ?? null
}

function resolveTitle(content: string, fallback: string): string {
  return readFrontmatterField(content, "title") ?? content.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? stemOf(fallback)
}

function resolveChapterNum(content: string): number | null {
  const raw = readFrontmatterField(content, "chapter_number")
  if (!raw) return null
  const n = Number.parseInt(raw, 10)
  return Number.isFinite(n) && n > 0 ? n : null
}

function buildConflictStem(item: TrashItem, content: string): string {
  const title = resolveTitle(content, item.name)
  if (item.kind === "chapter") return makeChapterFileStem(title, resolveChapterNum(content))
  if (item.kind === "outline") return makeSafeFileSlug(title, stemOf(item.name))
  return stemOf(item.name)
}

// ── Persistence ────────────────────────────────────────────────────

function parseItems(raw: string): TrashItem[] {
  const arr = JSON.parse(raw)
  if (!Array.isArray(arr)) return []
  return arr.filter((o): o is TrashItem =>
    o != null && typeof o === "object" &&
    typeof o.id === "string" &&
    typeof o.name === "string" &&
    typeof o.originalPath === "string" &&
    typeof o.trashPath === "string" &&
    typeof o.deletedAt === "number" &&
    typeof o.expiresAt === "number" &&
    typeof o.kind === "string",
  )
}

async function readItems(pp: string): Promise<TrashItem[]> {
  try { return parseItems(await readFile(trashIndexFile(pp))) } catch { return [] }
}

async function writeItems(pp: string, items: TrashItem[]): Promise<void> {
  await createDirectory(trashRoot(pp))
  await writeFile(trashIndexFile(pp), JSON.stringify(items, null, 2))
}

async function ensureDirs(pp: string): Promise<void> {
  await createDirectory(trashRoot(pp))
  await createDirectory(trashFilesDir(pp))
}

// ── Public API ─────────────────────────────────────────────────────

/** List trash items sorted newest-first. */
export async function listTrashItems(projectPath: string): Promise<TrashItem[]> {
  const items = await readItems(projectPath)
  return items.sort((a, b) => b.deletedAt - a.deletedAt)
}

/** Move a file into the trash, returning the created trash item. */
export async function moveFileToTrash(
  projectPath: string,
  filePath: string,
  kind: TrashItemKind,
  now = Date.now(),
): Promise<TrashItem> {
  const pp = normalizePath(projectPath)
  const fullPath = normalizePath(filePath)
  const name = basename(fullPath)
  const id = generateId(now)
  const destPath = `${trashFilesDir(pp)}/${id}${extOf(name)}`

  let content: string
  try { content = await readFile(fullPath) } catch { content = "" }

  await ensureDirs(pp)
  await writeFile(destPath, content)

  const item: TrashItem = {
    id,
    name,
    originalPath: fullPath,
    trashPath: destPath,
    deletedAt: now,
    expiresAt: now + RETENTION_DAYS * DAY_MS,
    kind,
  }
  const items = await readItems(pp)
  await writeItems(pp, [item, ...items])

  try { await deleteFile(fullPath) } catch { /* ghost entry */ }
  return item
}

/** Resolve a conflict-free restore path, appending a counter if needed. */
async function resolveRestoreTarget(item: TrashItem, content: string): Promise<{ path: string; renamed: boolean }> {
  const original = normalizePath(item.originalPath)
  if (!(await fileExists(original))) return { path: original, renamed: false }

  const dir = dirname(original)
  const name = basename(original)
  const ext = extOf(name)
  const stem = buildConflictStem(item, content)
  const candidate = `${dir}/${stem}${ext}`
  if (!(await fileExists(candidate))) return { path: candidate, renamed: true }

  let idx = 2
  for (;;) {
    const next = `${dir}/${stem}-${idx}${ext}`
    if (!(await fileExists(next))) return { path: next, renamed: true }
    idx++
  }
}

/** Restore a trashed file to its original (or conflict-resolved) path. */
export async function restoreTrashItem(
  projectPath: string,
  itemId: string,
  now = Date.now(),
): Promise<RestoreTrashResult> {
  const pp = normalizePath(projectPath)
  const items = await readItems(pp)
  const item = items.find((c) => c.id === itemId)
  if (!item) throw new Error("回收站项目不存在")

  const content = await readFile(item.trashPath)
  void now

  const target = await resolveRestoreTarget(item, content)
  const dir = dirname(target.path)
  if (dir) await createDirectory(dir)
  await writeFile(target.path, content)
  await deleteFile(item.trashPath)
  await writeItems(pp, items.filter((c) => c.id !== itemId))

  return { item, restoredPath: target.path, renamed: target.renamed }
}

/** Delete trash items whose retention period has expired. */
export async function cleanupExpiredTrashItems(
  projectPath: string,
  now = Date.now(),
): Promise<{ deletedCount: number }> {
  const pp = normalizePath(projectPath)
  const items = await readItems(pp)
  const surviving: TrashItem[] = []
  let deletedCount = 0

  for (const item of items) {
    if (item.expiresAt <= now) {
      try { await deleteFile(item.trashPath) } catch { /* already gone */ }
      deletedCount++
    } else {
      surviving.push(item)
    }
  }
  if (deletedCount > 0) await writeItems(pp, surviving)
  return { deletedCount }
}

/** Days remaining before a trash item auto-expires. */
export function getTrashDaysRemaining(item: TrashItem, now = Date.now()): number {
  return Math.max(0, Math.ceil((item.expiresAt - now) / DAY_MS))
}

/** Read the full text content of a trashed file. */
export async function readTrashItemContent(item: TrashItem): Promise<string> {
  return await readFile(item.trashPath)
}

/** Permanently delete a single trash item. */
export async function permanentlyDeleteTrashItem(
  projectPath: string,
  itemId: string,
): Promise<void> {
  const pp = normalizePath(projectPath)
  const items = await readItems(pp)
  const item = items.find((c) => c.id === itemId)
  if (!item) throw new Error("回收站项目不存在")
  try { await deleteFile(item.trashPath) } catch { /* already gone */ }
  await writeItems(pp, items.filter((c) => c.id !== itemId))
}

/** Permanently delete every trash item. Returns the count removed. */
export async function permanentlyDeleteAllTrashItems(
  projectPath: string,
): Promise<number> {
  const pp = normalizePath(projectPath)
  const items = await readItems(pp)
  for (const item of items) {
    try { await deleteFile(item.trashPath) } catch { /* ignore */ }
  }
  await writeItems(pp, [])
  return items.length
}
