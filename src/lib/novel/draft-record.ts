import type { NovelDraftStatusPayload } from "@/commands/status"
import { DraftStatus } from "./draft-state-machine"

export interface NovelDraftRecord extends NovelDraftStatusPayload {
  source?: string
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

export function parseNovelDraftRecord(value: unknown): NovelDraftRecord | null {
  if (!isObjectRecord(value)) return null

  const draftId = optionalString(value.draft_id)
  const draftStatus = optionalString(value.draft_status)
  const conversationId = optionalString(value.conversation_id)
  const userRequest = optionalString(value.user_request)

  if (
    !draftId ||
    !conversationId ||
    !userRequest ||
    !draftStatus ||
    !Object.values(DraftStatus).includes(draftStatus as DraftStatus)
  ) {
    return null
  }

  return {
    ...value,
    draft_id: draftId,
    draft_status: draftStatus as DraftStatus,
    conversation_id: conversationId,
    source_task_id: optionalString(value.source_task_id),
    chapter_number: optionalNumber(value.chapter_number),
    user_request: userRequest,
    task_brief: optionalString(value.task_brief),
    draft_content: optionalString(value.draft_content),
    final_content: optionalString(value.final_content),
    review_results: Array.isArray(value.review_results) ? value.review_results : undefined,
    accepted_at: optionalString(value.accepted_at),
    rejected_at: optionalString(value.rejected_at),
    superseded_at: optionalString(value.superseded_at),
    supersedes_draft_id: optionalString(value.supersedes_draft_id),
    formal_chapter_path: optionalString(value.formal_chapter_path),
    updated_at: optionalString(value.updated_at) ?? new Date().toISOString(),
    source: optionalString(value.source),
  }
}
