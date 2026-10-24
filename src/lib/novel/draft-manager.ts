import { writeFile, writeFileAtomic, fileExists, createDirectory, readFile, listDirectory } from "@/commands/fs"
import { parseFrontmatter } from "@/lib/frontmatter"
import { getFileStem, normalizePath } from "@/lib/path-utils"
import type { FileNode } from "@/types/wiki"
import type { ChapterDraft, DraftStatus } from "./lifecycle-types"
import { DRAFTS_DIR } from "./lifecycle-types"

function generateDraftId(): string {
  return `draft_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
}

function draftsDir(projectPath: string): string {
  return `${normalizePath(projectPath)}/${DRAFTS_DIR}`
}

async function ensureDraftsDir(projectPath: string): Promise<void> {
  const dir = draftsDir(projectPath)
  if (!await fileExists(dir)) {
    await createDirectory(dir)
  }
}

function buildDraftContent(draft: ChapterDraft): string {
  const metaLines: string[] = [
    `draft_id: ${draft.id}`,
    `chapter_name: ${draft.chapterName}`,
    `status: ${draft.status}`,
    `created_at: ${draft.createdAt}`,
  ]
  if (draft.sourceConversationId) metaLines.push(`source_conversation_id: ${draft.sourceConversationId}`)
  if (draft.sourceMessageId) metaLines.push(`source_message_id: ${draft.sourceMessageId}`)
  return `---\n${metaLines.join("\n")}\n---\n\n${draft.content}`
}

export async function writeDraft(
  projectPath: string,
  chapterName: string,
  content: string,
  meta?: { sourceConversationId?: string; sourceMessageId?: string },
): Promise<ChapterDraft> {
  await ensureDraftsDir(projectPath)
  const draft: ChapterDraft = {
    id: generateDraftId(),
    chapterName,
    content,
    createdAt: Date.now(),
    status: "draft",
    sourceConversationId: meta?.sourceConversationId,
    sourceMessageId: meta?.sourceMessageId,
  }
  const filePath = `${draftsDir(projectPath)}/${draft.id}.md`
  await writeFile(filePath, buildDraftContent(draft))
  return draft
}

export interface DraftManagerDeps {
  fileExists: (path: string) => Promise<boolean>
  createDirectory: (path: string) => Promise<void>
  writeFile: (path: string, contents: string) => Promise<void>
  writeFileAtomic: (path: string, contents: string) => Promise<void>
  readFile: (path: string) => Promise<string>
  listDirectory: (path: string) => Promise<FileNode[]>
}

const defaultDeps: DraftManagerDeps = {
  fileExists,
  createDirectory,
  writeFile,
  writeFileAtomic,
  readFile,
  listDirectory,
}

const DRAFT_STATUSES: readonly DraftStatus[] = ["draft", "confirming", "saving", "saved", "failed"]

function projectRoot(projectPath: string): string {
  return normalizePath(projectPath).replace(/\/+$/, "")
}

function parseStoredDraft(text: string, fallbackId: string): ChapterDraft | null {
  const { frontmatter, body } = parseFrontmatter(text)
  if (!frontmatter) return null
  const raw = frontmatter as Record<string, unknown>
  const id = String(raw.draft_id ?? fallbackId).trim()
  const chapterName = String(raw.chapter_name ?? "").trim()
  if (!id || !chapterName) return null
  const statusRaw = String(raw.status ?? "draft")
  const status = DRAFT_STATUSES.includes(statusRaw as DraftStatus) ? statusRaw as DraftStatus : "draft"
  const createdAt = Number(raw.created_at)
  return {
    id,
    chapterName,
    content: body.replace(/^\r?\n/, ""),
    createdAt: Number.isFinite(createdAt) ? createdAt : Date.now(),
    status,
    sourceConversationId: raw.source_conversation_id ? String(raw.source_conversation_id) : undefined,
    sourceMessageId: raw.source_message_id ? String(raw.source_message_id) : undefined,
  }
}

export function formalChapterPathForDraft(
  projectPath: string,
  chapterName: string,
  selectedFile: string | null,
): string {
  const safeName = chapterName.replace(/[\\/]/g, "").trim()
  if (!safeName) throw new Error("草稿没有章节名")
  const root = projectRoot(projectPath)
  if (!root) throw new Error("没有项目，不能写入正式章")
  if (selectedFile) {
    const selected = normalizePath(selectedFile)
    if (getFileStem(selected) === safeName && selected.startsWith(`${root}/`)) {
      return selected
    }
  }
  return `${root}/wiki/chapters/${safeName}.md`
}

export async function listChapterDrafts(
  projectPath: string,
  deps: DraftManagerDeps = defaultDeps,
): Promise<ChapterDraft[]> {
  const dir = draftsDir(projectPath)
  if (!await deps.fileExists(dir)) return []
  const nodes = await deps.listDirectory(dir)
  const drafts: ChapterDraft[] = []
  for (const node of nodes) {
    if (node.is_dir || !node.name.endsWith(".md")) continue
    const text = await deps.readFile(node.path || `${dir}/${node.name}`)
    const draft = parseStoredDraft(text, node.name.replace(/\.md$/, ""))
    if (draft) drafts.push(draft)
  }
  return drafts
}

async function ensureParent(path: string, deps: DraftManagerDeps): Promise<void> {
  const parent = path.slice(0, path.lastIndexOf("/"))
  if (!parent || await deps.fileExists(parent)) return
  const grand = parent.slice(0, parent.lastIndexOf("/"))
  if (grand && !await deps.fileExists(grand)) await deps.createDirectory(grand)
  await deps.createDirectory(parent)
}

export async function acceptChapterDraft(
  input: {
    projectPath: string
    draftId: string
    formalChapterPath: string
    confirmed: boolean
  },
  deps: DraftManagerDeps = defaultDeps,
): Promise<{ formalChapterPath: string }> {
  if (!input.confirmed) throw new Error("采纳草稿必须先确认")
  const root = projectRoot(input.projectPath)
  const target = normalizePath(input.formalChapterPath)
  if (!root || !target.startsWith(`${root}/`) || target.includes("..")) {
    throw new Error("正式章必须写在这本书里")
  }
  const drafts = await listChapterDrafts(input.projectPath, deps)
  const draft = drafts.find((item) => item.id === input.draftId)
  if (!draft) throw new Error("找不到草稿")
  if (!draft.content.trim()) throw new Error("草稿没有正文")
  await ensureParent(target, deps)
  await deps.writeFileAtomic(target, draft.content)
  const written = await deps.readFile(target)
  if (written !== draft.content) throw new Error("写入后读回不一致，没有记成已采纳")
  await deps.writeFile(
    `${draftsDir(input.projectPath)}/${draft.id}.md`,
    buildDraftContent({ ...draft, status: "saved" }),
  )
  return { formalChapterPath: target }
}
