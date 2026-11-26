export type DraftStatus = "draft" | "confirming" | "saving" | "saved" | "failed"

export type DraftGateStatus = "passed" | "unassessed" | "blocked" | "manual_review" | "partial"
export interface DraftAdoptionGate {
  status: DraftGateStatus
  bodySha256?: string
}

export interface ChapterDraft {
  id: string
  chapterName: string
  content: string
  createdAt: number
  status: DraftStatus
  sourceConversationId?: string
  sourceMessageId?: string
  errorMessage?: string
  /**
   * 截断稿（含 transport 超时截断）：正文可用但不能当完整章。
   * 只影响呈现与提醒，不新增 DraftStatus 取值 —— 采纳与否仍由用户在确认块决定。
   */
  partial?: boolean
  adoptionGate?: DraftAdoptionGate
}

export const DRAFTS_DIR = ".qm-drafts"
