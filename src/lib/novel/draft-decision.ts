import yaml from "js-yaml"
import { createDirectory, fileExists, readFile, writeFile } from "@/commands/fs"
import { statusWrite, type NovelGateStatus, type StatusSchema } from "@/commands/status"
import { parseFrontmatter } from "@/lib/frontmatter"
import { normalizePath } from "@/lib/path-utils"
import { makeChapterFileName, makeDefaultChapterTitle } from "@/lib/wiki-filename"
import { DraftStatus } from "./draft-state-machine"
import { ingestChapter, type IngestResult } from "./chapter-ingest"
import { cleanGeneratedChapterContentForSave } from "./chapter-content-cleanup"
import { findChapterFileByNumber } from "./chapter-utils"
import { loadOrCreateStatusSchema } from "./novel-session-status"
import { resolveReviewModel } from "./review-model"
import { saveDraftArtifact } from "./draft-artifact-store"
import { parseNovelDraftRecord, type NovelDraftRecord } from "./draft-record"

export interface CommitDraftToFormalLayerResult {
  targetPath: string
  markdown: string
  ingestResult: IngestResult
}

export interface AcceptStatusDraftResult {
  schema: StatusSchema
  draft: NovelDraftRecord
  targetPath: string
  ingestResult: IngestResult
}

type ReviewResultSeverity = "error" | "warning" | "info"

export interface DraftDecisionEvidenceSummary {
  blockingGates: string[]
  warningGates: string[]
  reviewResultCounts: Record<ReviewResultSeverity, number>
  allowsFormalWrite: boolean
  notes: string[]
}

function nowIso(): string {
  return new Date().toISOString()
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

function gateStatusAllowsFormalWrite(status?: NovelGateStatus): boolean {
  return status === "passed" || status === "warning"
}

function normalizeReviewResultSeverity(value: unknown): ReviewResultSeverity | null {
  if (!isObjectRecord(value)) return null
  const severity = optionalString(value.severity)
  return severity === "error" || severity === "warning" || severity === "info"
    ? severity
    : null
}

function summarizeReviewResults(reviewResults: unknown[] | undefined): Record<ReviewResultSeverity, number> {
  const counts: Record<ReviewResultSeverity, number> = {
    error: 0,
    warning: 0,
    info: 0,
  }

  for (const result of reviewResults ?? []) {
    const severity = normalizeReviewResultSeverity(result)
    if (severity) counts[severity] += 1
  }

  return counts
}

export function listBlockingDecisionGates(decisionGates: StatusSchema["decision_gates"]): string[] {
  return Object.values(decisionGates)
    .filter((gate) => !gateStatusAllowsFormalWrite(gate.status))
    .map((gate) => gate.gate_type)
}

export function explainFormalWriteDecision(input: {
  draft: NovelDraftRecord | null
  decisionGates: StatusSchema["decision_gates"]
}): DraftDecisionEvidenceSummary {
  const blockingGates = listBlockingDecisionGates(input.decisionGates)
  const warningGates = Object.values(input.decisionGates)
    .filter((gate) => gate.status === "warning")
    .map((gate) => gate.gate_type)
  const reviewResultCounts = summarizeReviewResults(input.draft?.review_results)
  const notes: string[] = []

  if (reviewResultCounts.error > 0 && blockingGates.length === 0) {
    notes.push("review_results contain errors, but decision_gates still allow formal write")
  }
  if (blockingGates.length > 0) {
    notes.push(`formal write remains blocked by decision_gates: ${blockingGates.join(", ")}`)
  }
  if (warningGates.length > 0) {
    notes.push(`warning gates preserved: ${warningGates.join(", ")}`)
  }

  return {
    blockingGates,
    warningGates,
    reviewResultCounts,
    allowsFormalWrite: blockingGates.length === 0,
    notes,
  }
}

function resolveDraftBody(draft: NovelDraftRecord): string {
  return cleanGeneratedChapterContentForSave(draft.final_content ?? draft.draft_content ?? "")
}

function buildFormalChapterMarkdown(input: {
  chapterNumber: number
  title: string
  body: string
  baseMarkdown?: string
}): string {
  const parsed = input.baseMarkdown ? parseFrontmatter(input.baseMarkdown) : null
  const nextFrontmatter: Record<string, unknown> = {
    ...((parsed?.frontmatter as Record<string, unknown> | null) ?? {}),
    type: "chapter",
    chapter_number: input.chapterNumber,
    chapter_status: "final",
    title: input.title,
  }

  if (!optionalString(nextFrontmatter.created)) {
    nextFrontmatter.created = new Date().toISOString().slice(0, 10)
  }

  const yamlPayload = yaml.dump(nextFrontmatter, {
    lineWidth: -1,
    noRefs: true,
    sortKeys: false,
  }).trimEnd()

  return `---\n${yamlPayload}\n---\n\n# ${input.title}\n\n${input.body.trim()}\n`
}

export async function commitDraftToFormalLayer(input: {
  projectPath: string
  chapterNumber: number
  body: string
  title?: string
  targetPath?: string | null
  baseMarkdown?: string
}): Promise<CommitDraftToFormalLayerResult> {
  const projectPath = normalizePath(input.projectPath)
  const chapterDir = `${projectPath}/wiki/chapters`
  await createDirectory(chapterDir).catch(() => {})

  const title = input.title?.trim() || makeDefaultChapterTitle(input.chapterNumber)
  const resolvedExistingPath = input.targetPath
    ? normalizePath(input.targetPath)
    : await findChapterFileByNumber(projectPath, input.chapterNumber)
  const targetPath = resolvedExistingPath ?? `${chapterDir}/${makeChapterFileName(title, input.chapterNumber)}`
  const baseMarkdown = input.baseMarkdown
    ?? (await fileExists(targetPath).catch(() => false)
      ? await readFile(targetPath).catch(() => "")
      : "")

  const markdown = buildFormalChapterMarkdown({
    chapterNumber: input.chapterNumber,
    title,
    body: input.body,
    baseMarkdown,
  })

  await writeFile(targetPath, markdown)
  const ingestResult = await ingestChapter(projectPath, targetPath, resolveReviewModel())

  return {
    targetPath,
    markdown,
    ingestResult,
  }
}

function buildMemorySnapshot(current: unknown, updates: Record<string, unknown>): Record<string, unknown> {
  const base: Record<string, unknown> = isObjectRecord(current) ? current : {}
  return {
    ...base,
    ...updates,
    updated_at: nowIso(),
  }
}

export async function readNovelDraftFromStatus(projectPath: string, conversationId?: string | null): Promise<NovelDraftRecord | null> {
  const schema = await loadOrCreateStatusSchema(normalizePath(projectPath))
  const draft = parseNovelDraftRecord(schema.draft)
  if (!draft) return null
  if (conversationId && draft.conversation_id !== conversationId) return null
  return draft
}

export async function acceptStatusDraft(input: {
  projectPath: string
  conversationId?: string | null
  chapterTitle?: string
}): Promise<AcceptStatusDraftResult> {
  const projectPath = normalizePath(input.projectPath)
  const schema = await loadOrCreateStatusSchema(projectPath)
  const draft = parseNovelDraftRecord(schema.draft)

  if (!draft) {
    throw new Error("当前没有可接受的草稿。")
  }

  if (input.conversationId && draft.conversation_id !== input.conversationId) {
    throw new Error("当前草稿不属于这个会话，已拒绝写入正式层。")
  }

  if (draft.draft_status !== DraftStatus.Ready) {
    throw new Error(`当前草稿状态为 ${draft.draft_status}，不能直接 accept。`)
  }

  const blockingGates = listBlockingDecisionGates(schema.decision_gates)
  if (blockingGates.length > 0) {
    throw new Error(`以下门控尚未通过：${blockingGates.join("、")}。`)
  }

  const chapterNumber = draft.chapter_number
  if (!chapterNumber) {
    throw new Error("草稿缺少章节号，无法写入正式层。")
  }

  const body = resolveDraftBody(draft)
  if (!body.trim()) {
    throw new Error("草稿内容为空，无法写入正式层。")
  }

  const title = input.chapterTitle?.trim() || makeDefaultChapterTitle(chapterNumber)
  const committed = await commitDraftToFormalLayer({
    projectPath,
    chapterNumber,
    body,
    title,
  })

  if (!committed.ingestResult.snapshot) {
    throw new Error(`正式层已写入，但记忆提取失败：${committed.ingestResult.failReason ?? "unknown"}`)
  }

  const acceptedDraft: NovelDraftRecord = {
    ...draft,
    draft_status: DraftStatus.Accepted,
    final_content: body,
    accepted_at: nowIso(),
    rejected_at: undefined,
    formal_chapter_path: committed.targetPath,
    updated_at: nowIso(),
  }

  const nextSchema: StatusSchema = {
    ...schema,
    status: "completed",
    draft: acceptedDraft,
    memory_snapshot: buildMemorySnapshot(schema.memory_snapshot, {
      latest_final_content: body,
      latest_formal_chapter_path: committed.targetPath,
      latest_draft_status: DraftStatus.Accepted,
    }),
    updated_at: nowIso(),
  }

  await statusWrite(projectPath, nextSchema)
  await saveDraftArtifact(projectPath, acceptedDraft)

  return {
    schema: nextSchema,
    draft: acceptedDraft,
    targetPath: committed.targetPath,
    ingestResult: committed.ingestResult,
  }
}

export async function rejectStatusDraft(input: {
  projectPath: string
  conversationId?: string | null
}): Promise<StatusSchema> {
  const projectPath = normalizePath(input.projectPath)
  const schema = await loadOrCreateStatusSchema(projectPath)
  const draft = parseNovelDraftRecord(schema.draft)

  if (!draft) {
    throw new Error("当前没有可拒绝的草稿。")
  }

  if (input.conversationId && draft.conversation_id !== input.conversationId) {
    throw new Error("当前草稿不属于这个会话，不能执行 reject。")
  }

  if (draft.draft_status !== DraftStatus.Ready && draft.draft_status !== DraftStatus.Pending) {
    throw new Error(`当前草稿状态为 ${draft.draft_status}，不能直接 reject。`)
  }

  const nextSchema: StatusSchema = {
    ...schema,
    draft: {
      ...draft,
      draft_status: DraftStatus.Rejected,
      rejected_at: nowIso(),
      accepted_at: undefined,
      updated_at: nowIso(),
    },
    memory_snapshot: buildMemorySnapshot(schema.memory_snapshot, {
      latest_draft_status: DraftStatus.Rejected,
    }),
    updated_at: nowIso(),
  }

  await statusWrite(projectPath, nextSchema)
  const rejectedDraft = parseNovelDraftRecord(nextSchema.draft)
  if (rejectedDraft) {
    await saveDraftArtifact(projectPath, rejectedDraft)
  }
  return nextSchema
}
