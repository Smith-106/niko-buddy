function padChapter(value: number): string {
  return String(value).padStart(3, "0")
}

export function buildNovelTaskId(conversationId: string, chapterNumber?: number): string {
  const trimmedConversationId = conversationId.trim() || "session"
  if (typeof chapterNumber === "number" && Number.isFinite(chapterNumber) && chapterNumber > 0) {
    return `tsk-ch${padChapter(chapterNumber)}-${trimmedConversationId}`
  }
  return `tsk-${trimmedConversationId}`
}
