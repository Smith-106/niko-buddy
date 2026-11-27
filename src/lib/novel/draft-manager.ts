import { writeFile, writeFileAtomic, writeFilesAtomic, fileExists, createDirectory, readFile, readFileAsBase64, listDirectory } from "@/commands/fs"
import { parseFrontmatter, type FrontmatterParseResult } from "@/lib/frontmatter"
import { getFileStem, normalizePath } from "@/lib/path-utils"
import type { FileNode } from "@/types/wiki"
import i18n from "@/i18n"
import { findChapterFileByNumber } from "./chapter-utils"
import type { ChapterDraft, DraftAdoptionGate, DraftGateStatus, DraftStatus } from "./lifecycle-types"
import { DRAFTS_DIR } from "./lifecycle-types"
import { computeCheckpointDigest } from "./checkpoint-digest"
import { isChapterPage, parseChapterNumber } from "./chapter-meta"
import { parseChapterOrdinal } from "./chapter-typography"
import { finalizeChapterFrontmatterBlock } from "./formal-writeback"
import { withProjectLock } from "./novel-locks"

const DRAFT_ID = /^[a-zA-Z0-9_-]+$/

function generateDraftId(): string {
  return `draft_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
}

function draftsDir(projectPath: string): string {
  return `${projectRoot(projectPath)}/${DRAFTS_DIR}`
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
    `chapter_name: ${JSON.stringify(draft.chapterName)}`,
    `status: ${draft.status}`,
    `created_at: ${draft.createdAt}`,
  ]
  if (draft.sourceConversationId) metaLines.push(`source_conversation_id: ${draft.sourceConversationId}`)
  if (draft.sourceMessageId) metaLines.push(`source_message_id: ${draft.sourceMessageId}`)
  if (typeof draft.parentDraftId === "string" && DRAFT_ID.test(draft.parentDraftId)) {
    metaLines.push(`parent_draft_id: ${draft.parentDraftId}`)
  }
  if (typeof draft.revisionRound === "number" && Number.isInteger(draft.revisionRound) && draft.revisionRound >= 1) {
    metaLines.push(`revision_round: ${draft.revisionRound}`)
  }
  // 截断稿只在持久化层留 trace：采纳决策点必须能看出「这是截断稿，不是完整章」。
  if (draft.partial) metaLines.push("partial: true")
  if (draft.adoptionGate) {
    metaLines.push(`adoption_gate: ${draft.adoptionGate.status}`)
    if (draft.adoptionGate.bodySha256) metaLines.push(`reviewed_body_sha256: ${draft.adoptionGate.bodySha256}`)
  }
  return `---\n${metaLines.join("\n")}\n---\n\n${draft.content}`
}

export async function writeDraft(
  projectPath: string,
  chapterName: string,
  content: string,
  meta?: {
    sourceConversationId?: string
    sourceMessageId?: string
    partial?: boolean
    adoptionGate?: DraftGateStatus
    parentDraftId?: string
    revisionRound?: number
  },
): Promise<ChapterDraft> {
  await ensureDraftsDir(projectPath)
  const partial = meta?.partial === true || meta?.adoptionGate === "partial"
  let gateStatus = partial ? "partial" : meta?.adoptionGate
  if (gateStatus === "passed" && readDraftChapterNumber(chapterName) === undefined) gateStatus = "unassessed"
  const adoptionGate: DraftAdoptionGate | undefined = gateStatus === "passed"
    ? { status: gateStatus, bodySha256: await digestDraftBody(chapterName, content) }
    : gateStatus ? { status: gateStatus } : undefined
  const parentDraftId =
    typeof meta?.parentDraftId === "string" && DRAFT_ID.test(meta.parentDraftId)
      ? meta.parentDraftId
      : undefined
  const revisionRound =
    typeof meta?.revisionRound === "number" && Number.isInteger(meta.revisionRound) && meta.revisionRound >= 1
      ? meta.revisionRound
      : undefined
  const draft: ChapterDraft = {
    id: generateDraftId(),
    chapterName,
    content,
    createdAt: Date.now(),
    status: "draft",
    sourceConversationId: meta?.sourceConversationId,
    sourceMessageId: meta?.sourceMessageId,
    ...(parentDraftId ? { parentDraftId } : {}),
    ...(revisionRound !== undefined ? { revisionRound } : {}),
    ...(partial ? { partial: true } : {}),
    ...(adoptionGate ? { adoptionGate } : {}),
  }
  const filePath = `${draftsDir(projectPath)}/${draft.id}.md`
  await writeFileAtomic(filePath, buildDraftContent(draft))
  return draft
}

export interface DraftManagerDeps {
  fileExists: (path: string) => Promise<boolean>
  createDirectory: (path: string) => Promise<void>
  writeFile: (path: string, contents: string) => Promise<void>
  writeFileAtomic: (path: string, contents: string) => Promise<void>
  readFile: (path: string) => Promise<string>
  listDirectory: (path: string) => Promise<FileNode[]>
  // 保留旧依赖注入形状；实际读写必须有精确字节与批量写能力，不降级。
  readFileAsBase64?: typeof readFileAsBase64
  writeFilesAtomic?: typeof writeFilesAtomic
}

const defaultDeps: DraftManagerDeps = {
  fileExists,
  createDirectory,
  writeFile,
  writeFileAtomic,
  readFile,
  listDirectory,
  readFileAsBase64: (path) => readFileAsBase64(path),
  writeFilesAtomic,
}

const MARKDOWN_PATH = /\/[^/]+\.md$/i
const DRAFT_STATUSES: readonly DraftStatus[] = ["draft", "confirming", "saving", "saved", "failed"]

const DRAFT_GATE_STATES = new Set<string>(["passed", "unassessed", "blocked", "manual_review", "partial"] satisfies DraftGateStatus[])

export function readDraftChapterNumber(chapterName: string): number | undefined {
  const canonical = parseChapterOrdinal(chapterName)
  if (canonical !== null) return Number.isSafeInteger(canonical) && canonical > 0 ? canonical : undefined
  const english = Number(/^chapter[- ](\d+)(?:$|[ -])/i.exec(chapterName)?.[1])
  return Number.isSafeInteger(english) && english > 0 ? english : undefined
}

function digestDraftBody(chapterName: string, content: string): Promise<string> {
  return computeCheckpointDigest(JSON.stringify([chapterName, content]))
}

export function getDraftGateStatus(draft: Pick<ChapterDraft, "partial" | "adoptionGate">): DraftGateStatus {
  if (draft.partial === true || draft.adoptionGate?.status === "partial") return "partial"
  if (draft.adoptionGate == null) return "passed"
  const status = draft.adoptionGate.status
  return typeof status === "string" && DRAFT_GATE_STATES.has(status)
    ? (status as DraftGateStatus)
    : "unassessed"
}

export function draftNeedsGateReview(draft: Pick<ChapterDraft, "partial" | "adoptionGate">): boolean {
  return getDraftGateStatus(draft) !== "passed"
}

function parseDraftAdoptionGate(raw: Record<string, unknown>): DraftAdoptionGate | undefined {
  const source = raw.source_conversation_id
  const status = raw.adoption_gate
  if (source !== "mcp:deep-chapter" && source !== "mcp:external-agent" && status === undefined) return undefined
  if (typeof status !== "string" || !DRAFT_GATE_STATES.has(status)) return { status: "unassessed" }
  if (status !== "passed") return { status: status as DraftGateStatus }
  const bodySha256 = raw.reviewed_body_sha256
  return typeof bodySha256 === "string" && /^[a-f0-9]{64}$/.test(bodySha256)
    ? { status: "passed", bodySha256 }
    : { status: "unassessed" }
}

function projectRoot(projectPath: string): string {
  return normalizePath(projectPath).replace(/\/+$/, "")
}

function parseStoredDraft(text: string, fallbackId: string): ChapterDraft | null {
  // 头部后的第一个空行属于存储格式，余下字节全是正文。通用解析器会贪婪消费空行。
  const header = /^\uFEFF?---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/.exec(text)?.[0]
  if (!header) return null
  const { frontmatter } = parseFrontmatter(header.replace(/^\uFEFF/, ""))
  if (!frontmatter) return null
  const raw = frontmatter as Record<string, unknown>
  const id = String(raw.draft_id ?? fallbackId)
  const chapterName = String(raw.chapter_name ?? "")
  if (id !== fallbackId || !chapterName.trim()) return null
  const statusRaw = String(raw.status ?? "draft")
  const status = DRAFT_STATUSES.includes(statusRaw as DraftStatus) ? statusRaw as DraftStatus : "draft"
  const createdAt = Number(raw.created_at)
  const partial = raw.partial === true || raw.partial === "true" || raw.adoption_gate === "partial"
  const adoptionGate = partial ? { status: "partial" as const } : parseDraftAdoptionGate(raw)
  const rawParentDraftId = typeof raw.parent_draft_id === "string" ? raw.parent_draft_id.trim() : ""
  const parentDraftId = rawParentDraftId && DRAFT_ID.test(rawParentDraftId) ? rawParentDraftId : undefined
  const rawRevisionRound =
    typeof raw.revision_round === "number"
      ? raw.revision_round
      : typeof raw.revision_round === "string" && /^\d+$/.test(raw.revision_round.trim())
        ? Number(raw.revision_round.trim())
        : NaN
  const revisionRound = Number.isSafeInteger(rawRevisionRound) && rawRevisionRound >= 1 ? rawRevisionRound : undefined
  return {
    id,
    chapterName,
    content: text.slice(header.length).replace(/^\r?\n/, ""),
    createdAt: Number.isFinite(createdAt) ? createdAt : Date.now(),
    status,
    sourceConversationId: raw.source_conversation_id ? String(raw.source_conversation_id) : undefined,
    sourceMessageId: raw.source_message_id ? String(raw.source_message_id) : undefined,
    ...(parentDraftId ? { parentDraftId } : {}),
    ...(revisionRound !== undefined ? { revisionRound } : {}),
    ...(partial ? { partial: true } : {}),
    ...(adoptionGate ? { adoptionGate } : {}),
  }
}

async function readExactMarkdown(path: string, deps: DraftManagerDeps): Promise<string> {
  if (!deps.readFileAsBase64) throw new Error("Draft storage requires byte-exact reads")
  const { base64 } = await deps.readFileAsBase64(path)
  return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true })
    .decode(Uint8Array.from(atob(base64), (byte) => byte.charCodeAt(0)))
}

async function validateStoredDraft(text: string, id: string): Promise<ChapterDraft | null> {
  const draft = parseStoredDraft(text, id)
  if (draft?.adoptionGate?.status === "passed" && (readDraftChapterNumber(draft.chapterName) === undefined
    || await digestDraftBody(draft.chapterName, draft.content) !== draft.adoptionGate.bodySha256)) {
    draft.adoptionGate = { status: "unassessed" }
  }
  return draft
}

async function readStoredDraft(path: string, id: string, deps: DraftManagerDeps): Promise<ChapterDraft | null> {
  return validateStoredDraft(await readExactMarkdown(path, deps), id)
}

function isChapterLeaf(root: string, target: string): boolean {
  const parent = target.slice(0, target.lastIndexOf("/"))
  return (parent === `${root}/wiki/chapters` || parent === `${root}/QM/chapters`)
    && MARKDOWN_PATH.test(target) && !target.includes("..")
}

function gatedFilenameNumber(stem: string): number | undefined {
  const canonical = /^chapter-(\d+)$/i.exec(stem)
  // 不让无效的规范文件名被匹配的 header 掩盖。
  return canonical ? Number(canonical[1]) : readDraftChapterNumber(stem)
}

export function formalChapterPathForDraft(
  projectPath: string,
  chapterName: string,
  selectedFile: string | null,
  gated = false,
): string {
  const safeName = chapterName.replace(/[\\/]/g, "").trim()
  if (!safeName) throw new Error("草稿没有章节名")
  const root = projectRoot(projectPath)
  if (!root) throw new Error("没有项目，不能写入正式章")
  if (gated) {
    const chapterNumber = readDraftChapterNumber(chapterName)
    if (chapterNumber === undefined) throw new Error(i18n.t("chat.draftReviewNeedsChapter"))
    const selected = normalizePath(selectedFile ?? "")
    if (isChapterLeaf(root, selected) && gatedFilenameNumber(getFileStem(selected)) === chapterNumber) {
      return selected
    }
    return `${root}/wiki/chapters/chapter-${String(chapterNumber).padStart(3, "0")}.md`
  }
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
    if (node.is_dir !== false || !node.name.endsWith(".md")) continue
    const id = node.name.slice(0, -3)
    const path = `${dir}/${node.name}`
    if (!DRAFT_ID.test(id) || (node.path && normalizePath(node.path) !== path)) continue
    const draft = await readStoredDraft(path, id, deps)
    if (draft) drafts.push(draft)
  }
  return drafts
}

/**
 * 采集既有正式章要保留的头部（含 frontmatter 及任何前置脏行）。
 *
 * 采纳只换正文：`parseFrontmatter().rawBlock` 在正常文件里就是文件前缀；
 * LLM 写过脏行的页靠 fallback 扫描命中，rawBlock 不在开头，此时要把前缀一起带上，
 * 否则采纳会顺手删掉并非本函数拥有的内容。
 */
function preserveExistingPrefix(text: string, header: FrontmatterParseResult, gated: boolean): string {
  const { rawBlock, frontmatter } = header
  if (!rawBlock) return text.startsWith("\uFEFF") ? "\uFEFF" : ""
  let blockStart = text.indexOf(rawBlock)
  let block = rawBlock
  // parseFrontmatter 的 fallback 扫描（前置脏行）在定位时跳过首字符 `-`，使 rawBlock 以 `--` 开头、
  // 缺失的 `-` 落在 prefix 末尾；此处补齐起始 `-`，保证 prefix + block 与原头部逐字节一致且为合法 YAML 围栏。
  if (!block.startsWith("---") && blockStart > 0 && text[blockStart - 1] === "-") {
    blockStart -= 1
    block = text.slice(blockStart, blockStart + rawBlock.length + 1)
  }
  const prefix = text.slice(0, blockStart)
  const separator = block.endsWith("\n") ? "" : block.includes("\r\n") ? "\r\n\r\n" : "\n\n"
  // R2-W01：任意非 final 的章节页（含 draft/revised/outline/planned/缺失 chapter_status）采纳后自动升级为 final，
  // 避免正式写回后被下游摄取判定为 skipped-not-final；非章节普通页（无 type: chapter 且无 chapter_number）原样保留。
  const shouldFinalize = gated || (frontmatter != null && isChapterPage(frontmatter))
  if (!shouldFinalize) return `${prefix}${block}${separator}`
  const nextBlock = finalizeChapterFrontmatterBlock(block)
  return `${prefix}${nextBlock}${separator}`
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
    expectedDraftContent?: string
  },
  deps: DraftManagerDeps = defaultDeps,
): Promise<{ formalChapterPath: string }> {
  if (!input.confirmed) throw new Error("采纳草稿必须先确认")
  const root = projectRoot(input.projectPath)
  const target = normalizePath(input.formalChapterPath)
  if (!root || !target.startsWith(`${root}/`) || target.includes("..") || !MARKDOWN_PATH.test(target)) {
    throw new Error("正式章必须写在这本书里")
  }
  if (!DRAFT_ID.test(input.draftId)) throw new Error("Invalid draft identifier")
  const draftPath = `${draftsDir(input.projectPath)}/${input.draftId}.md`
  // R2-W01：按字典序同时锁目标正式章与草稿文件，消除多草稿并发采纳竞态与 AB/BA 死锁。
  const [firstLock, secondLock] = [`chapter:${target}`, `draft:${draftPath}`].sort()
  return withProjectLock(firstLock, () => withProjectLock(secondLock, async () => {
    if (!await deps.fileExists(draftPath)) throw new Error("找不到草稿")
    const originalDraft = await readExactMarkdown(draftPath, deps)
    const draft = await validateStoredDraft(originalDraft, input.draftId)
    if (!draft) throw new Error("找不到草稿")
    if (!draft.content.trim()) throw new Error("草稿没有正文")
    if (input.expectedDraftContent !== undefined && draft.content !== input.expectedDraftContent) {
      throw new Error(i18n.t("mainControl.draftContentChanged"))
    }
    const gated = draft.adoptionGate !== undefined
    const chapterNumber = readDraftChapterNumber(draft.chapterName)
    if (gated && chapterNumber === undefined) throw new Error(i18n.t("chat.draftReviewNeedsChapter"))
    if (draftNeedsGateReview(draft)) {
      throw new Error(i18n.t("mainControl.draftGateRequired"))
    }
    if (draft.status === "saved") {
      throw new Error(i18n.t("mainControl.draftSavedAlready"))
    }
    if (draft.status === "failed") {
      throw new Error("草稿已丢弃，不能采纳")
    }
    const stem = getFileStem(target)
    const filenameNumber = gated ? gatedFilenameNumber(stem) : readDraftChapterNumber(stem)
    if (gated && !isChapterLeaf(root, target)) {
      throw new Error("Reviewed drafts require a direct chapter file in wiki/chapters or QM/chapters")
    }
    if (gated && filenameNumber !== undefined && filenameNumber !== chapterNumber) {
      throw new Error(i18n.t("mainControl.draftWrongChapter"))
    }
    const existing = await deps.fileExists(target) ? await readExactMarkdown(target, deps) : null
    const header = existing === null ? null : parseFrontmatter(existing.replace(/^\uFEFF/, ""))
    const existingNumber = parseChapterNumber(header?.frontmatter?.chapter_number)
    if (gated) {
      if ((header?.rawBlock && existingNumber !== chapterNumber)
        || (existingNumber !== chapterNumber && filenameNumber !== chapterNumber)) {
        throw new Error(i18n.t("mainControl.draftWrongChapter"))
      }
    } else {
      const targetNumber = existingNumber !== null && Number.isSafeInteger(existingNumber) && existingNumber > 0
        ? existingNumber : filenameNumber
      if (chapterNumber !== undefined && targetNumber !== undefined && targetNumber !== chapterNumber) {
        throw new Error(i18n.t("mainControl.draftWrongChapter"))
      }
    }
    // 正式章通常带 type/chapter_number/chapter_status 等 frontmatter，只换正文，
    // 否则采纳会把页面降级成非章节页（下游摄取按 isChapterPage 判定即 not_chapter）。
    // R2 补齐：当覆盖 wiki/chapters 或 QM/chapters 下原本无 frontmatter 的既有正式章文件时，
    // 同样补齐规范 frontmatter（type: chapter / chapter_number / chapter_status: final / title），
    // 确保下游 snapshot-scanner / export / chapter-meta 正确识别；非章节普通路径保持不动。
    const isFormalChapterDir =
      target.startsWith(`${root}/wiki/chapters/`) || target.startsWith(`${root}/QM/chapters/`)
    const resolvedChapterNumber = chapterNumber ?? filenameNumber
    const buildCanonicalFrontmatter = (num: number, bomPrefix = ""): string =>
      `${bomPrefix}---\ntype: chapter\nchapter_number: ${num}\nchapter_status: final\ntitle: ${JSON.stringify(draft.chapterName)}\n---\n\n`
    const existingBlock =
      existing !== null && header
        ? !header.rawBlock && isFormalChapterDir && resolvedChapterNumber !== undefined
          ? buildCanonicalFrontmatter(resolvedChapterNumber, existing.startsWith("\uFEFF") ? "\uFEFF" : "")
          : preserveExistingPrefix(existing, header, gated)
        : chapterNumber !== undefined
          ? buildCanonicalFrontmatter(chapterNumber)
          : ""
    const nextContent = `${existingBlock}${draft.content}`
    if (!deps.writeFilesAtomic) throw new Error("Draft acceptance requires a verified batch writer")
    await ensureParent(target, deps)
    await deps.writeFilesAtomic(
      [
        [target, nextContent],
        [draftPath, buildDraftContent({ ...draft, status: "saved" })],
      ],
      [existing, originalDraft],
    )
    return { formalChapterPath: target }
  }))
}

/**
 * 丢弃（标废）草稿：严禁对 `.qm-drafts` 调用 `deleteFile`（防破坏性删除策略拦截），
 * 改为锁内校验存在且未采纳（`status !== "saved"`），经 `writeFilesAtomic` 原位更新 `status: "failed"`。
 */
export async function discardChapterDraft(
  projectPath: string,
  draftId: string,
  deps: DraftManagerDeps = defaultDeps,
): Promise<void> {
  const root = projectRoot(projectPath)
  if (!root) throw new Error("没有项目，不能丢弃草稿")
  if (!DRAFT_ID.test(draftId)) throw new Error("Invalid draft identifier")
  const draftPath = `${draftsDir(projectPath)}/${draftId}.md`
  await withProjectLock(`draft:${draftPath}`, async () => {
    if (!await deps.fileExists(draftPath)) throw new Error("找不到草稿")
    const originalDraft = await readExactMarkdown(draftPath, deps)
    const draft = await validateStoredDraft(originalDraft, draftId)
    if (!draft) throw new Error("找不到草稿")
    if (draft.status === "saved") {
      throw new Error(i18n.t("mainControl.draftSavedAlready"))
    }
    if (draft.status === "failed") return
    if (!deps.writeFilesAtomic) throw new Error("Draft discard requires a verified batch writer")
    const nextContent = buildDraftContent({ ...draft, status: "failed" })
    await deps.writeFilesAtomic([[draftPath, nextContent]], [originalDraft])
  })
}

export async function resolveChapterDraftAdoptionTarget(
  projectPath: string,
  draft: Pick<ChapterDraft, "chapterName" | "adoptionGate">,
  selectedFile: string | null,
): Promise<string> {
  if (draft.adoptionGate === undefined) return formalChapterPathForDraft(projectPath, draft.chapterName, selectedFile)
  const root = projectRoot(projectPath)
  const chapterNumber = readDraftChapterNumber(draft.chapterName)
  if (chapterNumber === undefined) throw new Error(i18n.t("chat.draftReviewNeedsChapter"))
  const canonical = formalChapterPathForDraft(root, draft.chapterName, null, true)
  const existing = await findChapterFileByNumber(root, chapterNumber)
  if (existing === null) return canonical
  const target = normalizePath(existing)
  if (!isChapterLeaf(root, target)) throw new Error(i18n.t("mainControl.draftWrongChapter"))
  return target
}

export async function recordDraftAdoptionGate(
  projectPath: string,
  reviewed: ChapterDraft,
  status: DraftGateStatus,
  deps: DraftManagerDeps = defaultDeps,
): Promise<void> {
  const { id, content, chapterName, partial, adoptionGate: reviewedGate } = reviewed
  if (!reviewedGate) return
  if (!DRAFT_ID.test(id)) throw new Error("Invalid draft identifier")
  const { status: previousStatus, bodySha256: previousDigest } = reviewedGate
  const path = `${draftsDir(projectPath)}/${id}.md`
  await withProjectLock(`draft:${path}`, async () => {
    const originalDraft = await readExactMarkdown(path, deps)
    const draft = await validateStoredDraft(originalDraft, id)
    if (!draft?.adoptionGate || draft.status === "saved" || draft.status === "failed"
      || draft.content !== content || draft.chapterName !== chapterName || draft.partial !== partial
      || draft.adoptionGate.status !== previousStatus || draft.adoptionGate.bodySha256 !== previousDigest) {
      throw new Error("Draft changed during review; run the checks again")
    }
    if (status === "passed") {
      if (draft.partial) throw new Error(i18n.t("mainControl.draftGateRequired"))
      if (readDraftChapterNumber(draft.chapterName) === undefined) {
        throw new Error(i18n.t("chat.draftReviewNeedsChapter"))
      }
    }
    const adoptionGate: DraftAdoptionGate = status === "passed"
      ? { status, bodySha256: await digestDraftBody(draft.chapterName, draft.content) }
      : { status: draft.partial ? "partial" : status }
    const next = buildDraftContent({ ...draft, adoptionGate })
    if (!deps.writeFilesAtomic) throw new Error("Draft review receipt requires a verified batch writer")
    await deps.writeFilesAtomic([[path, next]], [originalDraft])
    if (await readExactMarkdown(path, deps) !== next) {
      throw new Error("Could not verify the draft review receipt; run the checks again")
    }
  })
}
